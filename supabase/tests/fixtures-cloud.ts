/**
 * A rich, deterministic cloud dataset for comparing the Supabase RPC reports with
 * apps/cloud's TypeScript reports: two companies, clubs in Asia/Almaty and
 * Europe/Moscow, a club without settings or HUB, and a HUB event stream with
 * cross-midnight, paused, prepaid, voided, cancelled and failed games, checks with
 * discounts, split payments and refunds, cash shifts and movements, outages and
 * alerts. Everything goes through apps/cloud's own `acceptEvents`, so it loads the
 * same way into SQLite and into the Supabase PostgreSQL.
 */
import type { OwnerView, SyncEvent, TableKind, TableSetting, TariffConfig, TariffSetting } from '@bills/domain';
import type { SqlDriver } from '../../apps/cloud/src/db/driver.ts';
import { saveSettings } from '../../apps/cloud/src/settings.ts';
import type { HubRow } from '../../apps/cloud/src/sync.ts';
import { acceptEvents } from '../../apps/cloud/src/sync.ts';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** Monday 2026-10-12, local time in Almaty (UTC+5) / Moscow (UTC+3), `d` days later. */
export const alm = (d: number, h: number, m = 0, s = 0): number => Date.UTC(2026, 9, 12 + d, h - 5, m, s);
export const msk = (d: number, h: number, m = 0, s = 0): number => Date.UTC(2026, 9, 12 + d, h - 3, m, s);

/** When the HUBs last synced (12:30 in Almaty). */
export const LAST_SYNC = alm(0, 12, 30);
const CREATED = alm(-60, 9);

export const COMPANY_A = { id: 'company-a', name: 'Сеть «А»' };
export const COMPANY_B = { id: 'company-b', name: 'Чужая сеть' };

export const OWNER_A = { id: 'owner-a', email: 'owner.a@example.com', name: 'Владелец А', companyId: COMPANY_A.id };
export const OWNER_A2 = { id: 'owner-a2', email: 'manager.a@example.com', name: 'Совладелец А', companyId: COMPANY_A.id };
export const OWNER_B = { id: 'owner-b', email: 'owner@other.example', name: 'Владелец Б', companyId: COMPANY_B.id };

export const CLUB_ALMATY = { id: 'club-almaty', companyId: COMPANY_A.id, name: 'Клуб «Алматы»', timezone: 'Asia/Almaty', currency: 'KZT' };
export const CLUB_MOSCOW = { id: 'club-moscow', companyId: COMPANY_A.id, name: 'Клуб «Москва»', timezone: 'Europe/Moscow', currency: 'RUB' };
export const CLUB_EMPTY = { id: 'club-empty', companyId: COMPANY_A.id, name: 'Клуб «Пустой»', timezone: 'Asia/Almaty', currency: 'KZT' };
export const CLUB_OTHER = { id: 'club-other', companyId: COMPANY_B.id, name: 'Чужой клуб', timezone: 'Asia/Almaty', currency: 'KZT' };

export const COMPANY_A_CLUBS = [CLUB_ALMATY.id, CLUB_MOSCOW.id, CLUB_EMPTY.id];

const HUBS = [
  { id: 'hub-almaty', clubId: CLUB_ALMATY.id, keyHash: 'a'.repeat(64), settingsVersion: 2, receivedAt: LAST_SYNC },
  { id: 'hub-moscow', clubId: CLUB_MOSCOW.id, keyHash: 'b'.repeat(64), settingsVersion: 1, receivedAt: LAST_SYNC - 5 * MIN },
  { id: 'hub-other', clubId: CLUB_OTHER.id, keyHash: 'c'.repeat(64), settingsVersion: 0, receivedAt: LAST_SYNC },
] as const;

export function ownerView(o: { id: string; email: string; name: string; companyId: string }): OwnerView {
  const company = o.companyId === COMPANY_A.id ? COMPANY_A : COMPANY_B;
  return { id: o.id, email: o.email, name: o.name, company: { ...company } };
}

const TARIFF_CONFIG: TariffConfig = {
  currency: 'KZT',
  basePricePerHour: 2000_00,
  windows: [{ label: 'Вечер', days: [1, 2, 3, 4, 5], from: '18:00', to: '02:00', pricePerHour: 3000_00 }],
  stepMinutes: 1,
  minimumMinutes: 30,
  freeMinutes: 3,
  roundingMinor: 10_00,
};

const table = (id: string, name: string, kind: TableKind, sortOrder: number, isActive = true): TableSetting => ({
  id,
  name,
  kind,
  lampChannel: `relay-${sortOrder}`,
  defaultTariffId: 'tariff-std',
  sortOrder,
  isActive,
});

// ---------------------------------------------------------------------------
// Event stream
// ---------------------------------------------------------------------------

interface Ev {
  at: number;
  topic: string;
  entityId: string;
  data?: Record<string, unknown>;
  actor?: string;
}

function game(id: string, tableId: string, startedAt: number, stoppedAt: number, amount: number, pausedSeconds = 0): Ev[] {
  const playedSeconds = Math.floor((stoppedAt - startedAt) / 1000) - pausedSeconds;
  return [
    { at: startedAt - 1000, topic: 'session.open_requested', entityId: id, data: { tableId, tariffId: 'tariff-std' } },
    { at: startedAt, topic: 'session.started', entityId: id, data: { tableId, startedAt }, actor: 'system' },
    {
      at: stoppedAt,
      topic: 'session.stopped',
      entityId: id,
      data: { tableId, startedAt, stoppedAt, playedSeconds, pausedSeconds, billedSeconds: playedSeconds, amount, segments: [] },
    },
  ];
}

/** A check for whole games, paid at once by `parts`, then the games closed. */
function paidCheck(
  checkId: string,
  number: number,
  games: Array<[string, number]>,
  at: number,
  parts: Array<{ method: string; amount: number }>,
  shiftId: string,
): Ev[] {
  const subtotal = games.reduce((s, [, a]) => s + a, 0);
  const paid = parts.reduce((s, p) => s + p.amount, 0);
  return [
    { at, topic: 'check.created', entityId: checkId, data: { number, items: games.map(([sessionId, amount]) => ({ sessionId, amount })) } },
    { at: at + 1000, topic: 'payment.accepted', entityId: checkId, data: { shiftId, number, operationId: `op-${checkId}`, parts } },
    {
      at: at + 2000,
      topic: 'check.paid',
      entityId: checkId,
      data: { number, subtotal, discount: 0, total: subtotal, paid, shiftId, sessionIds: games.map(([s]) => s) },
    },
    ...games.map(([sessionId], i) => ({ at: at + 3000 + i, topic: 'session.closed', entityId: sessionId, data: { checkId } })),
  ];
}

function almatyEvents(): Ev[] {
  return [
    // 40 days ago: outside every window; its shift is closed.
    { at: alm(-40, 9), topic: 'shift.opened', entityId: 'a-s-old', data: { number: 1, openingFloat: 0 } },
    ...game('a-g-old', 't-a1', alm(-40, 15), alm(-40, 16), 2000_00),
    ...paidCheck('a-c-old', 90, [['a-g-old', 2000_00]], alm(-40, 16, 5), [{ method: 'CASH', amount: 2000_00 }], 'a-s-old'),
    { at: alm(-40, 23), topic: 'shift.closed', entityId: 'a-s-old', data: { number: 1, expectedCash: 2000_00, countedCash: 2000_00, difference: 0, net: { total: 2000_00, CASH: 2000_00, CARD: 0, QR: 0 } } },
    // An outage 35 days ago: not on the club page any more.
    { at: alm(-35, 3), topic: 'power.on_battery', entityId: 'hub' },
    { at: alm(-35, 3, 20), topic: 'power.restored', entityId: 'hub', data: { critical: false } },
    // Previous month, inside the 30-day window, not paid.
    ...game('a-g-sep', 't-a2', alm(-14, 19), alm(-14, 20, 30), 3000_00),
    // A table the HUB no longer reports at all, and an alert on it.
    ...game('a-g-gone', 't-gone', alm(-5, 14), alm(-5, 15), 900_00),
    { at: alm(-5, 14, 30), topic: 'alert.raised', entityId: 'a-al-4', data: { kind: 'LIGHT_WITHOUT_GAME', tableId: 't-gone', message: 'Свет на снятом столе' } },
    // Only the end of an outage was heard.
    { at: alm(-3, 4), topic: 'power.restored', entityId: 'hub', data: { outageMs: 10 * MIN, critical: false } },
    // A table switched off in the settings.
    ...game('a-g-oldtable', 't-old', alm(-2, 18), alm(-2, 19), 1800_00),
    // Yesterday: shift 7, a resolved alert, a paid game, cash in and out.
    { at: alm(-1, 8), topic: 'alert.raised', entityId: 'a-al-1', data: { kind: 'LIGHT_WITHOUT_GAME', tableId: 't-a1', message: 'Свет горит без игры' } },
    { at: alm(-1, 8, 30), topic: 'alert.resolved', entityId: 'a-al-1', actor: 'Кассир' },
    { at: alm(-1, 9), topic: 'shift.opened', entityId: 'a-s1', data: { number: 7, openingFloat: 5000_00 } },
    ...game('a-g1', 't-a1', alm(-1, 10), alm(-1, 11, 30), 3000_00),
    ...paidCheck('a-c1', 101, [['a-g1', 3000_00]], alm(-1, 11, 35), [{ method: 'CASH', amount: 3000_00 }], 'a-s1'),
    { at: alm(-1, 12), topic: 'shift.cash_deposited', entityId: 'a-s1', data: { movementId: 'a-mv-1', amount: 1000_00, reason: 'Размен' } },
    { at: alm(-1, 20), topic: 'shift.cash_withdrawn', entityId: 'a-s1', data: { movementId: 'a-mv-2', amount: 400_00, reason: 'Инкассация' } },
    // Across midnight, with a pause, a discount and a split payment.
    ...game('a-g2', 't-a2', alm(-1, 22, 30), alm(0, 1, 15), 4000_00, 300),
    { at: alm(0, 1, 16), topic: 'check.created', entityId: 'a-c2', data: { number: 102, items: [{ sessionId: 'a-g2', amount: 4000_00 }] } },
    { at: alm(0, 1, 17), topic: 'check.discount_set', entityId: 'a-c2', data: { amount: 500_00, reason: 'Постоянный гость' } },
    {
      at: alm(0, 1, 20),
      topic: 'payment.accepted',
      entityId: 'a-c2',
      data: { shiftId: 'a-s1', number: 102, operationId: 'op-a-c2', parts: [{ method: 'CARD', amount: 2000_00 }, { method: 'QR', amount: 1500_00 }] },
    },
    {
      at: alm(0, 1, 21),
      topic: 'check.paid',
      entityId: 'a-c2',
      data: { number: 102, subtotal: 4000_00, discount: 500_00, total: 3500_00, paid: 3500_00, shiftId: 'a-s1', sessionIds: ['a-g2'] },
    },
    { at: alm(0, 1, 22), topic: 'session.closed', entityId: 'a-g2', data: { checkId: 'a-c2' } },
    // A refund on yesterday's check, then the Z report.
    { at: alm(0, 2), topic: 'payment.refunded', entityId: 'a-c1', data: { shiftId: 'a-s1', method: 'CASH', amount: 300_00, reason: 'Ошибка' } },
    {
      at: alm(0, 3),
      topic: 'shift.closed',
      entityId: 'a-s1',
      data: { number: 7, expectedCash: 8300_00, countedCash: 8250_00, difference: -50_00, note: 'Недостача', net: { total: 6200_00, CASH: 2700_00, CARD: 2000_00, QR: 1500_00 } },
    },
    // Today: shift 8 open.
    { at: alm(0, 9), topic: 'shift.opened', entityId: 'a-s2', data: { number: 8, openingFloat: 3000_00 } },
    { at: alm(0, 9, 30), topic: 'session.open_requested', entityId: 'a-g6', data: { tableId: 't-a3' } },
    { at: alm(0, 9, 31), topic: 'session.cancelled', entityId: 'a-g6', data: { tableId: 't-a3', reason: 'Передумали' } },
    { at: alm(0, 9, 40), topic: 'session.open_requested', entityId: 'a-g7', data: { tableId: 't-a2' } },
    { at: alm(0, 9, 41), topic: 'session.failed', entityId: 'a-g7', data: { tableId: 't-a2', reason: 'LAMP_TIMEOUT' } },
    // Voided after the stop.
    ...game('a-g8', 't-a3', alm(0, 9, 45), alm(0, 10, 15), 1500_00),
    { at: alm(0, 10, 20), topic: 'session.voided', entityId: 'a-g8', data: { tableId: 't-a3', amount: 1500_00, reason: 'Ошибка кассира', approvedBy: 'Менеджер' } },
    // Prepaid hour, paid before the game.
    { at: alm(0, 9, 59), topic: 'session.open_requested', entityId: 'a-g5', data: { tableId: 't-a1', tariffId: 'tariff-std' } },
    { at: alm(0, 10), topic: 'session.prepaid', entityId: 'a-g5', data: { tableId: 't-a1', minutes: 60 } },
    { at: alm(0, 10, 0, 10), topic: 'check.created', entityId: 'a-c5', data: { number: 103, items: [{ sessionId: 'a-g5', amount: 2000_00 }] } },
    { at: alm(0, 10, 0, 20), topic: 'payment.accepted', entityId: 'a-c5', data: { shiftId: 'a-s2', number: 103, parts: [{ method: 'QR', amount: 2000_00 }] } },
    {
      at: alm(0, 10, 0, 30),
      topic: 'check.paid',
      entityId: 'a-c5',
      data: { number: 103, subtotal: 2000_00, discount: 0, total: 2000_00, paid: 2000_00, shiftId: 'a-s2', sessionIds: ['a-g5'] },
    },
    { at: alm(0, 10, 1), topic: 'session.started', entityId: 'a-g5', data: { tableId: 't-a1', startedAt: alm(0, 10, 1) }, actor: 'system' },
    {
      at: alm(0, 11, 1),
      topic: 'session.stopped',
      entityId: 'a-g5',
      data: { tableId: 't-a1', startedAt: alm(0, 10, 1), stoppedAt: alm(0, 11, 1), playedSeconds: 3600, billedSeconds: 3600, amount: 2000_00 },
      actor: 'system',
    },
    { at: alm(0, 11, 1, 1), topic: 'session.prepaid_ended', entityId: 'a-g5', data: { tableId: 't-a1', minutes: 60 } },
    { at: alm(0, 11, 2), topic: 'session.closed', entityId: 'a-g5', data: { checkId: 'a-c5' } },
    // Live, paused twice (the second time by the power monitor).
    { at: alm(0, 10, 30), topic: 'session.open_requested', entityId: 'a-g3', data: { tableId: 't-a2', tariffId: 'tariff-std' } },
    { at: alm(0, 10, 31), topic: 'session.started', entityId: 'a-g3', data: { tableId: 't-a2', startedAt: alm(0, 10, 31) }, actor: 'system' },
    { at: alm(0, 11, 0, 30), topic: 'session.paused', entityId: 'a-g3', data: { tableId: 't-a2', pausedAt: alm(0, 11, 0, 30) } },
    { at: alm(0, 11, 10), topic: 'session.resumed', entityId: 'a-g3', data: { tableId: 't-a2' } },
    { at: alm(0, 11, 40), topic: 'session.paused', entityId: 'a-g3', data: { tableId: 't-a2', pausedAt: alm(0, 11, 40), reason: 'power' }, actor: 'system' },
    // Live, moved to another table.
    { at: alm(0, 10, 58), topic: 'session.open_requested', entityId: 'a-g4', data: { tableId: 't-a3', tariffId: 'tariff-std' } },
    { at: alm(0, 11, 1, 30), topic: 'session.started', entityId: 'a-g4', data: { tableId: 't-a3', startedAt: alm(0, 11, 1, 30) }, actor: 'system' },
    { at: alm(0, 11, 20), topic: 'alert.raised', entityId: 'a-al-2', data: { kind: 'LAMP_DARK_DURING_GAME', tableId: 't-a3', sessionId: 'a-g4', message: 'Игра идёт без света' } },
    { at: alm(0, 11, 25), topic: 'alert.raised', entityId: 'a-al-3', data: { kind: 'UPS_UNREACHABLE', message: 'ИБП не отвечает' } },
    { at: alm(0, 11, 30), topic: 'session.transferred', entityId: 'a-g4', data: { tableId: 't-a3', toTableId: 't-a1' } },
    // A critical outage today.
    { at: alm(0, 11, 39), topic: 'power.on_battery', entityId: 'hub' },
    { at: alm(0, 11, 40, 1), topic: 'power.auto_paused', entityId: 'hub', data: { sessionIds: ['a-g3'] } },
    { at: alm(0, 11, 45), topic: 'lamp.failed', entityId: 't-a1', data: { tableId: 't-a1' } },
    { at: alm(0, 11, 50), topic: 'power.critical', entityId: 'hub' },
    { at: alm(0, 11, 58), topic: 'power.restored', entityId: 'hub', data: { critical: true } },
    // A check voided, a game just requested, an unknown topic.
    { at: alm(0, 12, 10), topic: 'check.created', entityId: 'a-c9', data: { number: 104, items: [] } },
    { at: alm(0, 12, 11), topic: 'check.voided', entityId: 'a-c9' },
    { at: alm(0, 12, 20), topic: 'session.open_requested', entityId: 'a-g10', data: { tableId: 't-a2' } },
    { at: alm(0, 12, 25), topic: 'hub.started', entityId: 'hub' },
  ];
}

function moscowEvents(): Ev[] {
  return [
    { at: msk(-1, 10), topic: 'shift.opened', entityId: 'm-s1', data: { number: 1, openingFloat: 0 } },
    ...game('m-g2', 'm-t2', msk(-1, 15), msk(-1, 16), 800_00),
    ...paidCheck('m-c2', 202, [['m-g2', 800_00]], msk(-1, 16, 5), [{ method: 'CARD', amount: 800_00 }], 'm-s1'),
    { at: msk(-1, 17), topic: 'payment.refunded', entityId: 'm-c2', data: { shiftId: 'm-s1', method: 'CARD', amount: 100_00 } },
    // Across midnight in Moscow.
    ...game('m-g1', 'm-t1', msk(-1, 23), msk(0, 0, 45), 1200_00),
    ...paidCheck('m-c1', 201, [['m-g1', 1200_00]], msk(0, 0, 50), [{ method: 'CASH', amount: 1200_00 }], 'm-s1'),
    // No Z figures: the net comes from sales − refunds.
    { at: msk(0, 1), topic: 'shift.closed', entityId: 'm-s1', data: { number: 1, expectedCash: 1200_00, countedCash: 1200_00, difference: 0 } },
    // An outage still going on.
    { at: msk(0, 8), topic: 'power.on_battery', entityId: 'hub' },
    { at: msk(0, 8, 1), topic: 'alert.raised', entityId: 'm-al-1', data: { kind: 'POWER_ON_BATTERY', message: 'Нет электричества' } },
    { at: msk(0, 8, 59), topic: 'session.open_requested', entityId: 'm-g3', data: { tableId: 'm-t1' } },
    { at: msk(0, 9), topic: 'session.started', entityId: 'm-g3', data: { tableId: 'm-t1', startedAt: msk(0, 9) }, actor: 'system' },
  ];
}

function otherEvents(): Ev[] {
  return [
    { at: alm(0, 9), topic: 'shift.opened', entityId: 'o-s1', data: { number: 1, openingFloat: 100_00 } },
    ...game('o-g1', 'o-t1', alm(0, 10), alm(0, 11), 5000_00),
    ...paidCheck('o-c1', 1, [['o-g1', 5000_00]], alm(0, 11, 5), [{ method: 'CASH', amount: 5000_00 }], 'o-s1'),
    { at: alm(0, 11, 30), topic: 'shift.closed', entityId: 'o-s1', data: { number: 1, expectedCash: 5100_00, countedCash: 5100_00, difference: 0 } },
    { at: alm(0, 11, 31), topic: 'alert.raised', entityId: 'o-al-1', data: { kind: 'LIGHT_WITHOUT_GAME', tableId: 'o-t1', message: 'Чужая тревога' } },
    { at: alm(0, 11, 40), topic: 'power.on_battery', entityId: 'hub' },
    { at: alm(0, 12), topic: 'session.open_requested', entityId: 'o-g2', data: { tableId: 'o-t1' } },
    { at: alm(0, 12, 1), topic: 'session.started', entityId: 'o-g2', data: { tableId: 'o-t1', startedAt: alm(0, 12, 1) }, actor: 'system' },
  ];
}

/** Outbox rows in time order (a stable sort keeps same-instant events in written order). */
function toOutbox(events: Ev[]): SyncEvent[] {
  return [...events]
    .sort((a, b) => a.at - b.at)
    .map((e, i) => {
      const entityType = e.topic.split('.')[0] ?? 'hub';
      return {
        id: i + 1,
        at: e.at,
        topic: e.topic,
        payload: { actor: e.actor ?? 'Кассир', action: e.topic, entityType, entityId: e.entityId, data: e.data ?? {} },
      };
    });
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Companies, owners, clubs, HUBs, settings, owner devices/keys/sessions and every HUB event. */
export async function loadFixture(db: SqlDriver): Promise<void> {
  for (const c of [COMPANY_A, COMPANY_B]) {
    await db.run('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', [c.id, c.name, CREATED]);
  }
  for (const [i, o] of [OWNER_A, OWNER_A2, OWNER_B].entries()) {
    await db.run('INSERT INTO owners (id, company_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      o.id,
      o.companyId,
      o.email,
      o.name,
      'salt:hash',
      CREATED + i,
    ]);
  }
  for (const [i, c] of [CLUB_ALMATY, CLUB_MOSCOW, CLUB_EMPTY, CLUB_OTHER].entries()) {
    await db.run('INSERT INTO clubs (id, company_id, name, timezone, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      c.id,
      c.companyId,
      c.name,
      c.timezone,
      c.currency,
      CREATED + i,
    ]);
  }
  for (const h of HUBS) {
    await db.run('INSERT INTO hubs (id, club_id, name, api_key_hash, created_at, settings_version) VALUES (?, ?, ?, ?, ?, 0)', [
      h.id,
      h.clubId,
      `HUB ${h.id}`,
      h.keyHash,
      CREATED,
    ]);
  }

  const tariffs: TariffSetting[] = [{ id: 'tariff-std', name: 'Стандарт', config: TARIFF_CONFIG, isActive: true }];
  await saveSettings(
    db,
    CLUB_ALMATY.id,
    {
      version: 3,
      club: { name: CLUB_ALMATY.name, timezone: CLUB_ALMATY.timezone, currency: CLUB_ALMATY.currency },
      tariffs,
      // Out of sortOrder on purpose; t-old is switched off.
      tables: [
        table('t-a1', 'Стол 1', 'pool', 2),
        table('t-a2', 'Стол 2', 'pool', 1),
        table('t-a3', 'Снукер', 'snooker', 3),
        table('t-old', 'Старый стол', 'russian', 4, false),
      ],
      staff: [{ id: 'staff-1', name: 'Кассир', role: 'cashier', isActive: true }],
    },
    'owner',
    CREATED,
  );
  await saveSettings(
    db,
    CLUB_MOSCOW.id,
    {
      version: 1,
      club: { name: CLUB_MOSCOW.name, timezone: CLUB_MOSCOW.timezone, currency: CLUB_MOSCOW.currency },
      tariffs: [{ ...tariffs[0]!, config: { ...TARIFF_CONFIG, currency: 'RUB' } as TariffConfig }],
      tables: [table('m-t1', 'Стол 1', 'pool', 1), table('m-t2', 'Стол 2', 'russian', 2)],
      staff: [],
    },
    'hub',
    CREATED,
  );
  await saveSettings(
    db,
    CLUB_OTHER.id,
    {
      version: 0,
      club: { name: CLUB_OTHER.name, timezone: CLUB_OTHER.timezone, currency: CLUB_OTHER.currency },
      tariffs,
      tables: [table('o-t1', 'Чужой стол', 'pool', 1)],
      staff: [],
    },
    'hub',
    CREATED,
  );

  const streams: Record<string, SyncEvent[]> = {
    'hub-almaty': toOutbox(almatyEvents()),
    'hub-moscow': toOutbox(moscowEvents()),
    'hub-other': toOutbox(otherEvents()),
  };
  for (const h of HUBS) {
    const events = streams[h.id]!;
    const hubRow = async () => (await db.all<HubRow>('SELECT * FROM hubs WHERE id = ?', [h.id]))[0]!;
    // Two batches, the second one resent once (a lost response): nothing may double.
    const half = Math.floor(events.length / 2);
    await acceptEvents(db, h.receivedAt - 10 * MIN, await hubRow(), { hubId: h.id, settingsVersion: h.settingsVersion, events: events.slice(0, half) });
    await acceptEvents(db, h.receivedAt - MIN, await hubRow(), { hubId: h.id, settingsVersion: h.settingsVersion, events: events.slice(half) });
    await acceptEvents(db, h.receivedAt, await hubRow(), { hubId: h.id, settingsVersion: h.settingsVersion, events: events.slice(half) });
  }

  const devices: Array<[string, string, string, string, number, string | null]> = [
    ['dev-a-1', OWNER_A.id, 'web', 'Браузер', alm(-2, 9), null],
    ['dev-a-2', OWNER_A.id, 'android', 'Pixel', alm(-1, 9), 'FCM 500: boom'],
    ['dev-a2-1', OWNER_A2.id, 'ios', 'iPhone', alm(-1, 10), null],
    ['dev-b-1', OWNER_B.id, 'android', 'Чужой телефон', alm(-1, 11), null],
  ];
  for (const [id, owner, platform, name, at, error] of devices) {
    await db.run(
      'INSERT INTO owner_devices (id, owner_id, platform, token, name, created_at, last_seen_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, owner, platform, `token-${id}`, name, at, at + HOUR, error],
    );
  }
  for (const [id, owner] of [
    ['key-a', OWNER_A.id],
    ['key-b', OWNER_B.id],
  ] as const) {
    await db.run('INSERT INTO owner_keys (id, owner_id, key_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      owner,
      `hash-${id}`,
      'OWNER-AAAA',
      'Телефон',
      CREATED,
    ]);
    await db.run('INSERT INTO owner_sessions (token, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
      `session-${id}`,
      owner,
      CREATED,
      CREATED + 30 * DAY,
    ]);
  }
  await db.run("INSERT INTO push_rules (owner_id, club_id, kind, enabled) VALUES (?, '', 'OTHER', 1)", [OWNER_B.id]);
  await db.run("INSERT INTO push_rules (owner_id, club_id, kind, enabled) VALUES (?, ?, 'HUB_OFFLINE', 0)", [OWNER_A.id, CLUB_MOSCOW.id]);
  await db.run("INSERT INTO push_rules (owner_id, club_id, kind, enabled) VALUES (?, '', 'RETIRED_KIND', 1)", [OWNER_A.id]);
}
