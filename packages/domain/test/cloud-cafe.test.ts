import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudCafeUrl, cloudTermsOf, parseTrialCloudInfo } from '../src/cloud-cafe.ts';
import { codesToReport, directorKeyFrom, isDirectorKey, isDirectorSignInKey, parseReportCodes } from '../src/trial-codes.ts';
import {
  canMarkPaid,
  paidAmountOf,
  paidDaysLeft,
  paidEndsSoon,
  paidNoteOf,
  parsePaidAmount,
  trialPaidEndsAt,
  trialPaidRange,
  trialPaidUntil,
  trialTermsForVersion,
} from '../src/trial-paid.ts';
import { TRIAL_ENDED_MESSAGE, TRIAL_PAID_ENDED_MESSAGE, TRIAL_PERMANENT_LEGACY_ENDS_AT, trialDayEnd, trialPageLicense, trialStatus, trialTerms } from '../src/trial.ts';

const NOW = Date.UTC(2026, 10, 3, 7, 0); // 3 November 2026, 12:00 in Almaty
const DAY = 86_400_000;

test('cloud café: the link, the terms for the Worker, the page’s `cloud` field', () => {
  assert.equal(cloudCafeUrl('https://hub.ts.kz/', 'K7F392QXM4P8'), 'https://hub.ts.kz/#/cafe/K7F392QXM4P8');
  assert.deepEqual(cloudTermsOf({ status: 'active', endsAt: 5 }), { status: 'active', endsAt: 5, message: null });
  assert.deepEqual(cloudTermsOf({ status: 'paid', endsAt: 9 }), { status: 'active', endsAt: 9, message: null }, 'paid needs no new Worker status');
  assert.deepEqual(cloudTermsOf({ status: 'permanent', endsAt: 5 }), { status: 'permanent', endsAt: null, message: null });
  assert.deepEqual(cloudTermsOf({ status: 'ended', endsAt: 5, message: TRIAL_ENDED_MESSAGE }), { status: 'ended', endsAt: 5, message: TRIAL_ENDED_MESSAGE });
  assert.deepEqual(cloudTermsOf({ status: 'expired', endsAt: 5, message: 'x' }), { status: 'ended', endsAt: 5, message: 'x' });
  assert.deepEqual(parseTrialCloudInfo({ code: 'K7F392QXM4P8', url: 'https://hub/#/cafe/K7F392QXM4P8', managerKey: '482913' }), {
    code: 'K7F392QXM4P8',
    url: 'https://hub/#/cafe/K7F392QXM4P8',
    managerKey: '482913',
  });
  assert.deepEqual(parseTrialCloudInfo({ code: 'K7F392QXM4P8', url: 'javascript:alert(1)' }), { code: 'K7F392QXM4P8', url: null });
  assert.equal(parseTrialCloudInfo({ code: '<script>' }), null);
  assert.equal(parseTrialCloudInfo(null), null);
});

test('codes: director keys TS issues and accepts, the report part, only what changed', () => {
  assert.equal(isDirectorKey('482913'), true);
  assert.equal(isDirectorKey('123456'), false, 'weak');
  assert.equal(isDirectorKey('48291'), false);
  assert.equal(isDirectorSignInKey('MGR-ABCD-EFGH-JKMN-PQRS'), true);
  assert.equal(isDirectorSignInKey('mgr-abcd-efgh-jkmn-pqrs'), false, 'canonical only');
  const key = directorKeyFrom(Array.from({ length: 48 }, (_, i) => (i * 37) % 256));
  assert.ok(key && isDirectorKey(key));
  assert.equal(directorKeyFrom(new Array(48).fill(0)), null, 'all weak: none');
  assert.deepEqual(parseReportCodes({ cafeCode: 'k7f3-92qx-m4p8', directorKey: '482913', junk: 1 }), { cafeCode: 'K7F392QXM4P8', directorKey: '482913' });
  assert.deepEqual(parseReportCodes({ directorKey: '111111', directorKeyStale: true }), { directorKeyStale: true });
  assert.equal(parseReportCodes({ cafeCode: 'nope' }), null);
  assert.equal(parseReportCodes('x'), null);
  assert.deepEqual(codesToReport({ cafeCode: 'A', directorKey: '482913' }, null), { cafeCode: 'A', directorKey: '482913' });
  assert.equal(codesToReport({ cafeCode: 'A', directorKey: '482913' }, { cafeCode: 'A', directorKey: '482913' }), null);
  assert.deepEqual(codesToReport({ cafeCode: 'A', directorKeyStale: true }, { cafeCode: 'A', directorKey: '482913' }), { directorKeyStale: true });
  assert.equal(codesToReport({ directorKeyStale: true }, { directorKeyStale: true }), null);
});

test('«Купили»: the paid date, the amount and note, the status, the reminder window', () => {
  const zone = 'Asia/Almaty';
  const { min, max } = trialPaidRange(NOW, zone);
  assert.equal(min, '2026-11-03');
  assert.equal(max, '2029-11-05', '3 × 366 days');
  assert.equal(trialPaidUntil('2026-11-03', NOW, zone), '2026-11-03');
  assert.equal(trialPaidUntil('2026-11-02', NOW, zone), null);
  assert.equal(trialPaidUntil('2029-11-05', NOW, zone), '2029-11-05');
  assert.equal(trialPaidUntil('2029-11-06', NOW, zone), null);
  assert.equal(trialPaidUntil('2027-02-29', NOW, zone), null);
  assert.equal(trialPaidEndsAt('2026-12-01', zone), trialDayEnd('2026-12-01', zone));
  assert.equal(parsePaidAmount(' 150 000 ₸'), 15_000_000);
  assert.equal(parsePaidAmount('99,5'), 9_950);
  assert.equal(parsePaidAmount(''), null);
  assert.equal(parsePaidAmount('сто'), undefined);
  assert.equal(parsePaidAmount('0'), undefined);
  assert.equal(paidAmountOf(500), 500);
  assert.equal(paidAmountOf(null), null);
  assert.equal(paidAmountOf(-1), undefined);
  assert.equal(paidNoteOf('  Kaspi '), 'Kaspi');
  assert.equal(paidNoteOf(''), null);
  assert.equal(paidNoteOf('x'.repeat(501)), undefined);
  assert.equal(canMarkPaid('expired'), true);
  assert.equal(canMarkPaid('pending'), false);

  const endsAt = NOW + 10 * DAY;
  assert.equal(trialStatus({ status: 'paid', endsAt }, NOW), 'paid');
  assert.equal(trialStatus({ status: 'paid', endsAt }, endsAt + 1), 'expired');
  assert.deepEqual(trialTerms({ status: 'paid', endsAt }, endsAt + 1), { status: 'expired', endsAt, message: TRIAL_PAID_ENDED_MESSAGE });
  assert.equal(paidDaysLeft(endsAt, NOW), 10);
  assert.equal(paidDaysLeft(endsAt, endsAt), 0);
  assert.equal(paidEndsSoon({ status: 'paid', endsAt }, NOW), false);
  assert.equal(paidEndsSoon({ status: 'paid', endsAt }, NOW + 4 * DAY), true);
  assert.equal(paidEndsSoon({ status: 'active', endsAt }, NOW + 4 * DAY), false);
  // The café's license: the full version until the end of the paid day.
  assert.deepEqual(trialPageLicense({ startedAt: NOW - DAY, status: 'paid', endsAt }, NOW), { validUntil: endsAt, permanent: true });
});

test('«Купили»: the terms in each page’s words — v3 all, v2 paid as active, older pages legacy', () => {
  const paid = { status: 'paid' as const, endsAt: NOW + DAY };
  assert.deepEqual(trialTermsForVersion(paid, 3, NOW), paid);
  assert.deepEqual(trialTermsForVersion(paid, '2', NOW), { status: 'active', endsAt: NOW + DAY });
  assert.deepEqual(trialTermsForVersion(paid, undefined, NOW), { status: 'active', endsAt: NOW + DAY });
  assert.deepEqual(trialTermsForVersion({ status: 'permanent', endsAt: 1 }, 2, NOW), { status: 'permanent', endsAt: 1 });
  assert.deepEqual(trialTermsForVersion({ status: 'permanent', endsAt: 1 }, null, NOW), { status: 'active', endsAt: TRIAL_PERMANENT_LEGACY_ENDS_AT });
  assert.equal(trialTermsForVersion({ status: 'pending', endsAt: 1 }, 2, NOW).status, 'pending');
  assert.equal(trialTermsForVersion({ status: 'pending', endsAt: 1 }, null, NOW).status, 'ended');
});
