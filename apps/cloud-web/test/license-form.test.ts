import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LicensePayload, LicenseView } from '@bills/domain';
import { licenseStatus } from '@bills/domain';
import {
  branchesUsage,
  buildTermsRequest,
  canAddBranch,
  clubLimitText,
  describeCabinetError,
  draftFromLicense,
  emptyLicenseDraft,
  isKeyLive,
  keyStateText,
  kzIsoDate,
  lastLicenseDay,
  licenseTermText,
  licenseTone,
  modulesText,
  shortKeyProblem,
  termPreview,
} from '../src/license-form.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 19, 6, 0, 0); // 19.10.2026 11:00 Almaty

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    id: 'lic1',
    companyId: 'c1',
    companyName: 'Клуб',
    plan: 'paid',
    issuedAt: NOW - 10 * DAY,
    validFrom: NOW - 10 * DAY,
    validUntil: NOW + 40 * DAY,
    maxClubs: 2,
    maxTables: null,
    maxStaff: 10,
    modules: { bar: true, cloud: true, hardware: false },
    hubIds: [],
    blocked: false,
    ...over,
  };
}

function view(over: Partial<LicensePayload> = {}, now = NOW): LicenseView {
  const p = payload(over);
  return { payload: p, status: licenseStatus(p, now), signed: 'TS1.dev.x.y' };
}

test('licenseTone: colour by state', () => {
  assert.equal(licenseTone('active'), 'ok');
  assert.equal(licenseTone('expiring'), 'warn');
  assert.equal(licenseTone('last_day'), 'danger');
  assert.equal(licenseTone('expired'), 'danger');
  assert.equal(licenseTone('blocked'), 'danger');
  assert.equal(licenseTone('missing'), 'muted');
  assert.equal(licenseTone(null), 'muted');
});

test('licenseTermText: date, days left, last day, expired', () => {
  assert.match(licenseTermText(view().status), /^до \d\d\.\d\d\.2026 · осталось 40 дней$/);
  assert.match(licenseTermText(view({ validUntil: NOW + 2 * DAY }).status), /осталось 2 дня/);
  assert.match(licenseTermText(view({ validUntil: NOW + 3_600_000 }).status), /последний день/);
  assert.match(licenseTermText(view({ validUntil: NOW - DAY }).status), /^истекла /);
  assert.equal(licenseTermText(licenseStatus(null, NOW)), 'нет лицензии');
});

test('lastLicenseDay and kzIsoDate use Almaty time (UTC+5)', () => {
  // validUntil = end of 31.12.2026 in UTC+5 → the last day shown is 31.12.2026.
  const end = Date.UTC(2027, 0, 1) - 5 * 3_600_000;
  assert.equal(lastLicenseDay(end), '31.12.2026');
  assert.equal(kzIsoDate(Date.UTC(2026, 11, 31, 20, 0)), '2027-01-01');
});

test('modulesText, branchesUsage, clubLimitText', () => {
  assert.equal(modulesText({ bar: true, cloud: true, hardware: false }), 'Бар и меню, облако и отчёты сети');
  assert.equal(modulesText({ bar: false, cloud: false, hardware: false }), 'без модулей');
  assert.equal(modulesText(null), '—');
  assert.equal(branchesUsage(1, 3), '1 из 3');
  assert.equal(branchesUsage(1, undefined), '1');
  assert.equal(clubLimitText(1), 'Лимит лицензии: 1 филиал');
  assert.equal(clubLimitText(3), 'Лимит лицензии: 3 филиала');
  assert.equal(clubLimitText(5), 'Лимит лицензии: 5 филиалов');
});

test('canAddBranch: limit and read-only', () => {
  const s = view({ maxClubs: 2 }).status;
  assert.equal(canAddBranch(1, s), true);
  assert.equal(canAddBranch(2, s), false);
  assert.equal(canAddBranch(0, view({ validUntil: NOW - DAY }).status), false);
  assert.equal(canAddBranch(0, null), false);
});

test('buildTermsRequest: a new trial client', () => {
  const r = buildTermsRequest({ ...emptyLicenseDraft(), term: 'trial3', maxClubs: '1' }, NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.request, {
    term: { kind: 'trial', days: 3 },
    plan: 'trial',
    maxClubs: 1,
    maxTables: null,
    maxStaff: null,
    modules: { bar: true, cloud: true, hardware: true },
  });
});

test('buildTermsRequest: months, limits, modules', () => {
  const r = buildTermsRequest(
    { ...emptyLicenseDraft(), term: 'months', months: '6', maxClubs: '3', maxTables: '12', maxStaff: '20', modules: { bar: false, cloud: true, hardware: true } },
    NOW,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.request.term, { kind: 'months', months: 6 });
  assert.equal(r.request.plan, 'paid');
  assert.equal(r.request.maxClubs, 3);
  assert.equal(r.request.maxTables, 12);
  assert.equal(r.request.maxStaff, 20);
  assert.equal(r.request.modules.bar, false);
  assert.equal('fromCurrentEnd' in r.request, false);
});

test('buildTermsRequest: bad input is refused in Russian', () => {
  const bad = (patch: Parameters<typeof buildTermsRequest>[0] extends infer D ? Partial<D> : never) =>
    buildTermsRequest({ ...emptyLicenseDraft(), ...patch }, NOW);
  assert.equal(bad({ term: 'months', months: '0' }).ok, false);
  assert.equal(bad({ term: 'months', months: '37' }).ok, false);
  assert.equal(bad({ term: 'until', until: '' }).ok, false);
  const past = bad({ term: 'until', until: '2026-01-01' });
  assert.equal(past.ok, false);
  assert.ok(!past.ok && /будущем/.test(past.message));
  assert.equal(bad({ maxClubs: '0' }).ok, false);
  assert.equal(bad({ maxTables: 'abc' }).ok, false);
  assert.equal(bad({ maxStaff: '-1' }).ok, false);
});

test('buildTermsRequest: until a date', () => {
  const r = buildTermsRequest({ ...emptyLicenseDraft(), term: 'until', until: '2026-12-31' }, NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.request.term, { kind: 'until', date: '2026-12-31' });
});

test('buildTermsRequest: extension from the current end, or keeping the term', () => {
  const current = view();
  const draft = draftFromLicense(current);
  assert.equal(draft.maxClubs, '2');
  assert.equal(draft.maxStaff, '10');
  assert.equal(draft.maxTables, '');
  assert.equal(draft.modules.hardware, false);

  const ext = buildTermsRequest({ ...draft, term: 'months', months: '1' }, NOW, current);
  assert.ok(ext.ok);
  assert.equal(ext.request.fromCurrentEnd, true);

  const now = buildTermsRequest({ ...draft, fromCurrentEnd: false }, NOW, current);
  assert.ok(now.ok);
  assert.equal(now.request.fromCurrentEnd, false);

  const keep = buildTermsRequest({ ...draft, term: 'keep', maxClubs: '5' }, NOW, current);
  assert.ok(keep.ok);
  assert.deepEqual(keep.request.term, { kind: 'until', date: kzIsoDate(current.payload.validUntil - 1) });
  assert.equal(keep.request.fromCurrentEnd, false);
  assert.equal(keep.request.maxClubs, 5);

  assert.equal(buildTermsRequest({ ...emptyLicenseDraft(), term: 'keep' }, NOW, null).ok, false);
});

test('termPreview counts from the current end when extending', () => {
  const current = view({ validUntil: Date.UTC(2026, 10, 30, 19) }); // 01.12.2026 00:00 Almaty
  const draft = { ...draftFromLicense(current), term: 'trial7' as const };
  assert.equal(termPreview(draft, NOW, current), 'Доступ до 07.12.2026 включительно');
  assert.equal(termPreview({ ...draft, term: 'months', months: '' }, NOW, current), null);
});

test('shortKeyProblem: shape and weak keys before sending', () => {
  assert.equal(shortKeyProblem('527193'), null);
  assert.equal(shortKeyProblem('527 193'), null);
  assert.match(shortKeyProblem('12345') ?? '', /6 цифр/);
  assert.match(shortKeyProblem('123456') ?? '', /простой/);
  assert.match(shortKeyProblem('111111') ?? '', /простой/);
  assert.match(shortKeyProblem('121212') ?? '', /простой/);
});

test('keyStateText / isKeyLive', () => {
  assert.equal(keyStateText({ expiresAt: null, revokedAt: null }, NOW), 'бессрочный');
  assert.match(keyStateText({ expiresAt: NOW + DAY, revokedAt: null }, NOW), /^до /);
  assert.match(keyStateText({ expiresAt: NOW - DAY, revokedAt: null }, NOW), /^истёк /);
  assert.match(keyStateText({ expiresAt: null, revokedAt: NOW }, NOW), /^отозван /);
  assert.equal(isKeyLive({ expiresAt: null, revokedAt: null }, NOW), true);
  assert.equal(isKeyLive({ expiresAt: NOW - 1, revokedAt: null }, NOW), false);
  assert.equal(isKeyLive({ expiresAt: null, revokedAt: NOW }, NOW), false);
});

test('describeCabinetError: license and key codes in Russian', () => {
  assert.match(describeCabinetError({ code: 'KEY_WEAK', status: 422 }), /простой/);
  assert.match(describeCabinetError({ code: 'KEY_TAKEN', status: 409 }), /уже есть/);
  assert.match(describeCabinetError({ code: 'LICENSE_STAFF_LIMIT', status: 409 }), /Лимит лицензии/);
  assert.match(describeCabinetError({ code: 'LICENSE_CLUB_LIMIT', status: 409 }), /филиал/);
  assert.match(describeCabinetError({ code: 'LICENSE_READ_ONLY', status: 403 }), /только чтение/);
  assert.equal(describeCabinetError({ code: 'SOMETHING', message: 'Текст сервера' }), 'Текст сервера');
});
