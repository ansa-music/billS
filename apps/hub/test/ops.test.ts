import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { run, transaction } from '../src/db.ts';
import { raiseAlert } from '../src/journal.ts';
import { backupMarkerPath, counters, integrityCheck, readBackupMarker } from '../src/ops.ts';
import { versionInfo } from '../src/version.ts';
import { Harness, post, sessionStatus, tableId, tableState, waitFor } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const HOUR = 60 * 60 * 1000;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

/** Runs `node apps/hub/src/cli.ts …` against the harness database, like backup.sh does. */
function cli(h: Harness, ...args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HUB_DB_PATH: h.dbPath, HUB_GIT_SHA: 'test1234' },
  });
  return { code: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

test('cli backup copies a live database consistently and leaves a marker', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');

  const dir = join(h.dir, 'backups');
  mkdirSync(dir);
  const r = cli(h, 'backup', dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /hub-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/);
  assert.ok(existsSync(r.stdout));

  // The copy is a full database with the running game in it.
  const copy = new DatabaseSync(r.stdout, { readOnly: true });
  const row = copy.prepare('SELECT status FROM table_sessions WHERE id = ?').get(opened.body.id) as { status: string };
  copy.close();
  assert.equal(row.status, 'ACTIVE');

  const marker = readBackupMarker(backupMarkerPath(h.dbPath));
  assert.ok(marker);
  assert.equal(marker.path, r.stdout);
  assert.ok(marker.sizeBytes > 0);

  // The HUB kept working while the copy was taken.
  const again = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);
  assert.equal(again.status, 201);

  // A second backup to the same explicit file name is refused, not overwritten.
  const explicit = join(dir, 'manual.db');
  assert.equal(cli(h, 'backup', explicit).code, 0);
  const dup = cli(h, 'backup', explicit);
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /уже существует/);
});

test('cli check reports a healthy database and fails on a corrupt one', async (t) => {
  const h = harness(t);
  await h.start();
  await h.crash();

  const ok = cli(h, 'check');
  assert.equal(ok.code, 0, ok.stderr);
  const report = JSON.parse(ok.stdout) as ReturnType<typeof integrityCheck>;
  assert.equal(report.ok, true);
  assert.ok(Number.isInteger(report.schemaVersion) && (report.schemaVersion ?? 0) >= 1); // grows with every migration
  assert.equal(report.counts?.tables, 6);

  const corrupt = join(h.dir, 'corrupt.db');
  const bytes = readFileSync(h.dbPath);
  bytes.fill(0xff, 100, 4096); // overwrite the first page past the header
  writeFileSync(corrupt, bytes);
  const bad = cli(h, 'check', corrupt);
  assert.equal(bad.code, 1);
  assert.equal((JSON.parse(bad.stdout) as { ok: boolean }).ok, false);

  const missing = cli(h, 'check', join(h.dir, 'nope.db'));
  assert.equal(missing.code, 1);
});

test('cli restore brings back the games that were in the backup', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');

  const backupDir = join(h.dir, 'backups');
  mkdirSync(backupDir);
  const backup = cli(h, 'backup', backupDir);
  assert.equal(backup.code, 0, backup.stderr);

  // Later the game is stopped and a disaster strikes: the operator wants the earlier state back.
  await post(hub, `/api/sessions/${opened.body.id}/stop`);
  assert.equal(sessionStatus(hub, opened.body.id), 'AWAITING_PAYMENT');
  await h.crash();

  const dryRun = cli(h, 'restore', backup.stdout);
  assert.equal(dryRun.code, 2);
  assert.match(dryRun.stderr, /--yes/);
  const untouched = new DatabaseSync(h.dbPath, { readOnly: true });
  const status = untouched.prepare('SELECT status FROM table_sessions WHERE id = ?').get(opened.body.id) as { status: string };
  untouched.close();
  assert.equal(status.status, 'AWAITING_PAYMENT');

  const restored = cli(h, 'restore', backup.stdout, '--yes');
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stderr, /before-restore/);

  // The HUB starts on the restored file and recovers the game as running.
  const restarted = await h.start();
  await waitFor(() => tableState(restarted, 'Стол 1').lamp.reported === 'ON');
  assert.equal(sessionStatus(restarted, opened.body.id), 'ACTIVE');
  h.clock.advance(HOUR);
  assert.equal(tableState(restarted, 'Стол 1').session?.amount, 2000_00);

  // Restoring from garbage is refused and the database stays untouched.
  const garbage = join(h.dir, 'garbage.db');
  writeFileSync(garbage, 'not a database');
  await h.crash();
  const refused = cli(h, 'restore', garbage, '--yes');
  assert.equal(refused.code, 1);
  assert.equal(integrityCheck(h.dbPath).ok, true);
});

test('cli version prints the package version and git sha', () => {
  const out = execFileSync(process.execPath, [CLI, 'version', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, HUB_GIT_SHA: 'cafe0123' },
  });
  const info = JSON.parse(out) as { version: string; gitSha: string };
  assert.equal(info.version, versionInfo().version);
  assert.equal(info.gitSha, 'cafe0123');
  assert.match(info.version, /^\d+\.\d+\.\d+/);
});

test('/api/health reports version, uptime, database size, disk and the last backup', async (t) => {
  const h = harness(t);
  const hub = await h.start();

  const before = (await hub.app.inject({ method: 'GET', url: '/api/health' })).json() as Record<string, unknown>;
  assert.equal(before.ok, true);
  assert.equal(before.now, h.clock.now());
  assert.equal(before.version, versionInfo().version);
  assert.ok(typeof before.uptimeSeconds === 'number' && before.uptimeSeconds >= 0);
  assert.ok(typeof before.dbSizeBytes === 'number' && before.dbSizeBytes > 0);
  assert.ok(typeof before.freeDiskBytes === 'number' && before.freeDiskBytes > 0);
  assert.ok(Number.isInteger(before.schemaVersion) && (before.schemaVersion as number) >= 1);
  assert.equal(before.lastBackupAt, null);

  const backup = cli(h, 'backup', h.dir + '/');
  assert.equal(backup.code, 0, backup.stderr);
  const after = (await hub.app.inject({ method: 'GET', url: '/api/health' })).json() as Record<string, unknown>;
  assert.equal(after.lastBackupAt, readBackupMarker(backupMarkerPath(h.dbPath))?.at);
  assert.equal(after.lastBackupPath, backup.stdout);
});

test('/metrics exposes games, alerts, lamp queue and outbox in Prometheus format', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  const second = await post(hub, `/api/tables/${tableId(hub, 'Стол 2')}/open`);
  await waitFor(() => sessionStatus(hub, second.body.id) === 'ACTIVE');
  await post(hub, `/api/sessions/${second.body.id}/stop`);
  await waitFor(() => tableState(hub, 'Стол 2').lamp.reported === 'OFF');

  transaction(hub.db, () => {
    raiseAlert(hub.db, h.clock.now(), { kind: 'TEST', tableId: null, sessionId: null, message: 'проверка' });
    // A command the controller has not answered yet.
    run(
      hub.db,
      "INSERT INTO lamp_commands (id, table_id, session_id, action, status, created_at) VALUES ('cmd-test', ?, NULL, 'OFF', 'PENDING', ?)",
      tableId(hub, 'Стол 3'),
      h.clock.now(),
    );
  });

  const res = await hub.app.inject({ method: 'GET', url: '/metrics' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /^text\/plain/);
  const body = res.body;
  const value = (name: string) => {
    const m = body.match(new RegExp(`^${name}(?:\\{[^}]*\\})? (\\S+)$`, 'm'));
    assert.ok(m, `metric ${name} missing in:\n${body}`);
    return Number(m[1]);
  };
  assert.equal(value('bills_hub_up'), 1);
  assert.equal(value('bills_sessions_active'), 1);
  assert.equal(value('bills_sessions_opening'), 0);
  assert.equal(value('bills_sessions_unpaid'), 1);
  assert.equal(value('bills_alerts_open'), 1);
  assert.equal(value('bills_lamp_commands_pending'), 1);
  assert.ok(value('bills_outbox_pending') >= 4, 'open, start, stop and alert events wait for the cloud');
  assert.equal(value('bills_tables_active'), 6);
  assert.equal(value('bills_last_backup_timestamp_seconds'), 0);
  assert.ok(value('bills_db_size_bytes') > 0);
  assert.ok(value('bills_hub_uptime_seconds') >= 0);
  assert.match(body, /^bills_hub_info\{version="\d+\.\d+\.\d+[^"]*",git_sha="[^"]*"\} 1$/m);
  assert.match(body, /^# TYPE bills_sessions_active gauge$/m);

  // The same counters back the CLI `check` output.
  assert.equal(counters(hub.db).sessionsActive, 1);
});
