import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { generatePassword, slugify } from '../src/admin.ts';
import type { CliIo } from '../src/cli.ts';
import { runCli } from '../src/cli.ts';
import { ManualClock } from '../src/clock.ts';
import { openSqlite } from '../src/db/sqlite.ts';
import { buildApp } from '../src/http/app.ts';
import { MONDAY_NOON, event } from './helpers.ts';

interface Run {
  code: number;
  out: string[];
  err: string[];
  /** `KEY=value` lines of stdout. */
  values: Record<string, string>;
}

interface Env {
  dir: string;
  dbPath: string;
  run(...argv: string[]): Promise<Run>;
}

function tempEnv(t: { after: (fn: () => void) => void }, extraEnv: NodeJS.ProcessEnv = {}): Env {
  const dir = mkdtempSync(join(tmpdir(), 'bills-cloud-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'cloud.db');
  let now = MONDAY_NOON;
  return {
    dir,
    dbPath,
    async run(...argv: string[]): Promise<Run> {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIo = {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        env: { CLOUD_DB_PATH: dbPath, ...extraEnv },
        // Each run one second later, so backup and restore stamps differ.
        now: () => (now += 1000),
      };
      const code = await runCli(argv, io);
      const values: Record<string, string> = {};
      for (const line of out) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line);
        if (m) values[m[1]!] = m[2]!;
      }
      return { code, out, err, values };
    },
  };
}

/** Runs `fn` against a cloud app over the CLI's database file, then closes it (Windows keeps open files locked). */
async function withApp<T>(dbPath: string, fn: (app: ReturnType<typeof buildApp>) => Promise<T>): Promise<T> {
  const db = openSqlite(dbPath);
  const app = buildApp({ db, clock: new ManualClock(MONDAY_NOON + 60_000) });
  await app.ready();
  try {
    return await fn(app);
  } finally {
    await app.close();
    await db.close();
  }
}

async function login(app: ReturnType<typeof buildApp>, email: string, password: string): Promise<number> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  return res.statusCode;
}

function snapshot(hubId: string) {
  return {
    hubId,
    settingsVersion: 0,
    club: { name: 'Клуб', timezone: 'Asia/Almaty', currency: 'KZT' },
    tariffs: [],
    tables: [],
  };
}

test('generated passwords are long and avoid look-alike characters; slugs are latin', () => {
  for (let i = 0; i < 50; i++) {
    const p = generatePassword();
    assert.ok(p.length >= 12);
    assert.doesNotMatch(p, /[0O1lI]/);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[a-z]/);
    assert.match(p, /[0-9]/);
  }
  assert.equal(slugify('Клуб «Север»'), 'klub-sever');
  assert.equal(slugify('Арена Shymkent 2'), 'arena-shymkent-2');
  assert.equal(slugify('«»'), '');
});

test('init creates a company and an owner who can log in; the e-mail must be new', async (t) => {
  const env = tempEnv(t);
  const r = await env.run('init', '--company', 'Сеть «Шар»', '--email', 'Boss@Club.kz', '--name', 'Айдар');
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.ok(r.values.COMPANY_ID);
  assert.equal(r.values.OWNER_EMAIL, 'boss@club.kz');
  const password = r.values.OWNER_PASSWORD;
  assert.ok(password && password.length >= 12);

  await withApp(env.dbPath, async (app) => {
    assert.equal(await login(app, 'boss@club.kz', password), 200);
  });

  const again = await env.run('init', '--company', 'Другая', '--email', 'boss@club.kz');
  assert.equal(again.code, 1);
  assert.match(again.err.join('\n'), /уже есть/);

  const own = await env.run('init', '--company', 'Вторая', '--email', 'two@club.kz', '--password', 'secret-pass-1');
  assert.equal(own.code, 0);
  assert.equal(own.values.OWNER_PASSWORD, undefined);
  await withApp(env.dbPath, async (app) => {
    assert.equal(await login(app, 'two@club.kz', 'secret-pass-1'), 200);
  });

  const short = await env.run('init', '--company', 'Третья', '--email', 'three@club.kz', '--password', 'short');
  assert.equal(short.code, 1);
});

test('add-club needs a company first; its HUB key passes /sync/snapshot and /sync/events', async (t) => {
  const env = tempEnv(t);
  const none = await env.run('add-club', '--name', 'Клуб «Север»');
  assert.equal(none.code, 1);
  assert.match(none.err.join('\n'), /сначала выполните init/);

  assert.equal((await env.run('init', '--company', 'Сеть', '--email', 'a@b.kz')).code, 0);
  const badTz = await env.run('add-club', '--name', 'X', '--tz', 'Mars/Base');
  assert.equal(badTz.code, 1);
  assert.match(badTz.err.join('\n'), /часовой пояс/);

  const r = await env.run('add-club', '--name', 'Клуб «Север»', '--tz', 'Asia/Aqtobe');
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.ok(r.values.CLUB_ID);
  assert.equal(r.values.HUB_ID, 'hub-klub-sever');
  const key = r.values.CLOUD_API_KEY!;
  assert.equal(Buffer.from(key, 'base64url').length, 32);

  // A second club with the same name gets a distinct HUB id.
  const twin = await env.run('add-club', '--name', 'Клуб «Север»');
  assert.equal(twin.code, 0);
  assert.notEqual(twin.values.HUB_ID, r.values.HUB_ID);
  assert.match(twin.values.HUB_ID!, /^hub-klub-sever-/);

  await withApp(env.dbPath, async (app) => {
    const auth = { authorization: `Bearer ${key}` };
    const snap = await app.inject({ method: 'POST', url: '/sync/snapshot', headers: auth, payload: snapshot('hub-klub-sever') });
    assert.equal(snap.statusCode, 200, snap.body);
    assert.equal(snap.json().accepted, true);
    const events = await app.inject({
      method: 'POST',
      url: '/sync/events',
      headers: auth,
      payload: { hubId: 'hub-klub-sever', settingsVersion: 0, events: [event(1, MONDAY_NOON, 'table.renamed', 't1')] },
    });
    assert.equal(events.statusCode, 200, events.body);
    assert.equal(events.json().inserted, 1);
  });

  const list = await env.run('list');
  assert.equal(list.code, 0);
  const text = list.out.join('\n');
  assert.match(text, /a@b\.kz/);
  assert.match(text, /пояс=Asia\/Aqtobe/);
  assert.match(text, /HUB hub-klub-sever {2}последний контакт: 2026-/);

  const json = await env.run('list', '--json');
  const parsed = JSON.parse(json.out.join('\n')) as Array<{ clubs: unknown[] }>;
  assert.equal(parsed[0]?.clubs.length, 2);
});

test('add-club asks for --company when there are several', async (t) => {
  const env = tempEnv(t);
  const first = await env.run('init', '--company', 'Первая', '--email', 'a@b.kz');
  assert.equal((await env.run('init', '--company', 'Вторая', '--email', 'c@d.kz')).code, 0);
  const ambiguous = await env.run('add-club', '--name', 'Клуб');
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.err.join('\n'), /--company/);
  const ok = await env.run('add-club', '--name', 'Клуб', '--company', first.values.COMPANY_ID!);
  assert.equal(ok.code, 0);
  const missing = await env.run('add-club', '--name', 'Клуб', '--company', 'nope');
  assert.equal(missing.code, 1);
});

test('new-hub-key replaces the key: the old one gets 401', async (t) => {
  const env = tempEnv(t);
  await env.run('init', '--company', 'Сеть', '--email', 'a@b.kz');
  const club = await env.run('add-club', '--name', 'Arena');
  const hubId = club.values.HUB_ID!;
  const oldKey = club.values.CLOUD_API_KEY!;

  const r = await env.run('new-hub-key', '--hub', hubId);
  assert.equal(r.code, 0);
  const newKey = r.values.CLOUD_API_KEY!;
  assert.notEqual(newKey, oldKey);

  await withApp(env.dbPath, async (app) => {
    const send = (key: string) =>
      app.inject({
        method: 'POST',
        url: '/sync/events',
        headers: { authorization: `Bearer ${key}` },
        payload: { hubId, settingsVersion: 0, events: [] },
      });
    assert.equal((await send(oldKey)).statusCode, 401);
    assert.equal((await send(newKey)).statusCode, 200);
  });

  assert.equal((await env.run('new-hub-key', '--hub', 'hub-nope')).code, 1);
  assert.equal((await env.run('new-hub-key')).code, 2);
});

test('reset-password changes the password and ends the owner sessions', async (t) => {
  const env = tempEnv(t);
  const init = await env.run('init', '--company', 'Сеть', '--email', 'a@b.kz');
  const oldPassword = init.values.OWNER_PASSWORD!;
  await withApp(env.dbPath, async (app) => {
    assert.equal(await login(app, 'a@b.kz', oldPassword), 200);
  });

  const r = await env.run('reset-password', '--email', 'A@B.kz');
  assert.equal(r.code, 0, r.err.join('\n'));
  const newPassword = r.values.OWNER_PASSWORD!;
  assert.match(r.out.join('\n'), /завершено сессий: 1/);

  await withApp(env.dbPath, async (app) => {
    assert.equal(await login(app, 'a@b.kz', oldPassword), 401);
    assert.equal(await login(app, 'a@b.kz', newPassword), 200);
  });

  const own = await env.run('reset-password', '--email', 'a@b.kz', '--password', 'another-pass');
  assert.equal(own.code, 0);
  assert.equal(own.values.OWNER_PASSWORD, undefined);
  assert.equal((await env.run('reset-password', '--email', 'nobody@b.kz')).code, 1);
});

test('backup, check and restore round-trip through a folder', async (t) => {
  const env = tempEnv(t);
  await env.run('init', '--company', 'Сеть', '--email', 'a@b.kz');
  await env.run('add-club', '--name', 'Before');

  const backupDir = join(env.dir, 'backups');
  const b = await env.run('backup', backupDir + '/');
  assert.equal(b.code, 0, b.err.join('\n'));
  const copy = b.out.at(-1)!;
  assert.match(basename(copy), /^cloud-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/);
  assert.ok(existsSync(copy));

  const check = await env.run('check', copy);
  assert.equal(check.code, 0);
  assert.equal(check.values.COMPANIES, '1');
  assert.equal(check.values.CLUBS, '1');
  assert.equal(check.values.EVENTS, '0');
  assert.equal((await env.run('check')).code, 0);

  await env.run('add-club', '--name', 'After');
  assert.match((await env.run('list')).out.join('\n'), /After/);

  const refused = await env.run('restore', copy);
  assert.equal(refused.code, 2);
  assert.match(refused.err.join('\n'), /--yes/);

  const r = await env.run('restore', copy, '--yes');
  assert.equal(r.code, 0, r.err.join('\n'));
  assert.equal(r.out.at(-1), env.dbPath);
  const kept = readdirSync(env.dir).filter((f) => f.startsWith('cloud.db.before-restore-'));
  assert.ok(kept.some((f) => /^cloud\.db\.before-restore-[\d_-]+$/.test(f)), `kept: ${kept.join(', ')}`);
  assert.ok(!existsSync(`${env.dbPath}-wal`));

  const list = (await env.run('list')).out.join('\n');
  assert.match(list, /Before/);
  assert.doesNotMatch(list, /After/);

  assert.equal((await env.run('restore', join(env.dir, 'missing.db'), '--yes')).code, 1);
  assert.equal((await env.run('check', join(env.dir, 'missing.db'))).code, 1);
  assert.equal((await env.run('backup')).code, 2);
});

test('file commands refuse PostgreSQL; usage errors exit with 2', async (t) => {
  const pg = tempEnv(t, { CLOUD_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none' });
  for (const argv of [['backup', pg.dir], ['restore', 'x.db', '--yes'], ['check']]) {
    const r = await pg.run(...argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err.join('\n'), /pg_dump/);
  }

  const env = tempEnv(t);
  assert.equal((await env.run()).code, 2);
  assert.equal((await env.run('bogus')).code, 2);
  assert.equal((await env.run('init', '--email', 'a@b.kz')).code, 2);
  assert.equal((await env.run('init', '--company', 'X', '--email', 'a@b.kz', '--unknown')).code, 2);
  const v = await env.run('version');
  assert.equal(v.code, 0);
  assert.match(v.out[0]!, /^TS облако \d+\.\d+\.\d+/);
});
