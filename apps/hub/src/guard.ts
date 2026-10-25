import { randomUUID } from 'node:crypto';
import type { GuardAlertKind, GuardSettings, GuardSettingsPatch } from '@bills/domain';
import {
  cancelsAboveNormal,
  cashDiscrepancyAlert,
  discountTooLarge,
  formatMoney,
  normalizeGuardSettings,
  refundReasons,
} from '@bills/domain';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import type { HubEvents } from './events.ts';
import { record, SYSTEM } from './journal.ts';
import { getManualMode } from './manual-mode.ts';

/**
 * «Сторож» (docs/INNOVATION_RU.md, item 1): rules on the HUB about suspicious operations and
 * lost money. Counted offline from the club's own records; each alert is an ordinary alert
 * (`alerts` table + `alert.raised` in the journal and the outbox), so staff see it in the
 * HUB with «Принято» and the cloud turns it into a push and a Telegram message.
 *
 * - texts never accuse and never name a person; the name is kept on the HUB only
 *   (`guard_state.staff`) and shown to managers next to the alert;
 * - every rule fires once per scope (a check, an employee in a shift, a shift, a game…);
 * - a rule never breaks the command that triggered it: it runs in a savepoint and
 *   an error only rolls the alert back.
 *
 * Hooks: checks.ts (refund, discount, voided game), bar.ts / counter.ts (cancelled order),
 * shifts.ts (close), hub.ts (manual mode timer, table reopened).
 */

const SETTINGS_KEY = 'guard_settings';
const STATE_KEY = 'guard_state';
/** Scopes and names older than this are forgotten. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Without an open shift, cancellations and discounts are judged over this window. */
const NO_SHIFT_WINDOW_MS = 12 * 60 * 60 * 1000;

interface GuardState {
  /** scope → when its alert was raised. */
  fired: Record<string, number>;
  /** alert id → who did it (managers see it on the HUB; never sent to the cloud). */
  staff: Record<string, { name: string; at: number }>;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export function getGuardSettings(db: Db): GuardSettings {
  const row = one<{ value: string }>(db, 'SELECT value FROM hub_settings WHERE key = ?', SETTINGS_KEY);
  if (!row) return normalizeGuardSettings({});
  try {
    return normalizeGuardSettings(JSON.parse(row.value));
  } catch {
    return normalizeGuardSettings({});
  }
}

export function setGuardSettings(db: Db, now: number, events: HubEvents, actor: string, patch: GuardSettingsPatch): GuardSettings {
  return transaction(db, () => {
    const current = getGuardSettings(db);
    const merged: Record<string, unknown> = {};
    for (const key of Object.keys(current) as Array<keyof GuardSettings>) {
      merged[key] = { ...current[key], ...(patch[key] ?? {}) };
    }
    const next = normalizeGuardSettings(merged, current);
    putSetting(db, now, actor, SETTINGS_KEY, next);
    record(db, now, {
      actor,
      action: 'guard.settings_changed',
      entityType: 'hub',
      entityId: 'guard',
      data: { ...next },
    });
    afterCommit(db, () => events.changed({ kind: 'settings' }));
    return next;
  });
}

// ── Raising ──────────────────────────────────────────────────────────────────

function readState(db: Db): GuardState {
  const row = one<{ value: string }>(db, 'SELECT value FROM hub_settings WHERE key = ?', STATE_KEY);
  if (!row) return { fired: {}, staff: {} };
  try {
    const raw = JSON.parse(row.value) as Partial<GuardState>;
    return { fired: raw.fired ?? {}, staff: raw.staff ?? {} };
  } catch {
    return { fired: {}, staff: {} };
  }
}

function putSetting(db: Db, now: number, actor: string, key: string, value: unknown): void {
  run(
    db,
    `INSERT INTO hub_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key,
    JSON.stringify(value),
    now,
    actor,
  );
}

interface GuardAlert {
  kind: GuardAlertKind;
  /** Once per scope: `refund:<check>`, `cancels:<shift>:<employee>`… */
  scope: string;
  tableId?: string | null;
  sessionId?: string | null;
  /** Shown on the HUB and sent as the push / Telegram text: no names, no accusations. */
  message: string;
  /** Who did it: kept on the HUB for managers only. */
  staff?: string | null;
}

/** Raises a «Сторож» alert unless this scope already had one; returns the alert id. */
function raise(db: Db, now: number, alert: GuardAlert): string | null {
  const state = readState(db);
  if (state.fired[alert.scope] !== undefined) return null;
  const id = randomUUID();
  const tableId = alert.tableId ?? null;
  const sessionId = alert.sessionId ?? null;
  run(
    db,
    'INSERT INTO alerts (id, at, kind, table_id, session_id, message) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    now,
    alert.kind,
    tableId,
    sessionId,
    alert.message,
  );
  record(db, now, {
    actor: SYSTEM,
    action: 'alert.raised',
    entityType: 'alert',
    entityId: id,
    data: { kind: alert.kind, tableId, sessionId, message: alert.message, guard: true },
  });
  const cutoff = now - KEEP_MS;
  const fired = Object.fromEntries(Object.entries(state.fired).filter(([, at]) => at >= cutoff));
  const staff = Object.fromEntries(Object.entries(state.staff).filter(([, s]) => s.at >= cutoff));
  fired[alert.scope] = now;
  if (alert.staff) staff[id] = { name: alert.staff, at: now };
  putSetting(db, now, SYSTEM, STATE_KEY, { fired, staff });
  return id;
}

/** Runs a rule in a savepoint: whatever goes wrong, the command that called it still succeeds. */
function safely(db: Db, rule: string, fn: () => void): void {
  run(db, 'SAVEPOINT guard');
  try {
    fn();
    run(db, 'RELEASE guard');
  } catch (e) {
    try {
      run(db, 'ROLLBACK TO guard');
      run(db, 'RELEASE guard');
    } catch {
      // The savepoint is gone with the transaction: nothing to undo.
    }
    console.warn(`[guard] rule ${rule} failed: ${(e as Error).message}`);
  }
}

/** Names behind the open alerts, for managers (GET /api/state). */
export function guardStaffNames(db: Db): Map<string, string> {
  return new Map(Object.entries(readState(db).staff).map(([id, s]) => [id, s.name]));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function currency(db: Db): string {
  return one<{ currency: string }>(db, 'SELECT currency FROM clubs ORDER BY created_at LIMIT 1')?.currency ?? 'KZT';
}

/** The window rules count over: the open shift, else the last 12 hours. */
function shiftWindow(db: Db, now: number): { since: number; scope: string } {
  const shift = one<{ id: string; opened_at: number }>(db, "SELECT id, opened_at FROM cash_shifts WHERE status = 'OPEN' LIMIT 1");
  if (shift) return { since: shift.opened_at, scope: `shift:${shift.id}` };
  return { since: now - NO_SHIFT_WINDOW_MS, scope: `noshift:${Math.floor(now / NO_SHIFT_WINDOW_MS)}` };
}

const count = (db: Db, sql: string, ...params: Array<string | number>): number => one<{ n: number }>(db, sql, ...params)?.n ?? 0;

function minutesText(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return `${min} мин`;
}

/** «40 с» under a minute, «12 мин» otherwise. */
function durationText(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} с` : minutesText(ms);
}

// ── Rules ────────────────────────────────────────────────────────────────────

/** 1. Refund after payment: large, a large share of the check, or long after the payment. */
export function guardRefund(db: Db, now: number, input: { checkId: string; amount: number; actor: string; approvedBy: string }): void {
  safely(db, 'refund', () => {
    const settings = getGuardSettings(db).refund;
    if (!settings.enabled) return;
    const check = one<{ number: number }>(db, 'SELECT number FROM checks WHERE id = ?', input.checkId);
    const paid = one<{ paid: number | null; paid_at: number | null }>(
      db,
      "SELECT SUM(amount) AS paid, MAX(at) AS paid_at FROM payments WHERE check_id = ? AND kind = 'PAYMENT'",
      input.checkId,
    );
    const reasons = refundReasons(settings, { amount: input.amount, paid: paid?.paid ?? 0, paidAt: paid?.paid_at ?? null, at: now });
    if (reasons.length === 0) return;
    const cur = currency(db);
    const details: string[] = [];
    if (paid?.paid) details.push(`${Math.round((input.amount * 100) / paid.paid)}% оплаты`);
    if (reasons.includes('late') && paid?.paid_at) details.push(`через ${minutesText(now - paid.paid_at)} после оплаты`);
    const name = check ? `Счёт №${check.number}` : 'Счёт';
    raise(db, now, {
      kind: 'REFUND_SUSPICIOUS',
      scope: `refund:${input.checkId}`,
      message: `${name}: возврат ${formatMoney(input.amount, cur)}${details.length ? ` (${details.join(', ')})` : ''}. Проверьте причину возврата — возможно, ошибка при вводе.`,
      staff: input.approvedBy && input.approvedBy !== input.actor ? `${input.actor}, подтвердил(а) ${input.approvedBy}` : input.actor,
    });
  });
}

/** 2. Cancelled orders and games by one employee in a shift above normal: once per employee per shift. */
export function guardCancel(db: Db, now: number, actor: string): void {
  safely(db, 'cancels', () => {
    const settings = getGuardSettings(db).cancels;
    if (!settings.enabled || actor === SYSTEM) return;
    const win = shiftWindow(db, now);
    const cancelled =
      count(db, "SELECT COUNT(*) AS n FROM bar_orders WHERE status = 'CANCELLED' AND cancelled_by = ? AND cancelled_at >= ?", actor, win.since) +
      count(db, "SELECT COUNT(*) AS n FROM table_sessions WHERE status = 'CANCELLED' AND cancelled_by = ? AND cancelled_at >= ?", actor, win.since);
    const created =
      count(db, 'SELECT COUNT(*) AS n FROM bar_orders WHERE created_by = ? AND created_at >= ?', actor, win.since) +
      count(db, 'SELECT COUNT(*) AS n FROM table_sessions WHERE opened_by = ? AND requested_at >= ?', actor, win.since);
    if (!cancelsAboveNormal(settings, { cancelled, created })) return;
    raise(db, now, {
      kind: 'CANCELS_ABOVE_NORMAL',
      scope: `cancels:${win.scope}:${actor}`,
      message: `Много отмен за смену у одного сотрудника: отменено ${cancelled} из ${Math.max(created, cancelled)} заказов и игр. Возможно, ошибка при вводе — проверьте причины в журнале.`,
      staff: actor,
    });
  });
}

/** 3. Cash counted at shift close differs from the expected by the threshold or more. */
export function guardShiftClosed(
  db: Db,
  now: number,
  input: { shiftId: string; number: number; expectedCash: number; countedCash: number; difference: number | null; actor: string },
): void {
  safely(db, 'cash', () => {
    const settings = getGuardSettings(db).cash;
    if (!cashDiscrepancyAlert(settings, input.difference)) return;
    const cur = currency(db);
    const diff = input.difference ?? 0;
    const what = diff < 0 ? `не хватает ${formatMoney(-diff, cur)}` : `лишние ${formatMoney(diff, cur)}`;
    raise(db, now, {
      kind: 'CASH_DISCREPANCY',
      scope: `cash:${input.shiftId}`,
      message: `Смена №${input.number} закрыта с расхождением: ${what} (ожидалось ${formatMoney(input.expectedCash, cur)}, посчитано ${formatMoney(input.countedCash, cur)}). Возможно, ошибка при пересчёте — проверьте Z-отчёт.`,
      staff: input.actor,
    });
  });
}

/** 4. Manual lamp mode on for too long: lamps are not checked meanwhile. Called by the HUB timer. */
export function guardManualMode(db: Db, now: number): string | null {
  let raised: string | null = null;
  safely(db, 'manual', () => {
    const settings = getGuardSettings(db).manualMode;
    const mode = getManualMode(db);
    if (!settings.enabled || !mode.enabled || mode.since === null) return;
    if (now - mode.since < settings.minutes * 60_000) return;
    raised = raise(db, now, {
      kind: 'MANUAL_MODE_LONG',
      scope: `manual:${mode.since}`,
      message: `Ручной режим ламп включён уже ${minutesText(now - mode.since)}: пока он включён, свет над столами не проверяется. Проверьте контроллер и выключите режим, когда он заработает.`,
      staff: mode.by,
    });
  });
  return raised;
}

/** 5. A manual discount above the limit, or many manual discounts by one person in a shift. */
export function guardDiscount(
  db: Db,
  now: number,
  input: { checkId: string; number: number; amount: number; subtotal: number; actor: string },
): void {
  safely(db, 'discounts', () => {
    const settings = getGuardSettings(db).discounts;
    if (!settings.enabled) return;
    const cur = currency(db);
    if (discountTooLarge(settings, input)) {
      const pct = Math.round((input.amount * 100) / input.subtotal);
      raise(db, now, {
        kind: 'DISCOUNTS_ABOVE_NORMAL',
        scope: `discount:${input.checkId}`,
        message: `Счёт №${input.number}: скидка ${formatMoney(input.amount, cur)} — ${pct}% счёта, больше лимита ${settings.maxPercent}%. Проверьте причину скидки — возможно, ошибка при вводе.`,
        staff: input.actor,
      });
    }
    const win = shiftWindow(db, now);
    // Checks that carry a manual discount given by this person (a loyalty reward is not manual).
    const given = count(
      db,
      `SELECT COUNT(*) AS n FROM checks c
       WHERE c.discount_by = ? AND c.discount_kind IS NOT NULL AND c.updated_at >= ?
         AND NOT EXISTS (SELECT 1 FROM loyalty_checks l WHERE l.check_id = c.id AND l.discount > 0)`,
      input.actor,
      win.since,
    );
    if (given >= settings.perShift) {
      raise(db, now, {
        kind: 'DISCOUNTS_ABOVE_NORMAL',
        scope: `discounts:${win.scope}:${input.actor}`,
        message: `Много ручных скидок за смену у одного сотрудника: ${given}. Возможно, так и задумано — проверьте причины скидок в журнале.`,
        staff: input.actor,
      });
    }
  });
}

/** 6. A table stopped and opened again within minutes (billiards): the time may have been reset. */
export function guardTableOpened(db: Db, now: number, tableId: string): string | null {
  let raised: string | null = null;
  safely(db, 'reopen', () => {
    const live = one<{ id: string; requested_at: number; opened_by: string; name: string }>(
      db,
      `SELECT s.id, s.requested_at, s.opened_by, t.name FROM table_sessions s JOIN billiard_tables t ON t.id = s.table_id
       WHERE s.table_id = ? AND s.status IN ('OPENING', 'ACTIVE')`,
      tableId,
    );
    if (!live) return;
    const prev = one<{ id: string; started_at: number; stopped_at: number; stopped_by: string | null }>(
      db,
      `SELECT id, started_at, stopped_at, stopped_by FROM table_sessions
       WHERE table_id = ? AND id <> ? AND started_at IS NOT NULL AND stopped_at IS NOT NULL
         AND status IN ('AWAITING_PAYMENT', 'CLOSED', 'CANCELLED')
       ORDER BY stopped_at DESC LIMIT 1`,
      tableId,
      live.id,
    );
    if (!prev) return;
    const gap = live.requested_at - prev.stopped_at;
    const settings = getGuardSettings(db).reopen;
    if (!settings.enabled || gap < 0 || gap >= settings.minutes * 60_000) return;
    const after = durationText(gap);
    const staff =
      prev.stopped_by && prev.stopped_by !== live.opened_by ? `${prev.stopped_by} (стоп), ${live.opened_by} (открытие)` : live.opened_by;
    raised = raise(db, now, {
      kind: 'TABLE_REOPENED_QUICKLY',
      scope: `reopen:${live.id}`,
      tableId,
      sessionId: live.id,
      message: `${live.name}: игру остановили и через ${after} открыли снова (до этого играли ${durationText(prev.stopped_at - prev.started_at)}). Проверьте, что прошлая игра оплачена, — возможно, ошибка при вводе.`,
      staff,
    });
  });
  return raised;
}

/** Open «Сторож» alerts (tests, diagnostics). */
export function openGuardAlerts(db: Db): Array<{ id: string; kind: string; message: string; table_id: string | null }> {
  return all(
    db,
    `SELECT id, kind, message, table_id FROM alerts WHERE resolved_at IS NULL AND kind IN
     ('REFUND_SUSPICIOUS', 'CANCELS_ABOVE_NORMAL', 'CASH_DISCREPANCY', 'MANUAL_MODE_LONG', 'DISCOUNTS_ABOVE_NORMAL', 'TABLE_REOPENED_QUICKLY')
     ORDER BY at`,
  );
}
