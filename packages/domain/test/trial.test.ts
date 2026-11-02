import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TrialStats } from '../src/trial.ts';
import {
  cleanTrialStats,
  isTrialInstallId,
  isTrialStatus,
  legacyTrialTerms,
  parseTrialTerms,
  TRIAL_ENDED_MESSAGE,
  TRIAL_EXPIRED_MESSAGE,
  TRIAL_LEGACY_STATUSES,
  TRIAL_PENDING_LEGACY_MESSAGE,
  TRIAL_PERMANENT_LEGACY_ENDS_AT,
  TRIAL_REJECTED_MESSAGE,
  TRIAL_DELETED_MESSAGE,
  TRIAL_IDLE_CHECK_MS,
  TRIAL_PENDING_CHECK_MS,
  TRIAL_PERMANENT_LICENSE_UNTIL,
  TRIAL_RELOAD_ID,
  trialCheckEveryMs,
  trialDuplicates,
  trialGoneTerms,
  trialNameKey,
  trialPageLicense,
  trialPageOver,
  trialWithoutReloadLink,
  trialRejectMessage,
  trialRequestLine,
  trialWaiting,
  trialZoneCity,
  trialCalendarDay,
  trialDayEnd,
  trialEndDate,
  trialEndDateRange,
  trialStartedAt,
  trialStatus,
  trialTerms,
  trialTimeZone,
  validateTrialStats,
} from '../src/trial.ts';

const DAY = 86_400_000;

const STATS: TrialStats = {
  ordersTotal: 12,
  ordersToday: 3,
  revenueTotal: 45_600,
  revenueToday: 9_800.5,
  productsCount: 18,
  staffCount: 2,
  shiftOpen: true,
  lastOrderAt: 1_760_270_400_000,
  days: [
    { day: '2026-10-28', orders: 9, revenue: 35_800 },
    { day: '2026-10-29', orders: 3, revenue: 9_800.5 },
  ],
  appVersion: '1.4.0',
};

test('validateTrialStats: a full report is fine, with or without appVersion and lastOrderAt', () => {
  assert.deepEqual(validateTrialStats(STATS), []);
  const { appVersion: _v, ...noVersion } = STATS;
  assert.deepEqual(validateTrialStats({ ...noVersion, lastOrderAt: null, days: [] }), []);
});

test('validateTrialStats: names every broken field', () => {
  assert.deepEqual(validateTrialStats(null), ['stats: нужен объект']);
  assert.deepEqual(validateTrialStats([]), ['stats: нужен объект']);
  const problems = validateTrialStats({
    ...STATS,
    ordersTotal: -1,
    ordersToday: 1.5,
    revenueTotal: Number.NaN,
    revenueToday: '10',
    productsCount: undefined,
    shiftOpen: 1,
    lastOrderAt: 'вчера',
    appVersion: 'x'.repeat(41),
  });
  for (const field of ['ordersTotal', 'ordersToday', 'revenueTotal', 'revenueToday', 'productsCount', 'shiftOpen', 'lastOrderAt', 'appVersion']) {
    assert.ok(problems.some((p) => p.startsWith(`stats.${field}`)), field);
  }
  assert.ok(!problems.some((p) => p.startsWith('stats.staffCount')));
  const days = validateTrialStats({ ...STATS, days: [{ day: '29.10.2026', orders: 1, revenue: 1 }, { day: '2026-10-29', orders: -2, revenue: Infinity }, 5] });
  assert.deepEqual(days, [
    'stats.days[0].day: дата YYYY-MM-DD',
    'stats.days[1].orders: целое число ≥ 0',
    'stats.days[1].revenue: число',
    'stats.days[2]: нужен объект',
  ]);
  assert.deepEqual(validateTrialStats({ ...STATS, days: 'all' }), ['stats.days: нужен список']);
  assert.equal(validateTrialStats({ ...STATS, days: Array.from({ length: 401 }, () => STATS.days[0]) }).length, 1);
});

test('cleanTrialStats drops unknown fields', () => {
  const dirty = { ...STATS, secret: 'x', days: [{ ...STATS.days[0]!, extra: 1 }] } as unknown as TrialStats;
  const clean = cleanTrialStats(dirty);
  assert.equal('secret' in clean, false);
  assert.deepEqual(clean.days, [STATS.days[0]]);
  assert.deepEqual(cleanTrialStats(STATS), STATS);
});

test('trialStatus: active until endsAt, then expired; ended stays ended', () => {
  const endsAt = 1_000_000;
  assert.equal(trialStatus({ status: 'active', endsAt }, endsAt - 1), 'active');
  assert.equal(trialStatus({ status: 'active', endsAt }, endsAt), 'expired');
  assert.equal(trialStatus({ status: 'active', endsAt }, endsAt + 1), 'expired');
  assert.equal(trialStatus({ status: 'ended', endsAt }, endsAt - 1), 'ended');
  assert.equal(trialStatus({ status: 'ended', endsAt }, endsAt + 1), 'ended');
});

test('trialStatus: a request (pending), a rejected one and a permanent one stay as stored, whatever endsAt says', () => {
  for (const status of ['pending', 'rejected', 'permanent'] as const) {
    assert.equal(trialStatus({ status, endsAt: 10 }, 5), status);
    assert.equal(trialStatus({ status, endsAt: 10 }, 50), status);
  }
  assert.equal(trialStatus({ status: 'something new', endsAt: 10 }, 5), 'active', 'an unknown stored word counts as active');
  assert.ok(trialWaiting('pending') && trialWaiting('rejected'));
  assert.ok(!trialWaiting('active') && !trialWaiting('permanent') && !trialWaiting(undefined));
  assert.ok(isTrialStatus('permanent') && !isTrialStatus('paused') && !isTrialStatus(1));
});

test('trialTerms / legacyTrialTerms: the page reads every status; an old page only active / ended / expired', () => {
  assert.deepEqual(trialTerms({ status: 'pending', endsAt: 10 }, 5), { status: 'pending', endsAt: 10 });
  assert.deepEqual(trialTerms({ status: 'permanent', endsAt: 1 }, 5), { status: 'permanent', endsAt: 1 });
  assert.deepEqual(trialTerms({ status: 'rejected', endsAt: 10, ownerMessage: '  у вас уже есть пробная  ' }, 5), { status: 'rejected', endsAt: 10, message: 'у вас уже есть пробная' });
  assert.deepEqual(trialTerms({ status: 'rejected', endsAt: 10, ownerMessage: '  ' }, 5), { status: 'rejected', endsAt: 10 });

  const now = 1000;
  assert.deepEqual(legacyTrialTerms({ status: 'permanent', endsAt: 1 }, now), { status: 'active', endsAt: TRIAL_PERMANENT_LEGACY_ENDS_AT });
  assert.deepEqual(legacyTrialTerms({ status: 'pending', endsAt: 5000 }, now), { status: 'ended', endsAt: now, message: TRIAL_PENDING_LEGACY_MESSAGE });
  assert.deepEqual(legacyTrialTerms({ status: 'rejected', endsAt: 5000, message: 'нет' }, now), { status: 'ended', endsAt: now, message: 'нет' });
  assert.deepEqual(legacyTrialTerms({ status: 'rejected', endsAt: 5000 }, now), { status: 'ended', endsAt: now, message: TRIAL_REJECTED_MESSAGE });
  const active = { status: 'active', endsAt: 5000 } as const;
  assert.equal(legacyTrialTerms(active, now), active);
  for (const status of ['pending', 'active', 'ended', 'expired', 'rejected', 'permanent'] as const) {
    assert.ok(TRIAL_LEGACY_STATUSES.includes(legacyTrialTerms(trialTerms({ status, endsAt: 5000 }, now), now).status), status);
  }
  assert.ok(new Date(TRIAL_PERMANENT_LEGACY_ENDS_AT).getUTCFullYear() >= 2100);
});

test('parseTrialTerms: what the current page accepts from the cloud', () => {
  assert.deepEqual(parseTrialTerms({ status: 'pending', endsAt: 5, junk: 1 }), { status: 'pending', endsAt: 5 });
  assert.deepEqual(parseTrialTerms({ status: 'rejected', endsAt: 5, message: '  нет  ' }), { status: 'rejected', endsAt: 5, message: 'нет' });
  assert.deepEqual(parseTrialTerms({ status: 'permanent', endsAt: 5, message: '' }), { status: 'permanent', endsAt: 5 });
  for (const body of [null, 'x', [], { status: 'paused', endsAt: 5 }, { status: 'active' }, { status: 'active', endsAt: Infinity }, { status: 'active', endsAt: '5' }]) {
    assert.equal(parseTrialTerms(body), null, JSON.stringify(body));
  }
});

test('isTrialInstallId and trialRejectMessage', () => {
  assert.ok(isTrialInstallId('AbCdEf0123456789_-xy'));
  assert.ok(!isTrialInstallId('short'));
  assert.ok(!isTrialInstallId('x'.repeat(65)));
  assert.ok(!isTrialInstallId('пробел и кириллица 0123456789'));
  assert.ok(!isTrialInstallId(1234567890123456));
  assert.equal(trialRejectMessage(undefined), null);
  assert.equal(trialRejectMessage('   '), null);
  assert.equal(trialRejectMessage('  откройте там, где начинали '), 'откройте там, где начинали');
  assert.equal(trialRejectMessage('x'.repeat(301)), undefined);
  assert.equal(trialRejectMessage(5), undefined);
});

test('trialDuplicates: the earliest earlier trial with the same venue, or the same manager from the same address', () => {
  const row = (id: string, venue: string, managerName: string, ip: string | null, createdAt: number) => ({
    id,
    venue,
    managerName,
    ip,
    status: 'pending' as const,
    startedAt: createdAt,
    createdAt,
  });
  assert.equal(trialNameKey('  Coffee   BOOK '), 'coffee book');
  const dups = trialDuplicates([
    row('c', 'coffee book ', 'Аиша', '1.1.1.2', 3),
    row('a', 'Coffee book', 'Аиша', '1.1.1.1', 1),
    row('b', 'COFFEE  BOOK', '', '1.1.1.3', 2),
    row('d', 'Кофе Тау', 'аиша', '1.1.1.1', 4),
    row('e', 'Другая', 'Аиша', '1.1.1.9', 5),
    row('f', 'Ещё', '', '1.1.1.1', 6),
    row('g', 'Без адреса', 'Аиша', null, 7),
  ]);
  assert.equal(dups.get('a'), undefined, 'the first one is the original');
  assert.equal(dups.get('b')?.id, 'a');
  assert.equal(dups.get('c')?.id, 'a');
  assert.deepEqual(dups.get('d'), { id: 'a', venue: 'Coffee book', managerName: 'Аиша', status: 'pending', startedAt: 1 });
  assert.equal(dups.get('e'), undefined, 'same name, another address');
  assert.equal(dups.get('f'), undefined, 'no manager name: the address alone is not enough');
  assert.equal(dups.get('g'), undefined);
});

test('trialRequestLine: «venue» · manager · city of the zone', () => {
  assert.equal(trialRequestLine({ venue: 'coffee book', managerName: 'Аиша', timezone: 'Asia/Almaty' }), '«coffee book» · Аиша · Алматы');
  assert.equal(trialRequestLine({ venue: 'Тау', managerName: ' ', timezone: 'Mars/Olympus' }), '«Тау»');
  assert.equal(trialZoneCity('Asia/Qostanay'), 'Костанай');
  assert.equal(trialZoneCity(null), null);
});

test('the page: how often it asks, when it is over, its license, a reload link from an old page, a deleted request', () => {
  const now = Date.UTC(2026, 10, 2, 7);
  // A request: every 30 s on screen, every 5 min hidden; rejected: every 5 min; a trial: as it reports.
  assert.equal(trialCheckEveryMs('pending', true, 300_000), TRIAL_PENDING_CHECK_MS);
  assert.equal(trialCheckEveryMs('pending', false, 60_000), TRIAL_IDLE_CHECK_MS);
  assert.equal(trialCheckEveryMs('rejected', true, 60_000), TRIAL_IDLE_CHECK_MS);
  assert.equal(trialCheckEveryMs('active', true, 60_000), 60_000);
  assert.equal(trialCheckEveryMs(undefined, false, 300_000), 300_000);

  const started = now - 3 * DAY;
  assert.equal(trialPageOver({ startedAt: started }, now), false);
  assert.equal(trialPageOver({ startedAt: now - 14 * DAY }, now), true, 'startedAt + 14 days before the cloud answered');
  assert.equal(trialPageOver({ startedAt: started, endsAt: now - 1, status: 'active' }, now), true);
  assert.equal(trialPageOver({ startedAt: started, endsAt: now - 1, status: 'permanent' }, now), false);
  assert.equal(trialPageOver({ startedAt: started, endsAt: now - 1, status: 'pending' }, now), false);
  assert.equal(trialPageOver({ startedAt: started, endsAt: now + DAY, status: 'ended' }, now), true);

  assert.deepEqual(trialPageLicense({ startedAt: started }, now), { validUntil: started + 14 * DAY, permanent: false });
  assert.deepEqual(trialPageLicense({ startedAt: started, endsAt: now + 20 * DAY, status: 'active' }, now), { validUntil: now + 20 * DAY, permanent: false });
  for (const status of ['pending', 'rejected', 'ended', 'expired'] as const) {
    assert.deepEqual(trialPageLicense({ startedAt: started, endsAt: now + 9 * DAY, status }, now), { validUntil: now, permanent: false }, status);
  }
  assert.deepEqual(trialPageLicense({ startedAt: started, status: 'pending' }, now), { validUntil: now, permanent: false }, 'a new request: read-only at once');
  assert.deepEqual(trialPageLicense({ startedAt: started, endsAt: now - DAY, status: 'permanent' }, now), {
    validUntil: TRIAL_PERMANENT_LICENSE_UNTIL,
    permanent: true,
  });

  const fromOldPage = { startedAt: started, venue: 'Coffee book', cloudId: TRIAL_RELOAD_ID, cloudToken: 'reload', status: 'ended' as const, endsAt: now, message: 'Обновите…' };
  assert.deepEqual(trialWithoutReloadLink(fromOldPage), { startedAt: started, venue: 'Coffee book', status: 'pending' });
  const linked = { startedAt: started, cloudId: '11111111-1111-4111-8111-111111111111', cloudToken: 't', status: 'active' as const };
  assert.equal(trialWithoutReloadLink(linked), linked);

  assert.deepEqual(trialGoneTerms({ startedAt: started, status: 'pending', endsAt: now + DAY }, now), { status: 'rejected', endsAt: now + DAY, message: TRIAL_DELETED_MESSAGE });
  assert.equal(trialGoneTerms({ startedAt: started, status: 'ended' }, now), null);
  assert.equal(trialGoneTerms({ startedAt: started, status: 'active' }, now), null, 'a running trial never locks itself on a 404');
});

test('trialTerms: a message only when the trial is over', () => {
  assert.deepEqual(trialTerms({ status: 'active', endsAt: 10 }, 5), { status: 'active', endsAt: 10 });
  assert.deepEqual(trialTerms({ status: 'active', endsAt: 10 }, 10), { status: 'expired', endsAt: 10, message: TRIAL_EXPIRED_MESSAGE });
  assert.deepEqual(trialTerms({ status: 'ended', endsAt: 3 }, 5), { status: 'ended', endsAt: 3, message: TRIAL_ENDED_MESSAGE });
  assert.equal(TRIAL_ENDED_MESSAGE, 'Пробный период завершён. Свяжитесь с TS, чтобы продолжить.');
});

test('trialStartedAt: the browser start, never in the future, at most 60 days back; now when missing', () => {
  const now = Date.UTC(2026, 10, 2, 7);
  assert.equal(trialStartedAt(undefined, now), now);
  assert.equal(trialStartedAt(null, now), now);
  assert.equal(trialStartedAt(now - 2 * DAY, now), now - 2 * DAY);
  assert.equal(trialStartedAt(now - 2 * DAY + 0.7, now), now - 2 * DAY, 'whole ms');
  assert.equal(trialStartedAt(now + 5 * DAY, now), now, 'a clock ahead does not start the trial in the future');
  assert.equal(trialStartedAt(now - 60 * DAY, now), now - 60 * DAY);
  assert.equal(trialStartedAt(now - 400 * DAY, now), now - 60 * DAY);
  assert.equal(trialStartedAt(0, now), now - 60 * DAY);
  for (const bad of ['1730000000000', -1, Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
    assert.equal(trialStartedAt(bad, now), null, String(bad));
  }
});

test('trialTimeZone: the trial’s own valid zone, else Almaty', () => {
  assert.equal(trialTimeZone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(trialTimeZone(null), 'Asia/Almaty');
  assert.equal(trialTimeZone(''), 'Asia/Almaty');
  assert.equal(trialTimeZone('Mars/Olympus'), 'Asia/Almaty');
});

test('trialDayEnd: the last millisecond of the calendar day in the zone (DST included)', () => {
  // Almaty is UTC+5: the 14th ends at 19:00 UTC.
  assert.equal(trialDayEnd('2026-11-14', 'Asia/Almaty'), Date.UTC(2026, 10, 14, 19) - 1);
  assert.equal(trialCalendarDay(trialDayEnd('2026-11-14', 'Asia/Almaty'), 'Asia/Almaty'), '2026-11-14');
  assert.equal(trialCalendarDay(trialDayEnd('2026-11-14', 'Asia/Almaty') + 1, 'Asia/Almaty'), '2026-11-15');
  assert.equal(trialDayEnd('2026-11-14', 'Pacific/Honolulu'), Date.UTC(2026, 10, 15, 10) - 1);
  // Berlin leaves summer time on 25 Oct 2026: the 24th ends at 22:00 UTC, the 25th at 23:00 UTC.
  assert.equal(trialDayEnd('2026-10-24', 'Europe/Berlin'), Date.UTC(2026, 9, 24, 22) - 1);
  assert.equal(trialDayEnd('2026-10-25', 'Europe/Berlin'), Date.UTC(2026, 9, 25, 23) - 1);
  assert.equal(trialDayEnd('2026-12-31', 'Asia/Almaty'), Date.UTC(2026, 11, 31, 19) - 1, 'across the year');
});

test('trialEndDate: today … today + 90 days in the trial’s zone, a real calendar date', () => {
  // 07:00 UTC on 2 Nov: already 12:00 in Almaty, still 21:00 on 1 Nov in Honolulu.
  const now = Date.UTC(2026, 10, 2, 7);
  assert.deepEqual(trialEndDateRange(now, 'Asia/Almaty'), { min: '2026-11-02', max: '2027-01-31' });
  assert.deepEqual(trialEndDateRange(now, 'Pacific/Honolulu'), { min: '2026-11-01', max: '2027-01-30' });
  assert.equal(trialEndDate('2026-11-02', now, 'Asia/Almaty'), '2026-11-02');
  assert.equal(trialEndDate('2027-01-31', now, 'Asia/Almaty'), '2027-01-31');
  assert.equal(trialEndDate('2027-02-01', now, 'Asia/Almaty'), null);
  assert.equal(trialEndDate('2026-11-01', now, 'Asia/Almaty'), null, 'yesterday in Almaty');
  assert.equal(trialEndDate('2026-11-01', now, 'Pacific/Honolulu'), '2026-11-01', 'still today in Honolulu');
  for (const bad of ['2026-11-31', '2026-13-01', '14.11.2026', '2026-11-5', '', null, undefined, 20261114]) {
    assert.equal(trialEndDate(bad, now, 'Asia/Almaty'), null, String(bad));
  }
});
