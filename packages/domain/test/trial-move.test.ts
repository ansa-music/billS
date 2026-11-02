import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MoveStep, TrialMoveStart, TrialMoveState } from '../src/trial-move.ts';
import {
  CAFE_CODE_ALPHABET,
  CAFE_CODE_LENGTH,
  CAFE_CODE_WRONG_MESSAGE,
  cafeCodeFromBytes,
  cafeCodeHashInput,
  formatCafeCode,
  formatCafeCodeInput,
  isDeskSignal,
  MOVE_START,
  MOVE_SUPERSEDED_MESSAGE,
  moveErrorText,
  moveReducer,
  moveSnapshotFresh,
  normalizeCafeCode,
  TRIAL_MOVE,
  TRIAL_SNAPSHOT,
  trialSnapshotDueNow,
} from '../src/trial-move.ts';

test('café code: 12 Crockford characters from 8 random bytes, 60 bits, no look-alikes', () => {
  assert.equal(CAFE_CODE_ALPHABET.length, 32);
  for (const c of 'ILOU') assert.equal(CAFE_CODE_ALPHABET.includes(c), false, c);
  assert.equal(cafeCodeFromBytes(new Uint8Array(8)), '000000000000');
  assert.equal(cafeCodeFromBytes(new Uint8Array(8).fill(0xff)), 'ZZZZZZZZZZZZ');
  // 0x0123456789ABCDEF >> 4 = 0x0123456789ABCDE → base32 groups of 5 bits.
  const bytes = new Uint8Array([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
  const code = cafeCodeFromBytes(bytes);
  assert.equal(code.length, CAFE_CODE_LENGTH);
  let n = 0n;
  for (const c of code) n = n * 32n + BigInt(CAFE_CODE_ALPHABET.indexOf(c));
  assert.equal(n, 0x0123456789abcden);
  assert.throws(() => cafeCodeFromBytes(new Uint8Array(7)));
  // Random bytes give every character position a spread (no stuck bits).
  const seen = new Set<string>();
  for (let i = 0; i < 64; i++) seen.add(cafeCodeFromBytes(crypto.getRandomValues(new Uint8Array(8))));
  assert.equal(seen.size, 64);
});

test('café code: typed input with dashes, spaces, lower case and look-alikes is normalised', () => {
  const code = 'K7F392QXM4P8';
  for (const typed of ['K7F3-92QX-M4P8', 'k7f3-92qx-m4p8', ' k7f3 92qx m4p8 ', 'K7F3—92QX—M4P8', 'k7f3.92qx.m4p8', 'K7F392QXM4P8', 'k7f3_92qx_m4p8']) {
    assert.equal(normalizeCafeCode(typed), code, typed);
  }
  assert.equal(normalizeCafeCode('O0I1-L1AB-CDEF'), '0011' + '11AB' + 'CDEF', 'O → 0, I and L → 1');
  for (const bad of ['', 'K7F3-92QX-M4P', 'K7F3-92QX-M4P8-1', 'K7F3-92QX-M4PU', 'К7F3-92QX-M4P8' /* Cyrillic К */, 'K7F3*92QX*M4P8', 42, null, undefined, 'x'.repeat(65)]) {
    assert.equal(normalizeCafeCode(bad), null, String(bad));
  }
  assert.equal(formatCafeCode(code), 'K7F3-92QX-M4P8');
  assert.equal(formatCafeCode('short'), 'short');
  assert.equal(cafeCodeHashInput(code), 'ts-cafe-code:K7F392QXM4P8');
});

test('café code input: formats as the person types', () => {
  assert.equal(formatCafeCodeInput(''), '');
  assert.equal(formatCafeCodeInput('k7f'), 'K7F');
  assert.equal(formatCafeCodeInput('k7f3'), 'K7F3');
  assert.equal(formatCafeCodeInput('k7f39'), 'K7F3-9');
  assert.equal(formatCafeCodeInput('K7F3-92QX-'), 'K7F3-92QX');
  assert.equal(formatCafeCodeInput('k7f3 92qx m4p8 extra'), 'K7F3-92QX-M4P8', 'at most 12 characters');
  assert.equal(formatCafeCodeInput('k7u*f3'), 'K7F3', 'characters outside the alphabet are dropped');
  assert.equal(formatCafeCodeInput('oil'), '011');
  assert.equal(normalizeCafeCode(formatCafeCodeInput('k7f392qxm4p8')), 'K7F392QXM4P8');
});

test('copies: 2 minutes after the last change, every regular report while busy, every minute while watched', () => {
  const t0 = 10_000_000;
  const due = (now: number, lastSnapshotAt: number | null, lastChangeAt: number | null, watched = false) =>
    trialSnapshotDueNow(now, { lastSnapshotAt, lastChangeAt, watched });
  assert.equal(due(t0, null, null), true, 'never sent: due');
  assert.equal(due(t0 + 60_000, t0, null), false, 'no change, 1 minute');
  assert.equal(due(t0 + 60_000, t0, t0 + 1000), false, 'changed, but not quiet for 2 minutes yet');
  assert.equal(due(t0 + 1000 + TRIAL_SNAPSHOT.quietMs, t0, t0 + 1000), true, 'quiet for 2 minutes after a change');
  assert.equal(due(t0 + TRIAL_SNAPSHOT.quietMs + 5000, t0 + 2000, t0 + 1000), false, 'the change is already in the last copy');
  assert.equal(due(t0 + TRIAL_SNAPSHOT.busyMs, t0, t0 + TRIAL_SNAPSHOT.busyMs - 1000), true, 'busy: the regular report carries it');
  assert.equal(due(t0 + TRIAL_SNAPSHOT.watchedMs, t0, null, true), true, 'watched: every minute');
  assert.equal(due(t0 + TRIAL_SNAPSHOT.watchedMs - 1, t0, t0 + 1, true), false);
  assert.ok(TRIAL_SNAPSHOT.quietMs < 30 * 60_000, 'sooner than the old 30 minutes');
});

test('fresh copy: newer than (or at) the request', () => {
  assert.equal(moveSnapshotFresh(100, 100), true);
  assert.equal(moveSnapshotFresh(101, 100), true);
  assert.equal(moveSnapshotFresh(99, 100), false);
  assert.equal(moveSnapshotFresh(null, 100), false);
  assert.equal(moveSnapshotFresh(100, null), false);
  assert.equal(isDeskSignal('moved'), true);
  assert.equal(isDeskSignal('nope'), false);
});

const T = 50_000_000;
const startAnswer = (o: Partial<TrialMoveStart> = {}): TrialMoveStart => ({
  ticket: 'tkt',
  venue: 'Утро',
  wait: true,
  requestedAt: T,
  snapshotAt: T - 600_000,
  lastSeenAt: T - 30_000,
  ...o,
});
const state = (o: Partial<TrialMoveState> = {}): TrialMoveState => ({
  venue: 'Утро',
  requestedAt: T,
  snapshotAt: T - 600_000,
  lastSeenAt: T - 30_000,
  fresh: false,
  superseded: false,
  ...o,
});
const run = (s: MoveStep, ...events: Parameters<typeof moveReducer>[1][]) => events.reduce(moveReducer, s);

test('move steps: old cash desk on line → wait → fresh copy → move → done', () => {
  let s = run(MOVE_START, { type: 'submit' });
  assert.deepEqual(s, { step: 'checking' });
  s = moveReducer(s, { type: 'started', answer: startAnswer(), now: T });
  assert.deepEqual(s, { step: 'waiting', ticket: 'tkt', venue: 'Утро', requestedAt: T, snapshotAt: T - 600_000, until: T + TRIAL_MOVE.waitFreshMs });
  s = moveReducer(s, { type: 'polled', state: state(), now: T + 3000 });
  assert.equal(s.step, 'waiting', 'still the old copy');
  s = moveReducer(s, { type: 'polled', state: state({ snapshotAt: T + 20_000, fresh: true }), now: T + 21_000 });
  assert.deepEqual(s, { step: 'moving', ticket: 'tkt', venue: 'Утро', acceptOlder: false });
  s = moveReducer(s, { type: 'finished', snapshotAt: T + 20_000 });
  assert.deepEqual(s, { step: 'done', venue: 'Утро', snapshotAt: T + 20_000 });
  assert.equal(moveReducer(s, { type: 'failed', code: 'OFFLINE', message: '' }), s, 'done stays done');
});

test('move steps: the old cash desk does not answer in time → the person decides on the older copy', () => {
  let s = run(MOVE_START, { type: 'submit' }, { type: 'started', answer: startAnswer(), now: T });
  s = moveReducer(s, { type: 'tick', now: T + TRIAL_MOVE.waitFreshMs - 1 });
  assert.equal(s.step, 'waiting');
  s = moveReducer(s, { type: 'tick', now: T + TRIAL_MOVE.waitFreshMs });
  assert.deepEqual(s, { step: 'older', ticket: 'tkt', venue: 'Утро', snapshotAt: T - 600_000, reason: 'timeout' });
  assert.equal(moveReducer(s, { type: 'finished', snapshotAt: 1 }), s, 'never finished without the person saying so');
  s = moveReducer(s, { type: 'confirmOlder' });
  assert.deepEqual(s, { step: 'moving', ticket: 'tkt', venue: 'Утро', acceptOlder: true });
  const skipped = run(MOVE_START, { type: 'submit' }, { type: 'started', answer: startAnswer(), now: T }, { type: 'stopWaiting' });
  assert.equal(skipped.step, 'older', '«Не ждать» → the person decides at once');
});

test('move steps: old cash desk off line → older copy at once; no copy at all → nothing to move', () => {
  const off = run(MOVE_START, { type: 'submit' }, { type: 'started', answer: startAnswer({ wait: false, requestedAt: null }), now: T });
  assert.deepEqual(off, { step: 'older', ticket: 'tkt', venue: 'Утро', snapshotAt: T - 600_000, reason: 'offline' });
  const none = run(MOVE_START, { type: 'submit' }, { type: 'started', answer: startAnswer({ wait: false, requestedAt: null, snapshotAt: null }), now: T });
  assert.deepEqual(none, { step: 'empty', venue: 'Утро' });
  const waitedForNothing = run(MOVE_START, { type: 'submit' }, { type: 'started', answer: startAnswer({ snapshotAt: null }), now: T }, { type: 'tick', now: T + TRIAL_MOVE.waitFreshMs });
  assert.deepEqual(waitedForNothing, { step: 'empty', venue: 'Утро' });
  const already = run(MOVE_START, { type: 'submit' }, { type: 'started', answer: startAnswer({ snapshotAt: T }), now: T });
  assert.equal(already.step, 'moving', 'a copy at the request time is fresh');
});

test('move steps: another computer took over, wrong code, offline — back to the code with plain words', () => {
  const waiting = run(MOVE_START, { type: 'submit' }, { type: 'started', answer: startAnswer(), now: T });
  assert.deepEqual(moveReducer(waiting, { type: 'polled', state: state({ superseded: true }), now: T + 3000 }), { step: 'code', error: MOVE_SUPERSEDED_MESSAGE });
  const wrong = run(MOVE_START, { type: 'submit' }, { type: 'failed', code: 'CAFE_CODE_WRONG', message: 'x' });
  assert.deepEqual(wrong, { step: 'code', error: CAFE_CODE_WRONG_MESSAGE });
  const moving: MoveStep = { step: 'moving', ticket: 't', venue: 'Утро', acceptOlder: false };
  assert.deepEqual(moveReducer(moving, { type: 'failed', code: 'MOVE_SUPERSEDED', message: '' }), { step: 'code', error: MOVE_SUPERSEDED_MESSAGE });
  assert.deepEqual(moveReducer(moving, { type: 'failed', code: 'SNAPSHOT_NOT_FOUND', message: '' }), { step: 'empty', venue: 'Утро' });
  assert.match(moveErrorText('OFFLINE', ''), /интернет/);
  assert.match(moveErrorText('RATE_LIMITED', ''), /час/);
  assert.equal(moveErrorText('WHATEVER', 'Своё сообщение'), 'Своё сообщение');
  assert.deepEqual(moveReducer(waiting, { type: 'back' }), MOVE_START);
  assert.equal(moveReducer(MOVE_START, { type: 'confirmOlder' }), MOVE_START, 'events that do not fit change nothing');
});
