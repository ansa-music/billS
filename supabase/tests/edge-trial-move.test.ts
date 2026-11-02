import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { TrialMoveFinish, TrialMoveStart, TrialMoveState, TrialStats } from '@bills/domain';
import { cafeCodeHashInput, formatCafeCode, normalizeCafeCode, TRIAL_MOVE, TRIAL_MOVE_RATE, TRIAL_MOVED_MESSAGE } from '@bills/domain';
import { handlePlatform } from '../../apps/cloud/src/edge/platform.ts';
import { handleTrial } from '../../apps/cloud/src/edge/trial.ts';
import type { EdgeTest } from './edge-helpers.ts';
import { edgeTest, HOUR, MONDAY_NOON } from './edge-helpers.ts';
import { newInstallId, platformAuth, startActive, startRequest } from './trial-helpers.ts';

const DAY = 24 * HOUR;
const MINUTE = 60_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const STATS: TrialStats = {
  ordersTotal: 3,
  ordersToday: 3,
  revenueTotal: 4_500,
  revenueToday: 4_500,
  productsCount: 9,
  staffCount: 2,
  shiftOpen: true,
  lastOrderAt: MONDAY_NOON - HOUR,
  days: [{ day: '2026-10-12', orders: 3, revenue: 4_500 }],
};

const sqlite = (tag: string) => Buffer.concat([Buffer.from(`SQLite format 3\0${tag}`), randomBytes(20_000)]);

let ipSeq = 0;
/** A request the platform owner approved at once (an active trial of 14 days from now). */
async function start(e: EdgeTest, venue = 'Кофейня «Утро»', installId = newInstallId()) {
  const s = await startActive(e, { venue, managerName: 'Айгерим', installId }, `198.51.100.${++ipSeq % 250}`);
  return { id: s.id, token: s.token, installId: s.installId, auth: s.auth };
}
type Desk = { id: string; token: string; auth: Record<string, string> };

async function report(e: EdgeTest, d: Desk, extra: Record<string, unknown> = {}, snapshot?: Buffer) {
  return e.call(handleTrial, 'POST', '/trial/report', { headers: d.auth, body: { id: d.id, stats: STATS, ...extra, ...(snapshot ? { snapshot: snapshot.toString('base64') } : {}) } });
}

/** A desk with a café code and a first snapshot. */
async function deskWithCode(e: EdgeTest, venue?: string) {
  const d = await start(e, venue);
  const first = sqlite('first');
  const res = await report(e, d, { needCode: true }, first);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const code = res.body.cafeCode as string;
  assert.ok(normalizeCafeCode(code));
  return { ...d, code, first };
}

const moveStart = (e: EdgeTest, code: unknown, ip = '203.0.113.7') =>
  e.call<TrialMoveStart>(handleTrial, 'POST', '/trial/move/start', { headers: { 'x-forwarded-for': ip }, body: { code } });
const ticketAuth = (ticket: string, ip = '203.0.113.7') => ({ authorization: `Bearer ${ticket}`, 'x-forwarded-for': ip });
const moveState = (e: EdgeTest, ticket: string) => e.call<TrialMoveState>(handleTrial, 'GET', '/trial/move', { headers: ticketAuth(ticket) });
const moveFinish = (e: EdgeTest, ticket: string, body: Record<string, unknown> = {}) =>
  e.call<TrialMoveFinish>(handleTrial, 'POST', '/trial/move/finish', { headers: ticketAuth(ticket), body });

test('café code: issued once on the report that asks for it, kept only as sha256, regenerable', async (t) => {
  const e = await edgeTest(t);
  const d = await start(e);
  // A report that does not ask (an old page) gets the plain terms, as before.
  const plain = await report(e, d);
  assert.deepEqual(plain.body, { status: 'active', endsAt: MONDAY_NOON + 14 * DAY });

  const asked = await report(e, d, { needCode: true });
  assert.equal(asked.status, 200);
  const code = asked.body.cafeCode as string;
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{12}$/, '12 Crockford characters');
  const [row] = await e.s.db.all<{ code_hash: string; code_at: number }>(
    'SELECT code_hash, (extract(epoch FROM code_at) * 1000)::bigint AS code_at FROM trials WHERE id = ?::uuid',
    [d.id],
  );
  assert.equal(row!.code_hash, sha(cafeCodeHashInput(code)));
  assert.equal(row!.code_at, MONDAY_NOON);
  const everything = JSON.stringify(await e.s.db.all('SELECT * FROM trials'));
  assert.ok(!everything.includes(code), 'the code itself is stored nowhere');

  // Asking again does not change it: a desk that lost its code uses «Сменить код».
  const again = await report(e, d, { needCode: true });
  assert.equal(again.body.cafeCode, undefined);

  const other = await start(e);
  assert.equal((await e.call(handleTrial, 'POST', '/trial/code', { headers: other.auth, body: { id: d.id } })).status, 401, 'another trial’s token');
  assert.equal((await e.call(handleTrial, 'POST', '/trial/code', { body: { id: d.id } })).status, 401, 'no token');

  const changed = await e.call(handleTrial, 'POST', '/trial/trial/code', { headers: d.auth, body: { id: d.id } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const fresh = changed.body.cafeCode as string;
  assert.notEqual(fresh, code);
  assert.equal((await moveStart(e, code)).status, 401, 'the old code stops working');
  assert.equal((await moveStart(e, formatCafeCode(fresh).toLowerCase())).status, 201, 'the new one works');

  // At most 10 new codes an hour per trial (the one issued on the report counts).
  for (let i = 2; i < TRIAL_MOVE_RATE.codesPerTrialHour; i++) {
    assert.equal((await e.call(handleTrial, 'POST', '/trial/code', { headers: d.auth, body: { id: d.id } })).status, 200, `code ${i + 1}`);
  }
  const limited = await e.call(handleTrial, 'POST', '/trial/code', { headers: d.auth, body: { id: d.id } });
  assert.equal(limited.status, 429);
  e.clock.now += HOUR + 1;
  assert.equal((await e.call(handleTrial, 'POST', '/trial/code', { headers: d.auth, body: { id: d.id } })).status, 200);
  assert.ok(!e.log.join('\n').includes(fresh), 'codes never reach the log');
});

test('move with a fresh copy: the on-line desk is asked, the new computer waits, then takes over; the old token is told «перенесена»', async (t) => {
  const e = await edgeTest(t);
  const d = await deskWithCode(e);
  e.clock.now += MINUTE; // the desk reported a minute ago: on line

  // Typed on the new computer: lower case, spaces instead of dashes.
  const typed = formatCafeCode(d.code).toLowerCase().replaceAll('-', ' ');
  const started = await moveStart(e, ` ${typed} `);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const ticket = started.body.ticket;
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual({ ...started.body, ticket: 'x' }, {
    ticket: 'x',
    venue: 'Кофейня «Утро»',
    wait: true,
    requestedAt: MONDAY_NOON + MINUTE,
    snapshotAt: MONDAY_NOON,
    lastSeenAt: MONDAY_NOON,
  });
  const [m] = await e.s.db.all<{ token_hash: string }>('SELECT token_hash FROM trial_moves');
  assert.equal(m!.token_hash, sha(ticket), 'the ticket is kept as sha256');

  e.clock.now += 3000;
  const waiting = await moveState(e, ticket);
  assert.equal(waiting.status, 200);
  assert.deepEqual(waiting.body, { venue: 'Кофейня «Утро»', requestedAt: MONDAY_NOON + MINUTE, snapshotAt: MONDAY_NOON, lastSeenAt: MONDAY_NOON, fresh: false, superseded: false });
  const early = await moveFinish(e, ticket);
  assert.equal(early.status, 409, 'never the older copy without the person agreeing');
  assert.equal((early.body as unknown as { error: { code: string } }).error.code, 'MOVE_NOT_FRESH');

  // The desk's next report without a copy is asked for one; with it, the request is answered.
  e.clock.now += 3000;
  const asked = await report(e, d);
  assert.deepEqual(asked.body, { status: 'active', endsAt: MONDAY_NOON + 14 * DAY, sendSnapshot: true });
  const latest = sqlite('latest');
  e.clock.now += 3000;
  const sent = await report(e, d, {}, latest);
  assert.deepEqual(sent.body, { status: 'active', endsAt: MONDAY_NOON + 14 * DAY });
  const [w] = await e.s.db.all<{ wanted: string | null }>('SELECT snapshot_wanted_at AS wanted FROM trials WHERE id = ?::uuid', [d.id]);
  assert.equal(w!.wanted, null);

  const ready = await moveState(e, ticket);
  assert.equal(ready.body.fresh, true);
  assert.equal(ready.body.snapshotAt, MONDAY_NOON + MINUTE + 9000);

  e.clock.now += 1000;
  const done = await moveFinish(e, ticket);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.headers.get('access-control-allow-origin'), '*');
  const f = done.body;
  assert.equal(Buffer.from(f.snapshot, 'base64').equals(latest), true, 'the fresh copy');
  assert.deepEqual({ ...f, snapshot: 'x', token: 'x' }, {
    id: d.id,
    token: 'x',
    venue: 'Кофейня «Утро»',
    managerName: 'Айгерим',
    startedAt: MONDAY_NOON,
    snapshot: 'x',
    snapshotAt: MONDAY_NOON + MINUTE + 9000,
    status: 'active',
    endsAt: MONDAY_NOON + 14 * DAY,
  });
  assert.notEqual(f.token, d.token);
  const [row] = await e.s.db.all<{ token_hash: string; desk_gen: number }>('SELECT token_hash, desk_gen FROM trials WHERE id = ?::uuid', [d.id]);
  assert.deepEqual(row, { token_hash: sha(f.token), desk_gen: 1 });

  // The old cash desk: report and terms answer 410 «Касса перенесена», with or without a copy; nothing is stored.
  const old = await report(e, d, {}, sqlite('offline work'));
  assert.equal(old.status, 410);
  assert.deepEqual(old.body, { error: { code: 'TRIAL_MOVED', message: TRIAL_MOVED_MESSAGE } });
  assert.equal(old.headers.get('access-control-allow-origin'), '*');
  const oldTerms = await e.call(handleTrial, 'GET', `/trial/terms?id=${d.id}`, { headers: d.auth });
  assert.equal(oldTerms.status, 410);
  assert.equal((await e.call(handleTrial, 'POST', '/trial/watch/links', { headers: d.auth, body: { id: d.id } })).status, 401, 'nor anything else');
  assert.equal((await e.call(handleTrial, 'POST', '/trial/code', { headers: d.auth, body: { id: d.id } })).status, 401);
  const snap = await e.s.db.all<{ snapshot: string }>(`SELECT encode(snapshot, 'base64') AS snapshot FROM trials WHERE id = ?::uuid`, [d.id]);
  assert.equal(Buffer.from(snap[0]!.snapshot.replace(/\s+/g, ''), 'base64').equals(latest), true, 'the old desk cannot overwrite the copy');
  // A wrong token stays a wrong token (not «moved»).
  assert.equal((await e.call(handleTrial, 'POST', '/trial/report', { headers: { authorization: 'Bearer nope' }, body: { id: d.id, stats: STATS } })).status, 401);

  // The new cash desk works with the new token; the same café code still moves it on.
  const fresh = await e.call(handleTrial, 'POST', '/trial/report', { headers: { authorization: `Bearer ${f.token}` }, body: { id: d.id, stats: STATS } });
  assert.equal(fresh.status, 200);
  assert.equal((await moveFinish(e, ticket)).status, 410, 'a ticket works once');
  assert.equal((await moveState(e, ticket)).status, 410);
  assert.equal((await moveStart(e, d.code, '203.0.113.99')).status, 201);
  assert.ok(e.log.some((l) => l.includes('перенесена')));
  assert.ok(!e.log.join('\n').includes(d.code) && !e.log.join('\n').includes(ticket), 'no code or ticket in the log');
});

test('move with an older copy: an off-line desk is not waited for; a desk that did not answer needs the person to agree', async (t) => {
  const e = await edgeTest(t);
  const off = await deskWithCode(e, 'Закрытая');
  e.clock.now += HOUR; // last heard from an hour ago
  const s1 = await moveStart(e, off.code);
  assert.equal(s1.status, 201);
  assert.deepEqual({ ...s1.body, ticket: 'x' }, { ticket: 'x', venue: 'Закрытая', wait: false, requestedAt: null, snapshotAt: MONDAY_NOON, lastSeenAt: MONDAY_NOON });
  const [w] = await e.s.db.all<{ wanted: string | null }>('SELECT snapshot_wanted_at AS wanted FROM trials WHERE id = ?::uuid', [off.id]);
  assert.equal(w!.wanted, null, 'nobody to ask');
  const f1 = await moveFinish(e, s1.body.ticket);
  assert.equal(f1.status, 200, JSON.stringify(f1.body));
  assert.equal(f1.body.snapshotAt, MONDAY_NOON, 'the copy of an hour ago, and the computer says so');
  assert.equal(Buffer.from(f1.body.snapshot, 'base64').equals(off.first), true);

  // The old desk comes back on line later with offline work: told «перенесена», its copy refused.
  e.clock.now += DAY;
  const back = await report(e, off, {}, sqlite('done offline'));
  assert.equal(back.status, 410);

  const on = await deskWithCode(e, 'Открытая');
  e.clock.now += MINUTE;
  const s2 = await moveStart(e, on.code, '203.0.113.8');
  assert.equal(s2.body.wait, true);
  e.clock.now += TRIAL_MOVE.waitFreshMs;
  const refused = await e.call(handleTrial, 'POST', '/trial/move/finish', { headers: ticketAuth(s2.body.ticket, '203.0.113.8'), body: {} });
  assert.equal(refused.status, 409);
  const agreed = await e.call(handleTrial, 'POST', '/trial/move/finish', { headers: ticketAuth(s2.body.ticket, '203.0.113.8'), body: { acceptOlder: true } });
  assert.equal(agreed.status, 200, JSON.stringify(agreed.body));
  assert.equal(agreed.body.snapshotAt, MONDAY_NOON + HOUR + DAY, 'the latest copy there is');

  // Nothing to move yet: a trial that never sent a copy.
  const empty = await start(e, 'Пустая');
  const code = (await report(e, empty, { needCode: true })).body.cafeCode as string;
  const s3 = await moveStart(e, code, '203.0.113.9');
  assert.equal(s3.body.snapshotAt, null);
  const none = await e.call(handleTrial, 'POST', '/trial/move/finish', { headers: ticketAuth(s3.body.ticket, '203.0.113.9'), body: { acceptOlder: true } });
  assert.equal(none.status, 404);
  assert.equal(none.body.error.code, 'SNAPSHOT_NOT_FOUND');

  // A ticket expires after 15 minutes.
  const s4 = await moveStart(e, on.code, '203.0.113.10');
  e.clock.now += TRIAL_MOVE.ticketMs + 1;
  const late = await e.call(handleTrial, 'POST', '/trial/move/finish', { headers: ticketAuth(s4.body.ticket, '203.0.113.10'), body: { acceptOlder: true } });
  assert.equal(late.status, 410);
  assert.equal(late.body.error.code, 'MOVE_EXPIRED');
});

test('two moves at once: the first to finish is the cash desk; the other is told to type the code again', async (t) => {
  const e = await edgeTest(t);
  const d = await deskWithCode(e);
  e.clock.now += HOUR;
  const a = await moveStart(e, d.code, '203.0.113.21');
  const b = await moveStart(e, d.code, '203.0.113.22');
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const [fa, fb] = await Promise.all([
    e.call(handleTrial, 'POST', '/trial/move/finish', { headers: ticketAuth(a.body.ticket, '203.0.113.21'), body: {} }),
    e.call(handleTrial, 'POST', '/trial/move/finish', { headers: ticketAuth(b.body.ticket, '203.0.113.22'), body: {} }),
  ]);
  assert.deepEqual([fa.status, fb.status].sort(), [200, 409], 'exactly one wins');
  const [winner, loser, loserTicket, loserIp] = fa.status === 200 ? [fa, fb, b.body.ticket, '203.0.113.22'] : [fb, fa, a.body.ticket, '203.0.113.21'];
  assert.equal(loser.body.error.code, 'MOVE_SUPERSEDED');
  const st = await e.call<TrialMoveState>(handleTrial, 'GET', '/trial/move', { headers: ticketAuth(loserTicket, loserIp) });
  assert.equal(st.body.superseded, true);

  // The loser types the code again: now the winner is the on-line desk that is asked for a fresh copy.
  const again = await moveStart(e, d.code, loserIp);
  assert.equal(again.body.wait, true);
  const winnerDesk = { id: d.id, token: winner.body.token as string, auth: { authorization: `Bearer ${winner.body.token}` } };
  const asked = await report(e, winnerDesk);
  assert.equal(asked.body.sendSnapshot, true);
  e.clock.now += 1000;
  await report(e, winnerDesk, {}, sqlite('winner'));
  const taken = await e.call(handleTrial, 'POST', '/trial/move/finish', { headers: ticketAuth(again.body.ticket, loserIp), body: {} });
  assert.equal(taken.status, 200);
  const [row] = await e.s.db.all<{ desk_gen: number; retired: number }>(
    'SELECT desk_gen, (SELECT COUNT(*) FROM trial_retired_tokens r WHERE r.trial_id = t.id) AS retired FROM trials t WHERE id = ?::uuid',
    [d.id],
  );
  assert.deepEqual(row, { desk_gen: 2, retired: 2 });
  assert.equal((await report(e, winnerDesk)).status, 410, 'the first new computer is now the old one');
  assert.equal((await report(e, d)).status, 410);
});

test('wrong codes: one plain answer, counted per address; rate limits per address and per trial', async (t) => {
  const e = await edgeTest(t);
  const d = await deskWithCode(e);
  const other = await deskWithCode(e, 'Соседи');
  const wrongs: unknown[] = ['K7F3-92QX-M4P8', 'not a code', '', 42, null, d.code.slice(0, 11) + (d.code[11] === '0' ? '1' : '0')];
  const bodies = new Set<string>();
  for (const code of wrongs) {
    const r = await moveStart(e, code, '192.0.2.1');
    assert.equal(r.status, 401, String(code));
    bodies.add(JSON.stringify(r.body));
  }
  assert.equal(bodies.size, 1, 'a malformed and an unknown code look the same');
  assert.equal([...bodies][0]!.includes('CAFE_CODE_WRONG'), true);
  for (let i = wrongs.length; i < TRIAL_MOVE_RATE.wrongCodesPerIpHour; i++) assert.equal((await moveStart(e, 'ZZZZ-ZZZZ-ZZZZ', '192.0.2.1')).status, 401);
  const blocked = await moveStart(e, d.code, '192.0.2.1');
  assert.equal(blocked.status, 429, 'after 10 wrong codes even the right one waits an hour');
  assert.equal((await moveStart(e, d.code, '192.0.2.2')).status, 201, 'another address is not blocked');
  e.clock.now += HOUR + 1;
  assert.equal((await moveStart(e, d.code, '192.0.2.1')).status, 201, 'an hour later');

  // Per trial: 10 moves an hour, whatever the address.
  for (let i = 1; i < TRIAL_MOVE_RATE.startsPerTrialHour; i++) assert.equal((await moveStart(e, d.code, `192.0.2.${10 + i}`)).status, 201);
  assert.equal((await moveStart(e, d.code, '192.0.2.99')).status, 429);
  assert.equal((await moveStart(e, other.code, '192.0.2.99')).status, 201, 'another trial is not blocked');

  // Per address: 30 attempts an hour, right or wrong.
  e.clock.now += HOUR + 1;
  const codes = [other.code];
  for (let i = 0; i < 6; i++) codes.push((await deskWithCode(e, `Кафе ${i}`)).code);
  let n = 0;
  for (const code of codes) {
    for (let k = 0; k < 4 && n < TRIAL_MOVE_RATE.startsPerIpHour; k++, n++) assert.equal((await moveStart(e, code, '192.0.2.200')).status, 201);
  }
  while (n < TRIAL_MOVE_RATE.startsPerIpHour) {
    assert.equal((await moveStart(e, codes[6]!, '192.0.2.200')).status, 201);
    n++;
  }
  assert.equal((await moveStart(e, codes[0]!, '192.0.2.200')).status, 429);

  // Unknown tickets: 30 an hour per address, then 429.
  for (let i = 0; i < TRIAL_MOVE_RATE.badTicketsPerIpHour; i++) {
    const r = await e.call(handleTrial, 'GET', '/trial/move', { headers: ticketAuth(randomBytes(32).toString('base64url'), '192.0.2.250') });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'MOVE_TICKET_INVALID');
  }
  assert.equal((await e.call(handleTrial, 'GET', '/trial/move', { headers: ticketAuth('x'.repeat(43), '192.0.2.250') })).status, 429);
});

test('trial_desk_signal (PostgREST, anon): ok / snapshot / moved / unknown, and a sign of life', async (t) => {
  const e = await edgeTest(t);
  e.clock.now = Date.now(); // the function uses the database clock
  const d = await deskWithCode(e);
  const signal = (id: string, token: string) =>
    e.s.pg.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE anon');
      return (await tx.query<{ s: string }>('SELECT public.trial_desk_signal($1, $2) AS s', [id, token])).rows[0]!.s;
    });
  await e.s.db.run(`UPDATE trials SET last_seen_at = now() - interval '5 minutes' WHERE id = ?::uuid`, [d.id]);
  assert.equal(await signal(d.id, d.token), 'ok');
  const [seen] = await e.s.db.all<{ fresh: boolean }>(`SELECT last_seen_at > now() - interval '1 minute' AS fresh FROM trials WHERE id = ?::uuid`, [d.id]);
  assert.equal(seen!.fresh, true, 'a sign of life');
  assert.equal(await signal(d.id, 'x'.repeat(43)), 'unknown');
  assert.equal(await signal('00000000-0000-0000-0000-000000000000', d.token), 'unknown');
  assert.equal(await signal('not-a-uuid', d.token), 'unknown');
  assert.equal(await signal(d.id, ''), 'unknown');

  e.clock.now = Date.now();
  const s = await moveStart(e, d.code);
  assert.equal(s.body.wait, true);
  assert.equal(await signal(d.id, d.token), 'snapshot', 'a move waits for a fresh copy');
  await report(e, d, {}, sqlite('fresh'));
  assert.equal(await signal(d.id, d.token), 'ok', 'answered');

  const f = await moveFinish(e, s.body.ticket);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(await signal(d.id, d.token), 'moved');
  assert.equal(await signal(d.id, f.body.token), 'ok');
  const other = await start(e);
  assert.equal(await signal(other.id, d.token), 'unknown', 'a retired token says «moved» only for its own trial');

  // anon can call the function but read none of the move tables.
  for (const table of ['trial_moves', 'trial_retired_tokens']) {
    await assert.rejects(
      e.s.pg.transaction(async (tx) => {
        await tx.query('SET LOCAL ROLE anon');
        await tx.query(`SELECT 1 FROM public.${table}`);
      }),
      /permission denied/,
      table,
    );
  }
});

test('requests and statuses: a waiting request gets no café code; a move keeps «permanent»; the old installId cannot take the cash desk back', async (t) => {
  const e = await edgeTest(t);
  // A request waiting for TS: no code on a report, «Получить код» refused.
  const req = await startRequest(e, { venue: 'Ждёт', managerName: 'Аслан' }, '198.51.100.201');
  const asked = await report(e, { id: req.id, token: req.token, auth: req.auth }, { needCode: true, v: 2 });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(asked.body.status, 'pending');
  assert.equal(asked.body.cafeCode, undefined);
  const refused = await e.call(handleTrial, 'POST', '/trial/code', { headers: req.auth, body: { id: req.id } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'TRIAL_NOT_APPROVED');

  // A permanent trial moves as permanent; the new desk is told so in full.
  const installId = newInstallId();
  const d = await start(e, 'Навсегда', installId);
  const made = await e.call(handlePlatform, 'POST', `/platform/trials/${d.id}/permanent`, { headers: await platformAuth(e) });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const first = await report(e, d, { needCode: true, v: 2 }, sqlite('permanent'));
  assert.equal(first.body.status, 'permanent');
  const code = first.body.cafeCode as string;
  assert.ok(normalizeCafeCode(code));
  e.clock.now += HOUR;
  const s = await moveStart(e, code, '203.0.113.150');
  const f = await moveFinish(e, s.body.ticket);
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.equal(f.body.status, 'permanent');
  const moved = { id: d.id, token: f.body.token, auth: { authorization: `Bearer ${f.body.token}` } };
  const terms = await e.call(handleTrial, 'GET', `/trial/terms?id=${d.id}&v=2`, { headers: moved.auth });
  assert.equal(terms.body.status, 'permanent');
  assert.equal((await e.call(handleTrial, 'GET', `/trial/terms?id=${d.id}&v=2`, { headers: d.auth })).status, 410, 'old desk, current page');

  // The old browser's installId no longer finds this trial: /start with it is a new request, the moved desk keeps working.
  const again = await e.call(handleTrial, 'POST', '/trial/start', { headers: { 'x-forwarded-for': '198.51.100.202' }, body: { venue: 'Навсегда', installId } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  assert.notEqual(again.body.id, d.id);
  assert.equal(again.body.status, 'pending');
  assert.equal((await report(e, moved, { v: 2 })).status, 200, 'the new cash desk is still the cash desk');
  const [row] = await e.s.db.all<{ install_hash: string | null }>('SELECT install_hash FROM trials WHERE id = ?::uuid', [d.id]);
  assert.equal(row!.install_hash, null);
});
