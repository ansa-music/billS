import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { all } from '../src/db.ts';
import type { PowerActions } from '../src/power/monitor.ts';
import {
  ApcupsdUps,
  createUpsSource,
  decodeNisFrames,
  encodeNisFrame,
  NutUps,
  parseApcupsdStatus,
  parseNutVars,
  parseUpsUrl,
  readingFromApcupsd,
  readingFromNut,
  SimulatorUps,
  UpsConfigError,
} from '../src/power/ups.ts';
import { auditActions, Harness, MONDAY_NOON, post, sessionStatus, tableId, waitFor } from './helpers.ts';

const never = () => new AbortController().signal;

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

// ── Configuration ────────────────────────────────────────────────────────────

test('HUB_UPS is parsed into a source or rejected with a readable reason', () => {
  assert.equal(parseUpsUrl(undefined), null);
  assert.equal(parseUpsUrl(''), null);
  assert.equal(parseUpsUrl('off'), null);
  assert.deepEqual(parseUpsUrl('simulator'), { kind: 'simulator' });
  assert.deepEqual(parseUpsUrl('nut://192.168.1.2/ups'), { kind: 'nut', host: '192.168.1.2', port: 3493, ups: 'ups' });
  assert.deepEqual(parseUpsUrl('nut://ups-host:3494/eaton1'), { kind: 'nut', host: 'ups-host', port: 3494, ups: 'eaton1' });
  assert.deepEqual(parseUpsUrl('apcupsd://192.168.1.2'), { kind: 'apcupsd', host: '192.168.1.2', port: 3551 });
  assert.deepEqual(parseUpsUrl('apcupsd://10.0.0.5:3552'), { kind: 'apcupsd', host: '10.0.0.5', port: 3552 });
  for (const bad of ['nut://192.168.1.2', 'nut://192.168.1.2/', 'nut:///ups', 'apcupsd://host/x', 'snmp://host', 'nut://host:99999/ups']) {
    assert.throws(() => parseUpsUrl(bad), UpsConfigError, bad);
  }
  assert.equal(createUpsSource({ kind: 'nut', host: 'h', port: 3493, ups: 'u' }).label, 'nut://h:3493/u');
  assert.equal(createUpsSource({ kind: 'apcupsd', host: 'h', port: 3551 }).label, 'apcupsd://h:3551');
});

// ── Protocol parsing ─────────────────────────────────────────────────────────

test('NUT LIST VAR answers are parsed, status words decide on-battery', () => {
  const vars = parseNutVars(
    'BEGIN LIST VAR ups\nVAR ups ups.status "OB DISCHRG"\nVAR ups battery.charge "63"\nVAR ups battery.runtime "1260"\nVAR ups ups.model "Eaton 5E \\"650\\""\nEND LIST VAR ups\n',
  );
  assert.deepEqual(readingFromNut(vars), {
    onBattery: true,
    chargePercent: 63,
    runtimeSeconds: 1260,
    status: 'OB DISCHRG',
    model: 'Eaton 5E "650"',
  });
  assert.equal(readingFromNut(parseNutVars('VAR ups ups.status "OL CHRG"\n')).onBattery, false);
  assert.equal(readingFromNut(parseNutVars('VAR ups ups.status "OL LB"\n')).onBattery, false, 'OL wins: low battery while charging');
  assert.equal(readingFromNut(parseNutVars('VAR ups ups.status "LB"\n')).onBattery, true);
  assert.deepEqual(readingFromNut(parseNutVars('VAR ups ups.status "OL"\n')).chargePercent, null);
  assert.throws(() => parseNutVars('ERR UNKNOWN-UPS\n'), /UNKNOWN-UPS/);
  assert.throws(() => readingFromNut(parseNutVars('VAR ups battery.charge "50"\n')), /ups.status/);
});

test('apcupsd NIS frames are encoded and decoded, status lines parsed', () => {
  assert.deepEqual([...encodeNisFrame('status')], [0, 6, ...Buffer.from('status')]);
  const stream = Buffer.concat([encodeNisFrame('STATUS   : ONBATT \n'), encodeNisFrame('BCHARGE  : 42.0 Percent\n')]);
  const partial = decodeNisFrames(stream.subarray(0, stream.length - 3));
  assert.deepEqual(partial, { lines: ['STATUS   : ONBATT '], complete: false });
  const full = decodeNisFrames(Buffer.concat([stream, encodeNisFrame('TIMELEFT : 12.5 Minutes\n'), Buffer.from([0, 0])]));
  assert.equal(full.complete, true);
  const vars = parseApcupsdStatus(full.lines);
  assert.deepEqual(readingFromApcupsd(vars), { onBattery: true, chargePercent: 42, runtimeSeconds: 750, status: 'ONBATT', model: null });
  assert.equal(readingFromApcupsd(parseApcupsdStatus(['STATUS   : ONLINE', 'MODEL    : Back-UPS 700'])).model, 'Back-UPS 700');
  assert.equal(readingFromApcupsd(parseApcupsdStatus(['STATUS   : ONLINE LOWBATT'])).onBattery, false);
  assert.equal(readingFromApcupsd(parseApcupsdStatus(['STATUS   : ONBATT LOWBATT', 'TIMELEFT : 90 Seconds'])).runtimeSeconds, 90);
  assert.throws(() => readingFromApcupsd(parseApcupsdStatus(['STATUS   : COMMLOST'])), /COMMLOST/);
});

// ── Fake daemons on node:net ─────────────────────────────────────────────────

class FakeDaemon {
  readonly requests: string[] = [];
  /** Next connections: accept but never answer. */
  silent = 0;
  connections = 0;
  #server: Server | undefined;
  #sockets = new Set<Socket>();
  readonly #answer: (request: Buffer, socket: Socket) => void;

  constructor(answer: (request: Buffer, socket: Socket) => void) {
    this.#answer = answer;
  }

  async listen(): Promise<{ host: string; port: number }> {
    this.#server = createServer((socket) => {
      this.connections++;
      this.#sockets.add(socket);
      socket.once('close', () => this.#sockets.delete(socket));
      socket.on('data', (chunk: Buffer) => {
        this.requests.push(chunk.toString('utf8'));
        if (this.silent > 0) {
          this.silent--;
          return;
        }
        this.#answer(chunk, socket);
      });
    });
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    return { host: '127.0.0.1', port: (this.#server!.address() as AddressInfo).port };
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((r) => this.#server?.close(() => r()));
  }
}

function nutDaemon(vars: Record<string, string>, upsName = 'ups'): FakeDaemon {
  return new FakeDaemon((req, socket) => {
    const m = /^LIST VAR (\S+)\n$/.exec(req.toString('utf8'));
    if (!m || m[1] !== upsName) {
      socket.write('ERR UNKNOWN-UPS\n');
      return;
    }
    // Answer in two TCP chunks like a real upsd under load.
    const lines = Object.entries(vars).map(([k, v]) => `VAR ${upsName} ${k} "${v}"\n`);
    socket.write(`BEGIN LIST VAR ${upsName}\n${lines.slice(0, 1).join('')}`);
    setTimeout(() => socket.write(`${lines.slice(1).join('')}END LIST VAR ${upsName}\n`), 5);
  });
}

function apcupsdDaemon(lines: string[]): FakeDaemon {
  return new FakeDaemon((req, socket) => {
    const { lines: got } = decodeNisFrames(req);
    if (got[0] !== 'status') {
      socket.destroy();
      return;
    }
    for (const l of lines) socket.write(encodeNisFrame(`${l}\n`));
    socket.write(Buffer.from([0, 0]));
  });
}

test('the NUT client reads a real upsd conversation over TCP', async (t) => {
  const daemon = nutDaemon({ 'ups.status': 'OL CHRG', 'battery.charge': '98', 'battery.runtime': '2400', 'ups.model': 'Eaton 5E' });
  t.after(() => daemon.close());
  const { host, port } = await daemon.listen();
  const ups = new NutUps(host, port, 'ups');
  assert.deepEqual(await ups.read(never()), { onBattery: false, chargePercent: 98, runtimeSeconds: 2400, status: 'OL CHRG', model: 'Eaton 5E' });
  assert.deepEqual(daemon.requests, ['LIST VAR ups\n']);

  await assert.rejects(new NutUps(host, port, 'other').read(never()), /UNKNOWN-UPS/);

  daemon.silent = 1;
  const controller = new AbortController();
  const pending = ups.read(controller.signal);
  setTimeout(() => controller.abort(new Error('No UPS answer within 50 ms')), 50);
  await assert.rejects(pending, /within 50 ms/);
  assert.equal((await ups.read(never())).chargePercent, 98, 'a fresh connection after the abort');
  assert.equal(daemon.connections, 4, 'one connection per reading');

  await assert.rejects(new NutUps('127.0.0.1', 1, 'ups').read(never()), /nut:\/\/127\.0\.0\.1:1\/ups/);
});

test('the apcupsd client reads a NIS status conversation over TCP', async (t) => {
  const daemon = apcupsdDaemon(['APC      : 001,036,0859', 'MODEL    : Back-UPS XS 1400U', 'STATUS   : ONBATT', 'BCHARGE  : 55.0 Percent', 'TIMELEFT : 18.4 Minutes']);
  t.after(() => daemon.close());
  const { host, port } = await daemon.listen();
  const ups = new ApcupsdUps(host, port);
  assert.deepEqual(await ups.read(never()), { onBattery: true, chargePercent: 55, runtimeSeconds: 1104, status: 'ONBATT', model: 'Back-UPS XS 1400U' });
  assert.equal(decodeNisFrames(Buffer.from(daemon.requests[0]!, 'utf8')).lines[0], 'status');

  const silent = apcupsdDaemon([]);
  t.after(() => silent.close());
  const s = await silent.listen();
  silent.silent = 1;
  const controller = new AbortController();
  const pending = new ApcupsdUps(s.host, s.port).read(controller.signal);
  setTimeout(() => controller.abort(new Error('No UPS answer within 50 ms')), 50);
  await assert.rejects(pending, /within 50 ms/);
});

// ── Monitor: alerts, audit, auto-pause ───────────────────────────────────────

function fakeActions(): PowerActions & { paused: string[]; resumed: string[]; running: () => string[] } {
  const paused: string[] = [];
  const resumed: string[] = [];
  let running: () => string[] = () => [];
  return {
    paused,
    resumed,
    set running(fn: () => string[]) {
      running = fn;
    },
    get running() {
      return running;
    },
    pauseAll: () => {
      const ids = running();
      paused.push(...ids);
      return ids;
    },
    resumeAll: () => {
      const ids = [...paused];
      resumed.push(...ids);
      return ids;
    },
  };
}

test('mains → battery raises POWER_ON_BATTERY; the state is on /api/state and /api/health', async (t) => {
  const h = harness(t);
  const ups = new SimulatorUps();
  const hub = await h.start(undefined, { ups, powerOptions: { intervalMs: 0 } });

  let view = await hub.hub.power.poll();
  assert.equal(view.configured, true);
  assert.equal(view.onBattery, false);
  assert.equal(view.reachable, true);
  assert.equal(hub.hub.state().power.chargePercent, 100);

  ups.set({ onBattery: true, chargePercent: 80, runtimeSeconds: 1500 });
  view = await hub.hub.power.poll();
  assert.equal(view.onBattery, true);
  assert.equal(view.onBatterySince, MONDAY_NOON);
  const alerts = hub.hub.state().alerts;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.kind, 'POWER_ON_BATTERY');
  assert.equal(alerts[0]?.tableId, null);
  assert.match(alerts[0]?.message ?? '', /от ИБП \(заряд 80%, ≈25 мин\)/);
  assert.ok(auditActions(hub).includes('power.on_battery'));

  // Still on battery: no duplicate alert.
  h.clock.advance(60_000);
  ups.set({ chargePercent: 70 });
  await hub.hub.power.poll();
  assert.equal(hub.hub.state().alerts.length, 1);

  const health = await hub.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.json().power.onBattery, true);
  assert.equal(health.json().power.chargePercent, 70);
  const metrics = await hub.app.inject({ method: 'GET', url: '/metrics' });
  assert.match(metrics.body, /bills_power_on_battery 1\n/);
  assert.match(metrics.body, /bills_power_battery_charge_percent 70\n/);

  // Mains back: the alert resolves itself, the outage is audited with its length.
  ups.set({ onBattery: false, chargePercent: 71 });
  view = await hub.hub.power.poll();
  assert.equal(view.onBattery, false);
  assert.equal(view.onBatterySince, null);
  assert.equal(hub.hub.state().alerts.length, 0);
  const restored = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'power.restored'")[0];
  assert.equal(JSON.parse(restored?.data ?? '{}').outageMs, 60_000);
});

test('battery below the critical level raises POWER_CRITICAL once per outage', async (t) => {
  const h = harness(t);
  const ups = new SimulatorUps();
  const hub = await h.start(undefined, { ups, powerOptions: { intervalMs: 0, criticalPercent: 20 } });
  await hub.hub.power.poll();
  ups.set({ onBattery: true, chargePercent: 30 });
  await hub.hub.power.poll();
  ups.set({ chargePercent: 19, runtimeSeconds: 240 });
  await hub.hub.power.poll();
  ups.set({ chargePercent: 15 });
  await hub.hub.power.poll();
  const kinds = hub.hub.state().alerts.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['POWER_CRITICAL', 'POWER_ON_BATTERY']);
  assert.match(hub.hub.state().alerts.find((a) => a.kind === 'POWER_CRITICAL')?.message ?? '', /19%, ≈4 мин/);
  assert.equal(auditActions(hub).filter((a) => a === 'power.critical').length, 1);
  assert.equal(hub.hub.state().power.critical, true);

  ups.set({ onBattery: false });
  await hub.hub.power.poll();
  assert.equal(hub.hub.state().alerts.length, 0);
  assert.equal(hub.hub.state().power.critical, false);
});

test('autoPauseOnPowerLoss pauses running games on battery and resumes them on mains', async (t) => {
  const h = harness(t);
  const ups = new SimulatorUps();
  const actions = fakeActions();
  const hub = await h.start(undefined, { ups, powerOptions: { intervalMs: 0 }, powerActions: actions });
  const opened = await post(hub, `/api/tables/${tableId(hub, 'Стол 1')}/open`);
  await waitFor(() => sessionStatus(hub, opened.body.id) === 'ACTIVE');
  actions.running = () =>
    all<{ id: string }>(hub.db, "SELECT id FROM table_sessions WHERE status = 'ACTIVE'").map((r) => r.id);

  // Off by default: an outage only alerts.
  assert.equal(hub.hub.state().power.settings.autoPauseOnPowerLoss, false);
  await hub.hub.power.poll();
  ups.set({ onBattery: true });
  await hub.hub.power.poll();
  assert.deepEqual(actions.paused, []);
  ups.set({ onBattery: false });
  await hub.hub.power.poll();

  const res = await post(hub, '/api/power/settings', { autoPauseOnPowerLoss: true });
  assert.equal(res.status, 200);
  assert.equal(hub.hub.state().power.settings.autoPauseOnPowerLoss, true);
  assert.ok(auditActions(hub).includes('power.settings_changed'));

  ups.set({ onBattery: true });
  await hub.hub.power.poll();
  assert.deepEqual(actions.paused, [opened.body.id]);
  assert.equal(hub.hub.state().power.autoPausedSessions, 1);
  const paused = all<{ data: string }>(hub.db, "SELECT data FROM audit_log WHERE action = 'power.auto_paused'")[0];
  assert.deepEqual(JSON.parse(paused?.data ?? '{}').sessionIds, [opened.body.id]);

  ups.set({ onBattery: false });
  await hub.hub.power.poll();
  assert.deepEqual(actions.resumed, [opened.body.id]);
  assert.equal(hub.hub.state().power.autoPausedSessions, 0);
  assert.ok(auditActions(hub).includes('power.auto_resumed'));
});

test('an unreachable UPS daemon is an alert after several failed readings, resolved when it answers', async (t) => {
  const h = harness(t);
  const ups = new SimulatorUps();
  const hub = await h.start(undefined, { ups, powerOptions: { intervalMs: 0, unreachableAfter: 3 } });
  await hub.hub.power.poll();
  ups.set({ unreachable: true });
  await hub.hub.power.poll();
  await hub.hub.power.poll();
  assert.equal(hub.hub.state().alerts.length, 0);
  assert.equal(hub.hub.state().power.reachable, true, 'two misses are tolerated');
  const view = await hub.hub.power.poll();
  assert.equal(view.reachable, false);
  assert.equal(hub.hub.state().alerts[0]?.kind, 'UPS_UNREACHABLE');
  await hub.hub.power.poll();
  assert.equal(hub.hub.state().alerts.length, 1, 'no duplicates');

  ups.set({ unreachable: false });
  await hub.hub.power.poll();
  assert.equal(hub.hub.state().alerts.length, 0);
  assert.equal(hub.hub.state().power.reachable, true);
  assert.ok(auditActions(hub).includes('power.ups_reachable'));
});

test('without HUB_UPS the power view is empty and nothing is polled', async (t) => {
  const h = harness(t);
  const hub = await h.start();
  const view = hub.hub.state().power;
  assert.equal(view.configured, false);
  assert.equal(view.source, null);
  assert.deepEqual(await hub.hub.power.poll(), view);
  const metrics = await hub.app.inject({ method: 'GET', url: '/metrics' });
  assert.doesNotMatch(metrics.body, /bills_power_/);
});

test('the dev endpoint drives the simulated UPS for demos', async (t) => {
  const h = harness(t);
  const ups = new SimulatorUps();
  const hub = await h.start(undefined, { ups, powerOptions: { intervalMs: 0 } });
  await hub.hub.power.poll();
  const res = await hub.app.inject({ method: 'POST', url: '/api/dev/ups', payload: { onBattery: true, chargePercent: 50 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().onBattery, true);
  assert.equal(hub.hub.state().power.onBattery, true, 'the endpoint polls right away');
  assert.equal(hub.hub.state().power.status, 'OB DISCHRG');
  assert.equal(hub.hub.state().alerts[0]?.kind, 'POWER_ON_BATTERY');
  await hub.app.inject({ method: 'POST', url: '/api/dev/ups', payload: { chargePercent: 10 } });
  assert.equal(hub.hub.state().power.status, 'OB LB');
  assert.equal((await hub.app.inject({ method: 'GET', url: '/api/dev/ups' })).json().chargePercent, 10);
  assert.equal((await hub.app.inject({ method: 'GET', url: '/api/power' })).json().critical, true);

  const plain = new Harness();
  t.after(() => plain.dispose());
  const noUps = await plain.start();
  assert.equal((await noUps.app.inject({ method: 'GET', url: '/api/dev/ups' })).statusCode, 404);
});
