import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TrialCloudMoveState, TrialCloudView, TrialPaidView } from '@bills/domain';
import { TRIAL_CLOUD_MOVE, trialDayEnd } from '@bills/domain';
import type { CloudMoveStep, TrialView } from '../src/trials.ts';
import {
  CLOUD_MOVE_IDLE,
  TRIAL_STATUS_LABEL,
  canBuy,
  canChangeTerm,
  canDeleteTrial,
  canMoveToCloud,
  cloudMoveReducer,
  cloudShareText,
  copyTimeText,
  isBought,
  paidAmountText,
  paidDefaultUntil,
  paidSoon,
  parsePaidForm,
  sortBought,
  splitTrials,
  trialTermText,
  trialTone,
  whatsAppLink,
} from '../src/trials.ts';

const DAY = 86_400_000;
// 3 Nov 2026, 12:00 in Almaty (UTC+5).
const NOW = Date.UTC(2026, 10, 3, 7, 0, 0);

const CLOUD: TrialCloudView = { code: 'K7F392QXM4P8', url: 'https://hub.ts.kz/#/cafe/K7F392QXM4P8', at: NOW - DAY, origin: 'move', termsError: null, termsSyncedAt: NOW - DAY };
const PAID: TrialPaidView = { until: '2026-12-03', since: NOW - 2 * DAY, amount: 15_000_000, note: 'Kaspi', payments: [], remindedAt: null };

function trial(over: Partial<TrialView> = {}): TrialView {
  return {
    id: 't1',
    venue: 'Кофе Тау',
    managerName: 'Айгерим',
    timezone: 'Asia/Almaty',
    startedAt: NOW - 3 * DAY,
    endsAt: NOW + 11 * DAY,
    status: 'active',
    lastSeenAt: NOW - 60_000,
    stats: null,
    snapshotAt: null,
    snapshotBytes: null,
    requestedAt: null,
    decidedAt: null,
    ownerMessage: null,
    duplicateOf: null,
    cloud: null,
    paid: null,
    ...over,
  };
}

const state = (over: Partial<TrialCloudMoveState> = {}): TrialCloudMoveState => ({ requestedAt: null, snapshotAt: null, lastSeenAt: null, fresh: false, cloud: null, ...over });

test('cloud: who may move, what the café is sent, when the copy came', () => {
  assert.equal(canMoveToCloud(trial()), true);
  assert.equal(canMoveToCloud(trial({ status: 'ended' })), true);
  assert.equal(canMoveToCloud(trial({ status: 'pending' })), false);
  assert.equal(canMoveToCloud(trial({ status: 'rejected' })), false);
  assert.equal(canMoveToCloud(trial({ cloud: CLOUD })), false, 'never twice');
  const text = cloudShareText('Кофе Тау', CLOUD.url, CLOUD.code);
  assert.match(text, /Касса «Кофе Тау» теперь в облаке TS/);
  assert.match(text, /https:\/\/hub\.ts\.kz\/#\/cafe\/K7F392QXM4P8/);
  assert.match(text, /Код кофейни: K7F3-92QX-M4P8/);
  assert.doesNotMatch(cloudShareText('Кофе', null, CLOUD.code), /https/);
  assert.equal(whatsAppLink('a b&c'), 'https://wa.me/?text=a%20b%26c');
  assert.equal(copyTimeText(Date.UTC(2026, 10, 3, 9, 32), NOW), 'сегодня в 14:32');
  assert.equal(copyTimeText(Date.UTC(2026, 10, 2, 9, 32), NOW), '2 ноября в 14:32');
  // A café in the cloud is never deleted (the row is the only link to it).
  assert.equal(canDeleteTrial(trial({ status: 'ended', cloud: CLOUD }), NOW), false);
  assert.equal(canDeleteTrial(trial({ status: 'ended' }), NOW), true);
});

test('cloud: «Перевести в облако» step by step — fresh copy, waiting, the older copy, nothing to move, errors', () => {
  let s: CloudMoveStep = cloudMoveReducer(CLOUD_MOVE_IDLE, { type: 'open' });
  assert.deepEqual(s, { step: 'confirm' });
  assert.deepEqual(cloudMoveReducer(s, { type: 'cancel' }), CLOUD_MOVE_IDLE);
  s = cloudMoveReducer(s, { type: 'confirm' });
  assert.deepEqual(s, { step: 'asking' });
  assert.deepEqual(cloudMoveReducer(s, { type: 'cancel' }), s, 'not while the cloud is asked');

  // On line: wait for the fresh copy (75 s), then move without asking.
  const waiting = cloudMoveReducer(s, { type: 'started', state: state({ requestedAt: NOW, snapshotAt: NOW - DAY }), now: NOW });
  assert.deepEqual(waiting, { step: 'waiting', requestedAt: NOW, snapshotAt: NOW - DAY, until: NOW + TRIAL_CLOUD_MOVE.waitFreshMs });
  assert.deepEqual(cloudMoveReducer(waiting, { type: 'polled', state: state({ requestedAt: NOW, snapshotAt: NOW + 5000, fresh: true }), now: NOW + 6000 }), { step: 'moving', acceptOlder: false });
  // It did not answer: the older copy, after the person agrees.
  const timedOut = cloudMoveReducer(waiting, { type: 'tick', now: NOW + TRIAL_CLOUD_MOVE.waitFreshMs });
  assert.deepEqual(timedOut, { step: 'older', snapshotAt: NOW - DAY, reason: 'timeout' });
  assert.deepEqual(cloudMoveReducer(waiting, { type: 'stopWaiting' }), timedOut);
  const moving = cloudMoveReducer(timedOut, { type: 'confirmOlder' });
  assert.deepEqual(moving, { step: 'moving', acceptOlder: true });
  assert.deepEqual(cloudMoveReducer(moving, { type: 'moved' }), { step: 'done' });
  // Off line: the last copy at once; no copy at all: nothing to move.
  assert.deepEqual(cloudMoveReducer({ step: 'asking' }, { type: 'started', state: state({ snapshotAt: NOW - DAY }), now: NOW }), { step: 'older', snapshotAt: NOW - DAY, reason: 'offline' });
  assert.deepEqual(cloudMoveReducer({ step: 'asking' }, { type: 'started', state: state(), now: NOW }), { step: 'empty' });
  assert.deepEqual(cloudMoveReducer({ step: 'waiting', requestedAt: NOW, snapshotAt: null, until: NOW }, { type: 'tick', now: NOW }), { step: 'empty' });
  // Already in the cloud (a second click): done, the link shows.
  assert.deepEqual(cloudMoveReducer({ step: 'asking' }, { type: 'started', state: state({ cloud: CLOUD }), now: NOW }), { step: 'done' });
  assert.deepEqual(cloudMoveReducer(waiting, { type: 'polled', state: state({ cloud: CLOUD }), now: NOW }), { step: 'done' });
  // A refusal shows its words; «Перевести в облако» again starts over.
  const failed = cloudMoveReducer(moving, { type: 'failed', message: 'Облачная касса не отвечает' });
  assert.deepEqual(failed, { step: 'error', message: 'Облачная касса не отвечает' });
  assert.deepEqual(cloudMoveReducer(failed, { type: 'open' }), { step: 'confirm' });
});

test('«Купили»: the chip, the term in words, the lists, the warning a week before', () => {
  assert.equal(TRIAL_STATUS_LABEL.paid, 'Купили');
  const paid = trial({ status: 'paid', endsAt: trialDayEnd('2026-12-03', 'Asia/Almaty'), paid: PAID });
  assert.equal(trialTermText(paid, NOW), 'оплачено до 3 декабря 2026 · остался 31 день');
  assert.equal(trialTone(paid, NOW), 'ok');
  assert.equal(paidSoon(paid, NOW), false);
  assert.equal(paidSoon(paid, NOW + 25 * DAY), true);
  assert.equal(trialTone(paid, NOW + 25 * DAY), 'warn');
  assert.equal(trialTermText(paid, paid.endsAt + 1), 'оплата закончилась 3 декабря 2026');
  assert.equal(canChangeTerm(paid), false, '«Продлить оплату», not the trial’s buttons');
  assert.equal(canBuy(paid), true);
  assert.equal(canBuy(trial({ status: 'pending' })), false);
  assert.equal(canDeleteTrial(trial({ status: 'ended', paid: PAID }), NOW), false, 'the payments stay');
  assert.equal(isBought(paid), true);
  assert.equal(paidAmountText(15_000_000), trialMoneyText(15_000_000));
  assert.equal(paidAmountText(null), '—');

  const req = trial({ id: 'r', status: 'pending' });
  const run = trial({ id: 'a' });
  const perm = trial({ id: 'p', status: 'permanent', paid: PAID });
  const over = trial({ id: 'o', status: 'paid', endsAt: NOW - DAY, paid: PAID });
  const soon = trial({ id: 's', status: 'paid', endsAt: NOW + 2 * DAY, paid: PAID });
  const split = splitTrials([req, run, paid, perm, over, soon]);
  assert.deepEqual(split.requests.map((t) => t.id), ['r']);
  assert.deepEqual(split.trials.map((t) => t.id), ['a'], 'a café that bought TS is not among the trials');
  assert.deepEqual(sortBought(split.bought, NOW).map((t) => t.id), ['s', 't1', 'o', 'p'], 'running terms by end, then ran out, then the rest');
});

test('«Купили»: the form — the date (today … 3 years), the sum in tenge, the note', () => {
  const t = trial();
  assert.equal(paidDefaultUntil(t, NOW), '2026-12-03', 'a month from today');
  assert.equal(paidDefaultUntil(trial({ status: 'paid', paid: PAID }), NOW), '2027-01-02', 'a month after the paid date');
  assert.deepEqual(parsePaidForm({ until: '2027-11-03', amount: '150 000', note: ' Kaspi ' }, NOW, 'Asia/Almaty'), {
    ok: true,
    body: { until: '2027-11-03', amount: 15_000_000, note: 'Kaspi' },
  });
  assert.deepEqual(parsePaidForm({ until: '2026-11-03', amount: '', note: '' }, NOW, 'Asia/Almaty'), { ok: true, body: { until: '2026-11-03', amount: null, note: null } });
  const past = parsePaidForm({ until: '2026-11-02', amount: '', note: '' }, NOW, 'Asia/Almaty');
  assert.equal(past.ok, false);
  assert.match(!past.ok ? past.error : '', /с 3 ноября по 5 ноября 2029/);
  assert.equal(parsePaidForm({ until: '2027-01-01', amount: 'много', note: '' }, NOW, 'Asia/Almaty').ok, false);
  assert.equal(parsePaidForm({ until: '2027-01-01', amount: '', note: 'x'.repeat(501) }, NOW, 'Asia/Almaty').ok, false);
});

function trialMoneyText(minor: number): string {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'KZT', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(minor / 100);
}
