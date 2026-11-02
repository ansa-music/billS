import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrialView } from '../src/trials.ts';
import {
  agoText,
  bytesText,
  dayEndMs,
  effectiveStatus,
  filterTrials,
  paidLastDay,
  paidRequest,
  parseUntilDay,
  isWorkingNow,
  lastDays,
  lastOrderText,
  lastSeenText,
  latinName,
  parseExtendDays,
  trialBackup,
  trialBackupFileName,
  trialDate,
  trialDay,
  trialDaysLeft,
  trialTermText,
  trialTone,
} from '../src/trials.ts';

const DAY = 86_400_000;
const MIN = 60_000;
// 29 Oct 2026, 12:00 in Almaty (UTC+5).
const NOW = Date.UTC(2026, 9, 29, 7, 0, 0);

function trial(over: Partial<TrialView> = {}): TrialView {
  return {
    id: 't1',
    venue: 'Кофе Тау',
    managerName: 'Айгерим',
    startedAt: NOW - 3 * DAY,
    endsAt: NOW + 11 * DAY,
    status: 'active',
    lastSeenAt: NOW - 2 * MIN,
    stats: null,
    snapshotAt: null,
    snapshotBytes: null,
    plan: 'trial',
    paidUntil: null,
    summaryAt: null,
    viewLink: false,
    ...over,
  };
}

test('dates are Almaty days', () => {
  assert.equal(trialDate(Date.UTC(2026, 10, 12, 6)), '12 ноября');
  // 21:00 UTC is already the next day in Almaty.
  assert.equal(trialDay(Date.UTC(2026, 9, 28, 21)), '2026-10-29');
});

test('days left and the term in words', () => {
  assert.equal(trialDaysLeft(trial(), NOW), 11);
  assert.equal(trialTermText(trial(), NOW), 'осталось 11 дней · до 9 ноября');
  assert.equal(trialTermText(trial({ endsAt: NOW + 2 * DAY }), NOW), 'осталось 2 дня · до 31 октября');
  assert.equal(trialTermText(trial({ endsAt: NOW + 21 * DAY }), NOW), 'остался 21 день · до 19 ноября');
  assert.equal(trialTermText(trial({ endsAt: NOW + 5 * 3_600_000 }), NOW), 'последний день · до 29 октября');
});

test('ended and expired trials', () => {
  assert.equal(trialTermText(trial({ status: 'ended', endsAt: NOW - DAY }), NOW), 'завершена досрочно');
  assert.equal(trialTermText(trial({ status: 'expired', endsAt: NOW - DAY }), NOW), 'истекла 28 октября');
  // The cloud has not flagged it yet, but the end has passed.
  assert.equal(effectiveStatus(trial({ endsAt: NOW - MIN }), NOW), 'expired');
  assert.equal(trialDaysLeft(trial({ status: 'ended' }), NOW), 0);
});

test('chip tone', () => {
  assert.equal(trialTone(trial(), NOW), 'ok');
  assert.equal(trialTone(trial({ endsAt: NOW + DAY }), NOW), 'warn');
  assert.equal(trialTone(trial({ status: 'ended' }), NOW), 'danger');
});

test('last activity', () => {
  assert.equal(lastSeenText(null, NOW), 'ещё не выходил(а) на связь');
  assert.equal(lastSeenText(NOW - 9 * MIN, NOW), 'сейчас работает');
  assert.equal(isWorkingNow(NOW - 10 * MIN, NOW), false);
  assert.equal(lastSeenText(NOW - 25 * MIN, NOW), 'был(а) 25 мин назад');
  assert.equal(lastSeenText(NOW - 2 * 3_600_000, NOW), 'был(а) 2 ч назад');
  assert.equal(lastSeenText(NOW - 3 * DAY, NOW), 'был(а) 3 дн назад');
  assert.equal(agoText(0), '1 мин');
  assert.equal(lastOrderText(null, NOW), 'заказов ещё не было');
  assert.equal(lastOrderText(NOW - MIN, NOW), 'последний заказ только что');
  assert.equal(lastOrderText(NOW - 40 * MIN, NOW), 'последний заказ 40 мин назад');
});

test('custom extension days', () => {
  assert.equal(parseExtendDays(' 30 '), 30);
  assert.equal(parseExtendDays('1'), 1);
  assert.equal(parseExtendDays('90'), 90);
  assert.equal(parseExtendDays('0'), null);
  assert.equal(parseExtendDays('91'), null);
  assert.equal(parseExtendDays('2.5'), null);
  assert.equal(parseExtendDays(''), null);
});

test('the last 14 days are filled with zeros', () => {
  const days = lastDays([{ day: '2026-10-29', orders: 5, revenue: 900_000 }, { day: '2026-10-20', orders: 2, revenue: 100 }, { day: '2026-09-01', orders: 9, revenue: 9 }], 14, NOW);
  assert.equal(days.length, 14);
  assert.equal(days[0]?.day, '2026-10-16');
  assert.deepEqual(days[13], { day: '2026-10-29', orders: 5, revenue: 900_000 });
  assert.equal(days.find((d) => d.day === '2026-10-20')?.orders, 2);
  assert.equal(days.reduce((s, d) => s + d.orders, 0), 7);
  assert.equal(lastDays(undefined, 3, NOW).length, 3);
});

test('sizes', () => {
  assert.equal(bytesText(300), '1 КБ');
  assert.equal(bytesText(820 * 1024), '820 КБ');
  assert.equal(bytesText(1.4 * 1024 * 1024), '1,4 МБ');
});

test('backup file: exactly what «Восстановить из копии» reads', () => {
  const t = trial({ startedAt: 1_760_000_000_000 });
  const file = trialBackup(t, { snapshot: 'U1FMaXRl', snapshotAt: NOW - 5 * MIN });
  assert.deepEqual(file, {
    format: 'ts-trial-backup',
    version: 1,
    startedAt: 1_760_000_000_000,
    venue: 'Кофе Тау',
    managerName: 'Айгерим',
    managerKey: '',
    savedAt: NOW - 5 * MIN,
    db: 'U1FMaXRl',
    endsAt: t.endsAt,
    status: t.status,
  });
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(file))), ['format', 'version', 'startedAt', 'venue', 'managerName', 'managerKey', 'savedAt', 'db', 'endsAt', 'status']);
});

test('backup file name is Latin', () => {
  assert.equal(latinName('Кофе Тау'), 'kofe-tau');
  assert.equal(latinName('Қазақ Coffee №1'), 'kazak-coffee-1');
  assert.equal(latinName('☕'), 'kofeynya');
  assert.equal(trialBackupFileName('Кофе Тау', NOW), 'TS-kofe-tau-2026-10-29.ts-backup.json');
});

test('«Сделать постоянной»: a date means «paid through that day» in Almaty; «без срока»; limits', () => {
  // 12 December 2026 ends at 13 Dec 00:00 Almaty = 12 Dec 19:00 UTC.
  assert.equal(dayEndMs('2026-12-12'), Date.UTC(2026, 11, 12, 19, 0));
  assert.equal(dayEndMs('2026-02-30'), null);
  assert.equal(dayEndMs('12.12.2026'), null);
  assert.equal(paidLastDay(Date.UTC(2026, 11, 12, 19, 0)), '2026-12-12');
  assert.equal(trialDate(Date.UTC(2026, 11, 12, 19, 0) - 1), '12 декабря');
  assert.deepEqual(paidRequest(true, '', NOW), { plan: 'paid', paidUntil: null });
  assert.deepEqual(paidRequest(false, '2026-12-12', NOW), { plan: 'paid', paidUntil: Date.UTC(2026, 11, 12, 19, 0) });
  assert.ok('error' in paidRequest(false, '', NOW));
  assert.ok('error' in paidRequest(false, '2026-10-01', NOW), 'in the past');
  assert.ok('error' in paidRequest(false, '2040-01-01', NOW), 'too far');
  assert.deepEqual(parseUntilDay('2026-11-05', NOW, 90), { until: Date.UTC(2026, 10, 5, 19, 0) });
  assert.ok('error' in parseUntilDay('2027-06-01', NOW, 90));
});

test('plan in words and tones: «оплачено до», «без срока», «оплата закончилась»; filters', () => {
  const until = Date.UTC(2026, 11, 12, 19, 0);
  const paid = trial({ plan: 'paid', paidUntil: until, endsAt: until });
  assert.equal(trialTermText(paid, NOW), 'оплачено до 12 декабря');
  assert.equal(trialTone(paid, NOW), 'ok');
  assert.equal(trialTone(paid, until - 3 * DAY), 'warn', 'a week before the end');
  assert.equal(trialTermText(paid, until + DAY), 'оплата закончилась 12 декабря');
  assert.equal(trialTone(paid, until + DAY), 'danger');
  const forever = trial({ plan: 'paid', paidUntil: null, endsAt: Date.UTC(2100, 0, 1) });
  assert.equal(trialTermText(forever, NOW), 'без срока');
  assert.equal(trialTone(forever, NOW), 'ok');
  assert.equal(trialTermText(trial({ plan: 'paid', status: 'ended', endsAt: NOW - DAY }), NOW), 'доступ закрыт досрочно');

  const list = [trial({ id: 'a' }), paid, forever, trial({ id: 'old', status: 'ended', endsAt: NOW - DAY, lastSeenAt: NOW - 3 * DAY })];
  const ids = (f: Parameters<typeof filterTrials>[1]) => filterTrials(list, f, NOW).map((t) => t.id + (t.plan === 'paid' ? (t.paidUntil ? ':p' : ':f') : ''));
  assert.equal(filterTrials(list, 'all', NOW).length, 4);
  assert.deepEqual(ids('trial'), ['a', 'old']);
  assert.deepEqual(ids('paid'), ['t1:p', 't1:f']);
  assert.deepEqual(ids('over'), ['old']);
  assert.equal(filterTrials(list, 'live', NOW).length, 3);
});
