/**
 * Moving a trial café in (importer.ts) and «Скачать копию» out (exporter.ts) on a stand-in for Durable Object
 * storage: a real trial database made by the HUB's own code goes in step by step, comes out as the browser
 * trial's backup file, and both copies hold exactly the café's rows.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync as NodeDb } from 'node:sqlite';
import { after, test } from 'node:test';
import initSqlJs from 'sql.js';
import { ManualClock } from '../../hub/src/clock.ts';
import { openDb } from '../../hub/src/db.ts';
import { Hub } from '../../hub/src/hub.ts';
import { SimulatorLampDriver } from '../../hub/src/lamps/simulator.ts';
import { setupTrialClub } from '../../hub/src/trial.ts';
import { Exporter, toBase64 } from '../src/exporter.ts';
import { fromBase64 } from '../src/importer.ts';
import type { ImportState } from '../src/importer.ts';
import { importOptionsOf, importProgress, Importer, PART_CHARS, splitImportBody } from '../src/importer.ts';
import { FakeStorage } from './fake-storage.ts';

const dir = mkdtempSync(join(tmpdir(), 'cloud-hub-move-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const NEWEST = 999;
const loadSqlJs = () => initSqlJs();
const DAY = 24 * 3600_000;

/** A trial coffee shop as the browser trial keeps it: menu, shifts, paid orders, a refund, a deposit. */
function trialSnapshot(name: string, days: number, perDay: number): Buffer {
  const start = Date.UTC(2026, 9, 1, 3, 0);
  const clock = new ManualClock(start);
  const file = join(dir, `${name}.db`);
  const db = openDb(file, start);
  const hub = new Hub({ db, clock, lampDriver: new SimulatorLampDriver({ latencyMs: 0 }), guardIntervalMs: 0 });
  setupTrialClub(hub, { venue: 'Кофейня «Тюльпан»', managerName: 'Мадина', key: '583104', timezone: 'Asia/Almaty', withMenu: true, now: start });
  const products = hub.bar.catalog().products.filter((p) => p.isActive && p.stock === null);
  for (let day = 0; day < days; day++) {
    clock.set(start + day * DAY);
    const shift = hub.shifts.open({ openingFloat: 2_000_00, actor: 'Мадина' });
    let cash = 2_000_00;
    for (let i = 0; i < perDay; i++) {
      clock.advance(7 * 60_000);
      const p = products[(day * perDay + i) % products.length]!;
      const required = p.options.filter((g) => g.required && g.choices.length);
      const price = p.price + required.reduce((n, g) => n + g.choices[0]!.priceDelta, 0);
      const method = i % 3 ? 'CARD' : 'CASH';
      const res = hub.counter.create({
        items: [{ productId: p.id, qty: 1, ...(required.length ? { options: required.map((g) => g.choices[0]!.id) } : {}) }],
        service: i % 2 ? 'HERE' : 'TAKEAWAY',
        guestName: 'Аня',
        payment: { parts: [{ method, amount: price }] },
        actor: 'Мадина',
      }) as unknown as { order: { id: string; checkId: string } };
      for (const stage of ['PREPARING', 'READY', 'ISSUED'] as const) hub.counter.stage({ orderId: res.order.id, stage, actor: 'Мадина' });
      if (method === 'CASH') cash += price;
      if (i === 1) hub.checks.refund({ checkId: res.order.checkId, method: 'CARD', amount: price, reason: 'Пролил', approvedBy: 'Мадина', actor: 'Мадина' });
    }
    hub.shifts.moveCash({ shiftId: shift.id, kind: 'DEPOSIT', amount: 500_00, reason: 'Размен', actor: 'Мадина' });
    if (day < days - 1) hub.shifts.close({ shiftId: shift.id, countedCash: cash + 500_00, actor: 'Мадина' });
  }
  const out = join(dir, `${name}.snapshot.db`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  hub.close();
  db.close();
  return readFileSync(out);
}

function cafeTables(db: NodeDb): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'ts_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function rowsOf(db: NodeDb, table: string): unknown[] {
  return db.prepare(`SELECT rowid AS __r, * FROM "${table}" ORDER BY rowid`).all().map((r) => JSON.stringify(r));
}

async function moveIn(storage: FakeStorage, body: string, options: { newImporterEvery?: number } = {}) {
  let importer = new Importer(storage, loadSqlJs, NEWEST);
  const t0 = performance.now();
  const { base64, rest } = splitImportBody(new TextEncoder().encode(body));
  let state: ImportState = importer.upload(base64, importOptionsOf(rest), Date.now(), 'move-1');
  const times: Array<{ phase: string; ms: number }> = [{ phase: 'upload', ms: performance.now() - t0 }];
  let n = 0;
  while (state.phase !== 'done' && state.phase !== 'failed') {
    // The café's object restarted (deploy, eviction): a new importer goes on from the stored state.
    if (options.newImporterEvery && ++n % options.newImporterEvery === 0) importer = new Importer(storage, loadSqlJs, NEWEST);
    const phase = state.phase;
    const t0 = performance.now();
    state = await importer.step();
    times.push({ phase, ms: performance.now() - t0 });
    assert.ok(times.length < 5000, 'the move ends');
  }
  return { importer, state, times };
}

test('a trial café moves in step by step: every row (rowids too) but the outbox and old retries', async (t) => {
  const bytes = trialSnapshot('small', 3, 12);
  const storage = new FakeStorage();
  const body = JSON.stringify({ snapshot: bytes.toString('base64'), newManagerKey: true, terms: { status: 'permanent', endsAt: null } });
  const { state, times, importer } = await moveIn(storage, body, { newImporterEvery: 7 });
  assert.equal(state.phase, 'done', state.error ?? '');
  assert.equal(state.venue, 'Кофейня «Тюльпан»');
  assert.deepEqual(state.options, { newManagerKey: true, terms: { status: 'permanent', endsAt: null } });
  assert.equal(importProgress(state).status, 'importing', 'the copy is done, the café opens in one more step');
  const source = new NodeDb(join(dir, 'small.snapshot.db'));
  assert.deepEqual(cafeTables(storage.db), cafeTables(source));
  for (const table of cafeTables(source)) {
    if (table === 'outbox' || table === 'idempotency_keys') {
      assert.equal(rowsOf(storage.db, table).length, 0, table);
      continue;
    }
    assert.deepEqual(rowsOf(storage.db, table), rowsOf(source, table), table);
  }
  // Indexes came along; AUTOINCREMENT goes on after the copied ids.
  const indexes = (db: NodeDb) => db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").get()!.n;
  assert.equal(indexes(storage.db), indexes(source));
  const seq = (db: NodeDb) => db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'").get()?.seq;
  assert.equal(seq(storage.db), seq(source));
  assert.equal(storage.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  source.close();
  // One more step after the end changes nothing; clear() removes the parts and the state.
  assert.equal((await importer.step()).phase, 'done');
  importer.clear();
  assert.equal(storage.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'ts_import%'").get()!.n, 0);
  t.diagnostic(`small café ${bytes.length} B: ${times.length} steps, rows ${state.rows}`);
});

test('a snapshot that is not a TS café, or is from a newer TS, fails with the reason and copies nothing more', async () => {
  const notBase64 = new FakeStorage();
  const imp = new Importer(notBase64, loadSqlJs, NEWEST);
  imp.upload(new TextEncoder().encode('@@@@'), {}, 0, 'x');
  assert.equal((await imp.step()).phase, 'failed');
  assert.match(imp.state()!.error!, /base64/);

  const notSqlite = await moveIn(new FakeStorage(), JSON.stringify({ snapshot: Buffer.from('hello, this is not a database at all, but long enough to look like one maybe').toString('base64') }));
  assert.equal(notSqlite.state.phase, 'failed');
  assert.match(notSqlite.state.error!, /не база SQLite/);

  const plain = new NodeDb(join(dir, 'plain.db'));
  plain.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT); INSERT INTO notes (text) VALUES (1)');
  plain.close();
  const foreign = await moveIn(new FakeStorage(), JSON.stringify({ snapshot: readFileSync(join(dir, 'plain.db')).toString('base64') }));
  assert.equal(foreign.state.phase, 'failed');
  assert.match(foreign.state.error!, /не копия кофейни TS/);

  const newer = new FakeStorage();
  const bytes = trialSnapshot('newer', 1, 2);
  const imp2 = new Importer(newer, loadSqlJs, 3);
  let s = imp2.upload(new TextEncoder().encode(bytes.toString('base64')), {}, 0, 'n');
  while (s.phase !== 'done' && s.phase !== 'failed') s = await imp2.step();
  assert.equal(s.phase, 'failed');
  assert.match(s.error!, /более новой версией/);
});

test('the body: base64 is cut out without parsing it as JSON; escapes and bad bodies', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const big = 'QUJD'.repeat(10);
  // A Cyrillic field before the snapshot: byte offsets, not character offsets.
  const { base64, rest } = splitImportBody(enc(`{"managerName":"Мадина","newManagerKey":true, "snapshot" : "${big}","x":"ё"}`));
  assert.equal(dec(base64), big);
  assert.deepEqual(rest, { managerName: 'Мадина', newManagerKey: true, snapshot: null, x: 'ё' });
  assert.equal(dec(splitImportBody(enc('{"snapshot":"QU\\/D"}')).base64), 'QU/D');
  assert.throws(() => splitImportBody(enc('{"x":1}')), /snapshot/);
  assert.throws(() => splitImportBody(enc('{"snapshot":"QUJD"')), /JSON/);
  assert.throws(() => splitImportBody(enc('{"snapshot":"Q"}')), /base64/);
  assert.equal(PART_CHARS % 4, 0);
});

test('«Скачать копию»: the browser trial’s backup file, step by step, with exactly the café’s rows', async (t) => {
  const bytes = trialSnapshot('export', 2, 10);
  const storage = new FakeStorage();
  const moved = await moveIn(storage, JSON.stringify({ snapshot: bytes.toString('base64') }));
  moved.importer.clear();
  const exporter = new Exporter(storage, loadSqlJs);
  const head = () => ({ startedAt: 1, venue: 'Кофейня «Тюльпан»', managerName: 'Мадина', status: 'active' as const, endsAt: 2_000_000_000_000, message: null });
  await loadSqlJs();
  const t0 = performance.now();
  let p = await exporter.step(1000, head, { fresh: true, maxAgeMs: 60_000, id: 'e1' });
  let steps = 1;
  const times: number[] = [performance.now() - t0];
  while (p.status !== 'ready') {
    const t1 = performance.now();
    p = await exporter.step(1000, head, { fresh: false, maxAgeMs: 60_000, id: 'e1' });
    times.push(performance.now() - t1);
    steps++;
    assert.ok(steps < 1000);
  }
  assert.ok(!exporter.busy);
  const file = exporter.file()!;
  assert.match(file.name, /^TS-kofeynya-tyulpan-\d{4}-\d{2}-\d{2}\.ts-backup\.json$/);
  const text = await new Response(file.body).text();
  assert.equal(new TextEncoder().encode(text).length, file.bytes);
  const backup = JSON.parse(text) as Record<string, unknown>;
  assert.equal(backup.format, 'ts-trial-backup');
  assert.equal(backup.version, 1);
  assert.equal(backup.venue, 'Кофейня «Тюльпан»');
  assert.equal(backup.managerKey, '');
  assert.equal(backup.status, 'active');
  assert.equal(backup.endsAt, 2_000_000_000_000);
  const restored = join(dir, 'restored.db');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(restored, Buffer.from(String(backup.db), 'base64'));
  const copy = new NodeDb(restored);
  assert.deepEqual(cafeTables(copy), cafeTables(storage.db));
  for (const table of cafeTables(copy)) assert.deepEqual(rowsOf(copy, table), rowsOf(storage.db, table), table);
  copy.close();
  // A recent copy is handed out again; `fresh` makes a new one.
  assert.equal((await exporter.step(2000, head, { fresh: false, maxAgeMs: 60_000, id: 'e2' })).id, 'e1');
  assert.equal((await exporter.step(2000, head, { fresh: true, maxAgeMs: 60_000, id: 'e3' })).status, 'preparing');
  t.diagnostic(`export: ${steps} steps (start ${times[0]!.toFixed(1)} ms), avg ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)} ms, slowest ${Math.max(...times).toFixed(1)} ms`);
});

test('a busier café: no step reads or writes more than its budget (CPU per step, measured in Node)', async (t) => {
  const bytes = trialSnapshot('busy', 5, 60);
  const storage = new FakeStorage();
  const { state, times } = await moveIn(storage, JSON.stringify({ snapshot: bytes.toString('base64') }));
  assert.equal(state.phase, 'done', state.error ?? '');
  const byPhase = new Map<string, number[]>();
  for (const s of times) byPhase.set(s.phase, [...(byPhase.get(s.phase) ?? []), s.ms]);
  // …and its «Скачать копию».
  const exporter = new Exporter(storage, loadSqlJs);
  const head = () => ({ startedAt: 1, venue: 'Кофейня', managerName: 'Мадина', status: 'permanent' as const, endsAt: null, message: null });
  let p = await exporter.step(1, head, { fresh: true, maxAgeMs: 0, id: 'b' });
  while (p.status !== 'ready') {
    const phase = `export ${p.phase}`;
    const t0 = performance.now();
    p = await exporter.step(1, head, { fresh: false, maxAgeMs: 0, id: 'b' });
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), performance.now() - t0]);
  }
  const line = [...byPhase]
    .map(([phase, ms]) => `${phase} ×${ms.length} avg ${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)} max ${Math.max(...ms).toFixed(1)} ms`)
    .join(', ');
  t.diagnostic(`busy café ${(bytes.length / 1024).toFixed(0)} KiB, ${state.totalRows} rows: ${line}`);
});

test('the SQLite file itself (no base64) moves in the same way, starting at `open`', async () => {
  const bytes = trialSnapshot('raw', 1, 6);
  const storage = new FakeStorage();
  const importer = new Importer(storage, loadSqlJs, NEWEST);
  let state = importer.uploadRaw(new Uint8Array(bytes), { newManagerKey: true }, 0, 'raw');
  assert.equal(state.phase, 'open');
  while (state.phase !== 'done' && state.phase !== 'failed') state = await importer.step();
  assert.equal(state.phase, 'done', state.error ?? '');
  const source = new NodeDb(join(dir, 'raw.snapshot.db'));
  assert.deepEqual(rowsOf(storage.db, 'payments'), rowsOf(source, 'payments'));
  source.close();
  assert.throws(() => importer.uploadRaw(new TextEncoder().encode('not sqlite'.repeat(20)), {}, 0, 'x'), /не база SQLite/);
});

test('base64 both ways is exactly the standard one (the engines without Uint8Array.toBase64/fromBase64)', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = new Uint8Array(n * 7 + (n % 3)).map((_, i) => (i * 131 + n * 17) & 255);
    const b64 = Buffer.from(bytes).toString('base64');
    assert.equal(toBase64(bytes), b64);
    assert.deepEqual([...fromBase64(new TextEncoder().encode(b64))], [...bytes]);
  }
});
