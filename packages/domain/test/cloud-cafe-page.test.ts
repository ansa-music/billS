import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_CODE_HEADER,
  CLOUD_URL_HEADER,
  cloudFromHeaders,
  cloudHeaders,
  directorKeyDecision,
  directorKeyNextOf,
  mergeReportedCodes,
  movedToCloudOf,
  parseTrialCloudRecord,
  rememberSeenKey,
  trialCloudKeyToAck,
  trialCloudRecord,
  trialCloudScreen,
  trialOverMessage,
  trialPageFull,
} from '../src/cloud-cafe-page.ts';
import { codesToReport } from '../src/trial-codes.ts';
import { TRIAL_PAID_ENDED_MESSAGE } from '../src/trial.ts';

const URL = 'https://hub.example/#/cafe/K7F392QXM4P8';

test('the record: a waiting request becomes a new cloud café (with its key), a running trial moved', () => {
  const fresh = trialCloudRecord({ code: 'K7F392QXM4P8', url: URL, managerKey: '482913' }, true, 1000);
  assert.deepEqual(fresh, { code: 'K7F392QXM4P8', url: URL, at: 1000, origin: 'new', managerKey: '482913' });
  assert.equal(trialCloudKeyToAck(fresh), true, 'the cloud still holds the key');
  assert.equal(trialCloudKeyToAck({ ...fresh, keyAcked: true }), false);

  const moved = trialCloudRecord({ code: 'K7F392QXM4P8', url: null }, false, 2000);
  assert.deepEqual(moved, { code: 'K7F392QXM4P8', url: null, at: 2000, origin: 'move' });
  assert.equal(trialCloudKeyToAck(moved), false, 'nothing to acknowledge without a key');
  assert.equal(trialCloudKeyToAck(null), false);
});

test('the record read back: known fields only, broken ones refused', () => {
  const stored = { code: 'K7F392QXM4P8', url: URL, at: 5, origin: 'new', managerKey: '482913', keySeen: true, keyAcked: true, extra: 1 };
  assert.deepEqual(parseTrialCloudRecord(stored), { code: 'K7F392QXM4P8', url: URL, at: 5, origin: 'new', managerKey: '482913', keySeen: true, keyAcked: true });
  assert.deepEqual(parseTrialCloudRecord({ code: 'K7F392QXM4P8', url: 'javascript:alert(1)' }), { code: 'K7F392QXM4P8', url: null, at: 0, origin: 'move' });
  assert.equal(parseTrialCloudRecord({ url: URL }), null);
  assert.equal(parseTrialCloudRecord('K7F392QXM4P8'), null);
  assert.equal(parseTrialCloudRecord(null), null);
});

test('a refused call names the cloud café only for 410 TRIAL_MOVED with `cloud`', () => {
  const body = { error: { code: 'TRIAL_MOVED', message: 'Касса переехала в облако', cloud: { code: 'K7F392QXM4P8', url: URL } } };
  assert.deepEqual(movedToCloudOf(body), { code: 'K7F392QXM4P8', url: URL });
  // Moved to another computer (no cloud), another error, no body: the old paths.
  assert.equal(movedToCloudOf({ error: { code: 'TRIAL_MOVED', message: 'Касса перенесена на другой компьютер' } }), null);
  assert.equal(movedToCloudOf({ error: { code: 'UNAUTHORIZED', cloud: { code: 'K7F392QXM4P8', url: URL } } }), null);
  assert.equal(movedToCloudOf(null), null);
  assert.equal(movedToCloudOf('nope'), null);
});

test('what stands in front of the cash desk', () => {
  const moved = trialCloudRecord({ code: 'K7F392QXM4P8', url: URL }, false, 1);
  const fresh = trialCloudRecord({ code: 'K7F392QXM4P8', url: URL, managerKey: '482913' }, true, 1);
  assert.equal(trialCloudScreen(undefined, false), 'none');
  assert.equal(trialCloudScreen(moved, false), 'moved');
  assert.equal(trialCloudScreen(moved, true), 'banner', '«Посмотреть старые данные»: the read-only cash desk with a banner');
  assert.equal(trialCloudScreen(fresh, false), 'ready');
  assert.equal(trialCloudScreen(fresh, true), 'ready', 'a new cloud café has no browser café behind it');
});

test('devices learn it from the cash desk’s answers', () => {
  assert.deepEqual(cloudHeaders(null), {});
  assert.deepEqual(cloudHeaders({ code: 'K7F392QXM4P8', url: null }), { [CLOUD_CODE_HEADER]: 'K7F392QXM4P8' });
  const h = cloudHeaders({ code: 'K7F392QXM4P8', url: URL });
  assert.deepEqual(h, { 'x-ts-cloud': 'K7F392QXM4P8', 'x-ts-cloud-url': URL });
  assert.deepEqual(cloudFromHeaders({ 'content-type': 'application/json', ...h }), { code: 'K7F392QXM4P8', url: URL });
  assert.deepEqual(cloudFromHeaders({ 'X-TS-Cloud': 'K7F392QXM4P8', [CLOUD_URL_HEADER.toUpperCase()]: URL }), { code: 'K7F392QXM4P8', url: URL });
  assert.equal(cloudFromHeaders({ 'content-type': 'application/json' }), null);
  assert.equal(cloudFromHeaders(undefined), null);
});

test('the director’s code: the known one while it works, else a seen one that works, else stale', () => {
  const known = { key: '482913', works: true };
  assert.deepEqual(directorKeyDecision(known, []), { keep: '482913', stale: false, report: { directorKey: '482913' } });
  // Changed in «Сотрудники»: the old code was revoked, the page saw the new one issued.
  assert.deepEqual(directorKeyDecision({ key: '482913', works: false }, [{ key: '730541', works: true }]), {
    keep: '730541',
    stale: false,
    report: { directorKey: '730541' },
  });
  // The newest seen key that works wins; a revoked seen one is skipped.
  assert.equal(directorKeyDecision({ key: '482913', works: false }, [{ key: '111947', works: false }, { key: '730541', works: true }]).keep, '730541');
  // Nothing known works: keep the old one (for the record), say it is stale.
  assert.deepEqual(directorKeyDecision({ key: '482913', works: false }, []), { keep: '482913', stale: true, report: { directorKeyStale: true } });
  // A working long key (MGR-…, issued in «Сотрудники») is the director's code too, and TS learns it.
  assert.deepEqual(directorKeyDecision({ key: '482913', works: false }, [{ key: 'MGR-ABCD-EFGH-JKMN-PQRS', works: true }]), {
    keep: 'MGR-ABCD-EFGH-JKMN-PQRS',
    stale: false,
    report: { directorKey: 'MGR-ABCD-EFGH-JKMN-PQRS' },
  });
  // Something that is no key shape at all is never sent.
  assert.deepEqual(directorKeyDecision({ key: '482913', works: false }, [{ key: 'MGR-ABCD', works: true }]).report, { directorKeyStale: true });
  // A moved-in café never knew the director's code: nothing to say.
  assert.deepEqual(directorKeyDecision({ key: '', works: false }, []), { keep: '', stale: false, report: {} });
  assert.deepEqual(directorKeyDecision(null, []), { keep: '', stale: false, report: {} });
});

test('what the cloud knows after a report: stale and a code replace each other', () => {
  assert.deepEqual(mergeReportedCodes(null, { cafeCode: 'K7F392QXM4P8', directorKey: '482913' }), { cafeCode: 'K7F392QXM4P8', directorKey: '482913' });
  const stale = mergeReportedCodes({ cafeCode: 'K7F392QXM4P8', directorKey: '482913' }, { directorKeyStale: true });
  assert.deepEqual(stale, { cafeCode: 'K7F392QXM4P8', directorKeyStale: true });
  // Then nothing new to say while it stays stale; a new working code goes once.
  assert.equal(codesToReport({ cafeCode: 'K7F392QXM4P8', directorKeyStale: true }, stale), null);
  assert.deepEqual(codesToReport({ cafeCode: 'K7F392QXM4P8', directorKey: '730541' }, stale), { directorKey: '730541' });
  const fresh = mergeReportedCodes(stale, { directorKey: '730541' });
  assert.deepEqual(fresh, { cafeCode: 'K7F392QXM4P8', directorKey: '730541' });
  assert.equal(codesToReport({ cafeCode: 'K7F392QXM4P8', directorKey: '730541' }, fresh), null);
  assert.deepEqual(mergeReportedCodes(fresh, { directorKeyRefused: '555012' }), {
    cafeCode: 'K7F392QXM4P8',
    directorKey: '730541',
    directorKeyRefused: '555012',
  });
});

test('a new director’s code from TS in the report’s answer; the keys seen issued', () => {
  assert.equal(directorKeyNextOf({ status: 'active', endsAt: 1, directorKeyNext: '730541' }), '730541');
  assert.equal(directorKeyNextOf({ directorKeyNext: '123456' }), null, 'a weak code is never installed');
  assert.equal(directorKeyNextOf({ directorKeyNext: 730541 }), null);
  assert.equal(directorKeyNextOf(null), null);
  assert.deepEqual(rememberSeenKey(undefined, '730541'), ['730541']);
  assert.deepEqual(rememberSeenKey(['111947', '730541'], '730541'), ['730541', '111947']);
  assert.deepEqual(rememberSeenKey(['1', '2', '3', '4', '5'], '6'), ['6', '1', '2', '3', '4']);
});

test('«Купили» on the page: the full version until the paid day passes, then read-only with its own words', () => {
  const now = Date.UTC(2026, 10, 3, 9);
  const day = 86_400_000;
  assert.equal(trialPageFull({ startedAt: 0, status: 'permanent' }, now), true);
  assert.equal(trialPageFull({ startedAt: 0, status: 'paid', endsAt: now + day }, now), true);
  assert.equal(trialPageFull({ startedAt: 0, status: 'paid', endsAt: now - 1 }, now), false, 'the paid day passed (off line)');
  assert.equal(trialPageFull({ startedAt: 0, status: 'active', endsAt: now + day }, now), false);
  // The cloud's words first; a paid café that is over off line gets the paid words, a trial the page's own.
  assert.equal(trialOverMessage({ status: 'expired', message: TRIAL_PAID_ENDED_MESSAGE }), TRIAL_PAID_ENDED_MESSAGE);
  assert.equal(trialOverMessage({ status: 'paid', message: null }), TRIAL_PAID_ENDED_MESSAGE);
  assert.equal(trialOverMessage({ status: 'expired', everPaid: true }), TRIAL_PAID_ENDED_MESSAGE);
  assert.equal(trialOverMessage({ status: 'expired', message: '  ' }), null);
  const ended = 'Пробный период завершён. Свяжитесь с TS, чтобы продолжить.';
  assert.equal(trialOverMessage({ status: 'ended', message: ended }), ended);
});
