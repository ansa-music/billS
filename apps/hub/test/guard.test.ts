import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckView, GuardSettings, HubState } from '@bills/domain';
import { DEFAULT_GUARD_SETTINGS } from '@bills/domain';
import { all, run } from '../src/db.ts';
import { guardStaffNames, openGuardAlerts } from '../src/guard.ts';
import type { TestHub } from './helpers.ts';
import { Harness, post, sessionStatus, tableId, waitFor } from './helpers.ts';

const MINUTE = 60_000;
const CASHIER = 'Кассир Айгерим';
const OTHER = 'Кассир Динара';
const MANAGER = 'Управляющий Ерлан';
/** The name the test HUB takes for a manager when switching manual mode off. */
const MANUAL_OFF = 'Управляющий';

function harness(t: { after: (fn: () => Promise<void>) => void }): Harness {
  const h = new Harness();
  t.after(() => h.dispose());
  return h;
}

/** Starts a HUB without the guard timer: tests call `hub.guardTick()` themselves. */
const start = (h: Harness) => h.start(undefined, { guardIntervalMs: 0 });

async function openActive(t: TestHub, table: string, actor = CASHIER): Promise<string> {
  const s = t.hub.sessions.open({ tableId: tableId(t, table), actor });
  await waitFor(() => sessionStatus(t, s.id) === 'ACTIVE');
  return s.id;
}

/** Opens a game, lets it run for `minutes` and stops it: AWAITING_PAYMENT. */
async function play(t: TestHub, h: Harness, table: string, minutes: number, actor = CASHIER): Promise<{ id: string; amount: number }> {
  const id = await openActive(t, table, actor);
  h.clock.advance(minutes * MINUTE);
  const stopped = t.hub.stopGame({ sessionId: id, actor });
  return { id, amount: stopped.amount ?? 0 };
}

async function paidCheck(t: TestHub, h: Harness, table: string, minutes: number): Promise<CheckView> {
  const game = await play(t, h, table, minutes);
  const check = t.hub.checks.create({ sessionIds: [game.id], actor: CASHIER });
  t.hub.checks.pay({ checkId: check.id, parts: [{ method: 'CARD', amount: check.due }], actor: CASHIER });
  return t.hub.checks.get(check.id);
}

/** Every `alert.raised` the HUB queued for the cloud. */
function outboxAlerts(t: TestHub): Array<{ kind: string; message: string; tableId: string | null; guard?: boolean }> {
  return all<{ payload: string }>(t.db, "SELECT payload FROM outbox WHERE topic = 'alert.raised' ORDER BY id").map(
    (r) => (JSON.parse(r.payload) as { data: { kind: string; message: string; tableId: string | null; guard?: boolean } }).data,
  );
}

const kinds = (t: TestHub) => openGuardAlerts(t.db).map((a) => a.kind);

function assertNoNames(text: string): void {
  for (const name of [CASHIER, OTHER, MANAGER, 'Айгерим', 'Динара', 'Ерлан']) assert.ok(!text.includes(name), `«${name}» in «${text}»`);
}

function setGuard(t: TestHub, patch: Parameters<TestHub['hub']['setGuardSettings']>[1]): GuardSettings {
  return t.hub.setGuardSettings(MANAGER, patch);
}

// ── 1. Refunds ───────────────────────────────────────────────────────────────

test('guard: a refund that is large, a big share of the check or late raises one alert per check', async (t) => {
  const h = harness(t);
  const hub = await start(h);
  hub.hub.shifts.open({ openingFloat: 10000_00, actor: CASHIER });
  setGuard(hub, { reopen: { enabled: false } });

  // A small refund right after the payment: nothing.
  const a = await paidCheck(hub, h, 'Стол 1', 60);
  assert.ok(a.paid >= 1000_00, `paid ${a.paid}`);
  const small = Math.floor((a.paid * 20) / 100);
  hub.hub.checks.refund({ checkId: a.id, method: 'CARD', amount: small, reason: 'ошибка', approvedBy: MANAGER, actor: CASHIER });
  assert.deepEqual(kinds(hub), []);

  // Half of the check back: one alert, the second refund of the same check is folded into it.
  const b = await paidCheck(hub, h, 'Стол 2', 60);
  hub.hub.checks.refund({ checkId: b.id, method: 'CARD', amount: b.paid / 2, reason: 'гость ушёл', approvedBy: MANAGER, actor: CASHIER });
  hub.hub.checks.refund({ checkId: b.id, method: 'CARD', amount: 100_00, reason: 'ещё', approvedBy: MANAGER, actor: CASHIER });
  const alerts = openGuardAlerts(hub.db);
  assert.deepEqual(alerts.map((x) => x.kind), ['REFUND_SUSPICIOUS']);
  assert.match(alerts[0]!.message, new RegExp(`^Счёт №${b.number}: возврат .+ \\(50% оплаты\\)\\. Проверьте причину возврата — возможно, ошибка при вводе\\.$`));
  assertNoNames(alerts[0]!.message);
  // The name stays on the HUB for managers only.
  assert.equal(guardStaffNames(hub.db).get(alerts[0]!.id), `${CASHIER}, подтвердил(а) ${MANAGER}`);

  // A small refund long after the payment.
  const c = await paidCheck(hub, h, 'Стол 3', 60);
  h.clock.advance(31 * MINUTE);
  hub.hub.checks.refund({ checkId: c.id, method: 'CARD', amount: 10_00, reason: 'жалоба', approvedBy: MANAGER, actor: CASHIER });
  const late = openGuardAlerts(hub.db).at(-1)!;
  assert.equal(late.kind, 'REFUND_SUSPICIOUS');
  assert.match(late.message, /через 31 мин после оплаты/);

  // Large in money (default ≥ 5 000 ₸) even though it is a small share.
  const d = await paidCheck(hub, h, 'Стол 4', 12 * 60);
  assert.ok(d.paid * 30 > 5000_00 * 100, `paid ${d.paid}: 5 000 ₸ must be under 30 %`);
  hub.hub.checks.refund({ checkId: d.id, method: 'CARD', amount: 5000_00, reason: 'ошибка', approvedBy: MANAGER, actor: CASHIER });
  assert.equal(kinds(hub).length, 3);

  // Switched off: nothing.
  setGuard(hub, { refund: { enabled: false } });
  const e = await paidCheck(hub, h, 'Стол 5', 60);
  hub.hub.checks.refund({ checkId: e.id, method: 'CARD', amount: e.paid, reason: 'ошибка', approvedBy: MANAGER, actor: CASHIER });
  assert.equal(kinds(hub).length, 3);

  // Each alert is journaled and queued for the cloud, without names.
  const queued = outboxAlerts(hub).filter((x) => x.kind === 'REFUND_SUSPICIOUS');
  assert.equal(queued.length, 3);
  for (const q of queued) {
    assert.equal(q.guard, true);
    assertNoNames(JSON.stringify(q));
  }
});

// ── 2. Cancellations ─────────────────────────────────────────────────────────

test('guard: cancellations above normal — once per employee per shift, not below the count or the share', async (t) => {
  const h = harness(t);
  const hub = await start(h);
  setGuard(hub, { reopen: { enabled: false } });
  const cancel = (id: string, actor = CASHIER) => hub.hub.checks.cancelGame({ sessionId: id, reason: 'ошибка', approvedBy: MANAGER, actor });

  // No shift yet: the last 12 hours count. Two cancelled games — below 3.
  for (const table of ['Стол 1', 'Стол 2']) cancel((await play(hub, h, table, 5)).id);
  assert.deepEqual(kinds(hub), []);
  cancel((await play(hub, h, 'Стол 3', 5)).id);
  const first = openGuardAlerts(hub.db);
  assert.deepEqual(first.map((a) => a.kind), ['CANCELS_ABOVE_NORMAL']);
  assert.equal(first[0]!.message, 'Много отмен за смену у одного сотрудника: отменено 3 из 3 заказов и игр. Возможно, ошибка при вводе — проверьте причины в журнале.');
  assert.equal(guardStaffNames(hub.db).get(first[0]!.id), CASHIER);
  // A fourth one by the same person: still one alert.
  cancel((await play(hub, h, 'Стол 4', 5)).id);
  assert.equal(kinds(hub).length, 1);

  // A new shift starts a new count.
  h.clock.advance(MINUTE);
  hub.hub.shifts.open({ openingFloat: 0, actor: CASHIER });
  for (const table of ['Стол 1', 'Стол 2']) cancel((await play(hub, h, table, 5)).id);
  assert.equal(kinds(hub).length, 1);

  // Bar orders count too, and the share of the person's own orders matters: 3 of 40 is below 10 %.
  const game = await openActive(hub, 'Снукер', OTHER);
  const product = hub.hub.bar.catalog().products.find((p) => p.isActive)!;
  const orders = Array.from({ length: 38 }, () =>
    hub.hub.bar.createOrder({ sessionId: game, items: [{ productId: product.id, qty: 1 }], actor: OTHER }),
  );
  for (const o of orders.slice(0, 3)) hub.hub.bar.cancelOrder({ orderId: o.id, reason: 'ошибка', actor: OTHER });
  assert.equal(kinds(hub).length, 1, '3 of 39 is below 10 %');
  hub.hub.bar.cancelOrder({ orderId: orders[3]!.id, reason: 'ошибка', actor: OTHER });
  const other = openGuardAlerts(hub.db).at(-1)!;
  assert.equal(other.kind, 'CANCELS_ABOVE_NORMAL');
  assert.match(other.message, /отменено 4 из 39 заказов и игр/);
  assert.equal(guardStaffNames(hub.db).get(other.id), OTHER);

  // The first person's third cancellation in this shift: a new alert (new shift, new scope).
  cancel((await play(hub, h, 'Стол 3', 5)).id);
  assert.equal(kinds(hub).length, 3);
  assert.equal(outboxAlerts(hub).filter((a) => a.kind === 'CANCELS_ABOVE_NORMAL').length, 3);
});

// ── 3. Cash discrepancy ──────────────────────────────────────────────────────

test('guard: cash discrepancy at shift close at or above the threshold', async (t) => {
  const h = harness(t);
  const hub = await start(h);
  let shift = hub.hub.shifts.open({ openingFloat: 10000_00, actor: CASHIER });
  hub.hub.shifts.close({ shiftId: shift.id, countedCash: 10000_00 - 999_00, actor: CASHIER });
  assert.deepEqual(kinds(hub), []);

  shift = hub.hub.shifts.open({ openingFloat: 10000_00, actor: CASHIER });
  hub.hub.shifts.close({ shiftId: shift.id, countedCash: 10000_00 - 1500_00, actor: CASHIER });
  const [alert] = openGuardAlerts(hub.db);
  assert.equal(alert?.kind, 'CASH_DISCREPANCY');
  assert.match(alert!.message, new RegExp(`^Смена №${shift.number} закрыта с расхождением: не хватает 1\\s500\\s₸ \\(ожидалось 10\\s000\\s₸, посчитано 8\\s500\\s₸\\)\\. Возможно, ошибка при пересчёте — проверьте Z-отчёт\\.$`, 'u'));
  assert.equal(guardStaffNames(hub.db).get(alert!.id), CASHIER);

  // A surplus is a discrepancy too; a lower threshold from the settings applies.
  setGuard(hub, { cash: { minDifference: 100_00 } });
  shift = hub.hub.shifts.open({ openingFloat: 0, actor: CASHIER });
  hub.hub.shifts.close({ shiftId: shift.id, countedCash: 200_00, actor: CASHIER });
  assert.match(openGuardAlerts(hub.db).at(-1)!.message, /лишние 200\s₸/u);
  assert.equal(outboxAlerts(hub).filter((a) => a.kind === 'CASH_DISCREPANCY').length, 2);
});

// ── 4. Manual lamp mode ──────────────────────────────────────────────────────

test('guard: manual lamp mode left on longer than the limit — once per switch-on', async (t) => {
  const h = harness(t);
  const hub = await start(h);
  hub.hub.setManualMode({ enabled: true, reason: 'контроллер не отвечает', actor: CASHIER });
  h.clock.advance(14 * MINUTE);
  assert.equal(hub.hub.guardTick(), null);
  h.clock.advance(2 * MINUTE);
  const id = hub.hub.guardTick();
  assert.ok(id);
  const [alert] = openGuardAlerts(hub.db);
  assert.equal(alert?.kind, 'MANUAL_MODE_LONG');
  assert.equal(
    alert!.message,
    'Ручной режим ламп включён уже 16 мин: пока он включён, свет над столами не проверяется. Проверьте контроллер и выключите режим, когда он заработает.',
  );
  assert.equal(guardStaffNames(hub.db).get(alert!.id), CASHIER);
  h.clock.advance(30 * MINUTE);
  assert.equal(hub.hub.guardTick(), null, 'once per switch-on');

  // Off and on again: a new period, a new alert after the limit.
  hub.hub.setManualMode({ enabled: false, actor: MANUAL_OFF });
  hub.hub.setManualMode({ enabled: true, reason: 'снова сломался', actor: CASHIER });
  h.clock.advance(16 * MINUTE);
  assert.ok(hub.hub.guardTick());
  assert.equal(outboxAlerts(hub).filter((a) => a.kind === 'MANUAL_MODE_LONG').length, 2);

  // Off: nothing more.
  hub.hub.setManualMode({ enabled: false, actor: MANUAL_OFF });
  h.clock.advance(60 * MINUTE);
  assert.equal(hub.hub.guardTick(), null);
});

// ── 5. Discounts ─────────────────────────────────────────────────────────────

test('guard: a discount above the limit, and many manual discounts by one person in a shift', async (t) => {
  const h = harness(t);
  const hub = await start(h);
  hub.hub.shifts.open({ openingFloat: 0, actor: CASHIER });
  setGuard(hub, { reopen: { enabled: false } });
  const checkOf = async (table: string) => {
    const game = await play(hub, h, table, 60);
    return hub.hub.checks.create({ sessionIds: [game.id], actor: CASHIER });
  };
  const discount = (checkId: string, value: number, actor = CASHIER) =>
    hub.hub.checks.setDiscount({ checkId, discount: { kind: 'PERCENT', value, reason: 'постоянный гость' }, actor });

  const c1 = await checkOf('Стол 1');
  discount(c1.id, 10);
  assert.deepEqual(kinds(hub), []);
  discount(c1.id, 40);
  const big = openGuardAlerts(hub.db);
  assert.deepEqual(big.map((a) => a.kind), ['DISCOUNTS_ABOVE_NORMAL']);
  assert.match(big[0]!.message, new RegExp(`^Счёт №${c1.number}: скидка .+ — 40% счёта, больше лимита 30%\\. Проверьте причину скидки — возможно, ошибка при вводе\\.$`));
  discount(c1.id, 50);
  assert.equal(kinds(hub).length, 1, 'once per check');

  // Small discounts: the third check of the same person raises «many discounts».
  const c2 = await checkOf('Стол 2');
  discount(c2.id, 5);
  const c3 = await checkOf('Стол 3');
  discount(c3.id, 5, OTHER); // somebody else's does not count for the cashier
  assert.equal(kinds(hub).length, 1);
  const c4 = await checkOf('Стол 4');
  discount(c4.id, 5);
  const many = openGuardAlerts(hub.db).at(-1)!;
  assert.equal(many.message, 'Много ручных скидок за смену у одного сотрудника: 3. Возможно, так и задумано — проверьте причины скидок в журнале.');
  assert.equal(guardStaffNames(hub.db).get(many.id), CASHIER);
  const c5 = await checkOf('Стол 5');
  discount(c5.id, 5);
  assert.equal(kinds(hub).length, 2, 'once per person per shift');
  assert.equal(outboxAlerts(hub).filter((a) => a.kind === 'DISCOUNTS_ABOVE_NORMAL').length, 2);
});

// ── 6. Table closed and opened again ─────────────────────────────────────────

test('guard: a table stopped and opened again within minutes — once per game, not after the limit', async (t) => {
  const h = harness(t);
  const hub = await start(h);
  await play(hub, h, 'Стол 1', 50);
  h.clock.advance(40_000);
  const again = await openActive(hub, 'Стол 1', OTHER);
  const [alert] = openGuardAlerts(hub.db);
  assert.equal(alert?.kind, 'TABLE_REOPENED_QUICKLY');
  assert.equal(alert!.table_id, tableId(hub, 'Стол 1'));
  assert.equal(
    alert!.message,
    'Стол 1: игру остановили и через 40 с открыли снова (до этого играли 50 мин). Проверьте, что прошлая игра оплачена, — возможно, ошибка при вводе.',
  );
  assert.equal(guardStaffNames(hub.db).get(alert!.id), `${CASHIER} (стоп), ${OTHER} (открытие)`);
  // Later events of the same game do not repeat it.
  hub.hub.sessions.pause({ sessionId: again, actor: OTHER });
  assert.equal(kinds(hub).length, 1);

  // Stopped, then opened after the limit: nothing.
  hub.hub.stopGame({ sessionId: again, actor: OTHER });
  h.clock.advance(3 * MINUTE);
  await openActive(hub, 'Стол 1');
  assert.equal(kinds(hub).length, 1);

  // The table drawer shows it; the cloud gets it with the table.
  const state = (await hub.app.inject({ method: 'GET', url: '/api/state' })).json() as HubState;
  const shown = state.alerts.find((a) => a.kind === 'TABLE_REOPENED_QUICKLY');
  assert.equal(shown?.tableId, tableId(hub, 'Стол 1'));
  assert.equal(shown?.staff, `${CASHIER} (стоп), ${OTHER} (открытие)`, 'a manager sees who');
  assert.deepEqual(
    outboxAlerts(hub).map((a) => [a.kind, a.tableId]),
    [['TABLE_REOPENED_QUICKLY', tableId(hub, 'Стол 1')]],
  );

  // Switched off in the settings.
  setGuard(hub, { reopen: { enabled: false } });
  const last = await play(hub, h, 'Стол 2', 10);
  assert.ok(last.id);
  h.clock.advance(10_000);
  await openActive(hub, 'Стол 2');
  assert.equal(kinds(hub).length, 1);
});

// ── Settings and the «Принято» flow ──────────────────────────────────────────

test('guard: settings over HTTP (defaults, partial update, validation) and «Принято» closes a guard alert', async (t) => {
  const h = harness(t);
  const hub = await start(h);
  const get = await hub.app.inject({ method: 'GET', url: '/api/guard/settings' });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(get.json(), DEFAULT_GUARD_SETTINGS);

  const saved = await post(hub, '/api/guard/settings', { cancels: { minCount: 5 }, cash: { enabled: false } }, undefined, MANAGER);
  assert.equal(saved.status, 200);
  const next = saved.body as unknown as GuardSettings;
  assert.equal(next.cancels.minCount, 5);
  assert.equal(next.cancels.minPercent, DEFAULT_GUARD_SETTINGS.cancels.minPercent);
  assert.equal(next.cash.enabled, false);
  assert.equal(next.cash.minDifference, DEFAULT_GUARD_SETTINGS.cash.minDifference);
  const audit = all<{ action: string; actor: string }>(hub.db, "SELECT action, actor FROM audit_log WHERE action = 'guard.settings_changed'").map((r) => ({ ...r }));
  assert.deepEqual(audit, [{ action: 'guard.settings_changed', actor: MANAGER }]);

  const bad = await post(hub, '/api/guard/settings', { reopen: { minutes: 0 } }, undefined, MANAGER);
  assert.equal(bad.status, 400);
  // Unknown keys are dropped by the schema (Fastify removeAdditional): nothing else changes.
  const unknown = await post(hub, '/api/guard/settings', { other: { enabled: false } }, undefined, MANAGER);
  assert.deepEqual(unknown.body, next);

  // A guard alert goes through the usual «Принято».
  hub.hub.setManualMode({ enabled: true, reason: 'контроллер не отвечает', actor: CASHIER });
  h.clock.advance(20 * MINUTE);
  const id = hub.hub.guardTick()!;
  const resolved = await post(hub, `/api/alerts/${id}/resolve`, {}, undefined, MANAGER);
  assert.equal(resolved.status, 200);
  assert.deepEqual(kinds(hub), []);
  assert.deepEqual(
    all<{ topic: string }>(hub.db, "SELECT topic FROM outbox WHERE topic LIKE 'alert.%' ORDER BY id").map((r) => r.topic),
    ['alert.raised', 'alert.resolved'],
  );
});

test('guard: a failing rule never breaks the command that triggered it', async (t) => {
  const h = harness(t);
  const hub = await start(h);
  // Junk in the stored state and settings: the rules fall back to defaults and still work.
  run(hub.db, "INSERT INTO hub_settings (key, value, updated_at, updated_by) VALUES ('guard_state', '{oops', 0, 'x'), ('guard_settings', '[]', 0, 'x')");
  const shift = hub.hub.shifts.open({ openingFloat: 5000_00, actor: CASHIER });
  hub.hub.shifts.close({ shiftId: shift.id, countedCash: 0, actor: CASHIER });
  assert.deepEqual(kinds(hub), ['CASH_DISCREPANCY']);
  // The alerts table gone wrong (a constraint fails): the shift still closes, no alert.
  run(hub.db, "CREATE TRIGGER no_alerts BEFORE INSERT ON alerts BEGIN SELECT RAISE(ABORT, 'broken'); END");
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = warn;
  });
  const next = hub.hub.shifts.open({ openingFloat: 5000_00, actor: CASHIER });
  const closed = hub.hub.shifts.close({ shiftId: next.id, countedCash: 0, actor: CASHIER });
  assert.equal(closed.shift.status, 'CLOSED');
  assert.equal(kinds(hub).length, 1);
});
