import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrialView } from '../src/trials.ts';
import {
  agoText,
  bytesText,
  effectiveStatus,
  endDateDefault,
  endDateRange,
  endDateText,
  isWorkingNow,
  lastDays,
  lastOrderText,
  lastSeenText,
  latinName,
  parseEndDate,
  parseExtendDays,
  trialBackup,
  trialBackupFileName,
  trialDate,
  trialDay,
  trialDaysLeft,
  trialEndText,
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
    timezone: 'Asia/Almaty',
    startedAt: NOW - 3 * DAY,
    endsAt: NOW + 11 * DAY,
    status: 'active',
    lastSeenAt: NOW - 2 * MIN,
    stats: null,
    snapshotAt: null,
    snapshotBytes: null,
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

test('dates in the trial’s own zone; the end in words', () => {
  // 18:30 UTC on 1 Nov is already 2 Nov in Almaty, still 1 Nov in Honolulu.
  const at = Date.UTC(2026, 10, 1, 18, 30);
  assert.equal(trialDate(at), '1 ноября');
  assert.equal(trialDate(at, 'Asia/Almaty'), '1 ноября');
  assert.equal(trialDate(Date.UTC(2026, 10, 1, 19, 30), 'Asia/Almaty'), '2 ноября');
  assert.equal(trialDate(Date.UTC(2026, 10, 1, 19, 30), 'Pacific/Honolulu'), '1 ноября');
  assert.equal(trialTermText(trial({ timezone: 'Pacific/Honolulu', endsAt: Date.UTC(2026, 10, 9, 5) }), NOW), 'осталось 11 дней · до 8 ноября');
  // A date set in the cabinet runs through the whole day; a 14-day term ends at the hour it began.
  assert.equal(trialEndText(trial({ endsAt: Date.UTC(2026, 10, 14, 19) - 1 })), '14 ноября, до конца дня');
  assert.equal(trialEndText(trial({ endsAt: Date.UTC(2026, 10, 12, 9, 30) })), '12 ноября, 14:30');
  assert.equal(trialEndText(trial({ timezone: 'Pacific/Honolulu', endsAt: Date.UTC(2026, 10, 15, 10) - 1 })), '14 ноября, до конца дня');
});

test('«Дата окончания»: today … today + 90 days in the trial’s zone', () => {
  assert.deepEqual(endDateRange(NOW, 'Asia/Almaty'), { min: '2026-10-29', max: '2027-01-27' });
  // 07:00 UTC is 21:00 of the day before in Honolulu.
  assert.deepEqual(endDateRange(NOW, 'Pacific/Honolulu'), { min: '2026-10-28', max: '2027-01-26' });
  assert.equal(parseEndDate(' 2026-11-14 ', NOW, 'Asia/Almaty'), '2026-11-14');
  assert.equal(parseEndDate('2026-10-29', NOW, 'Asia/Almaty'), '2026-10-29');
  assert.equal(parseEndDate('2026-10-28', NOW, 'Asia/Almaty'), null);
  assert.equal(parseEndDate('2026-10-28', NOW, 'Pacific/Honolulu'), '2026-10-28');
  assert.equal(parseEndDate('2027-01-28', NOW, 'Asia/Almaty'), null);
  assert.equal(parseEndDate('', NOW, 'Asia/Almaty'), null);
  // The picker opens at the trial's last day, or today when that day can no longer be chosen.
  assert.equal(endDateDefault(trial(), NOW), '2026-11-09');
  assert.equal(endDateDefault(trial({ endsAt: NOW - 3 * DAY }), NOW), '2026-10-29');
  assert.equal(endDateDefault(trial({ endsAt: NOW + 200 * DAY }), NOW), '2026-10-29');
  assert.equal(endDateText('2026-11-14'), '14 ноября');
  assert.equal(endDateText('2027-01-01'), '1 января');
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
