import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWatching,
  isWatchToken,
  TRIAL_WATCH,
  trialReportEveryMs,
  trialSnapshotDue,
  watchHash,
  watchRequestAllowed,
  watchSnapshotNewer,
  watchTokenFromHash,
} from '../src/trial-watch.ts';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'; // 32 characters, like 24 random bytes in base64url

test('watch link: #/watch/<token> round-trips; anything else is not a watch address', () => {
  assert.equal(TOKEN.length, Math.ceil((TRIAL_WATCH.tokenBytes * 4) / 3));
  assert.equal(watchHash(TOKEN), `#/watch/${TOKEN}`);
  assert.equal(watchTokenFromHash(watchHash(TOKEN)), TOKEN);
  assert.equal(watchTokenFromHash(`/watch/${TOKEN}`), TOKEN, 'without the #');
  assert.equal(watchTokenFromHash(`#/watch/${TOKEN}/`), TOKEN, 'a trailing slash');
  assert.equal(watchTokenFromHash(`#/watch/${TOKEN}?from=qr`), TOKEN, 'a query');
  for (const hash of ['', '#/', '#/login', '#/watch/', '#/watch/short', `#/watch/${TOKEN}!`, `#/pos/${TOKEN}`, `#/watch/${'x'.repeat(87)}`]) {
    assert.equal(watchTokenFromHash(hash), null, hash);
  }
  assert.equal(isWatchToken(TOKEN), true);
  assert.equal(isWatchToken(`${TOKEN}=`), false, 'base64url has no padding');
  assert.equal(isWatchToken(42), false);
});

test('watching: a phone counts for 10 minutes after its last check', () => {
  const now = 1_000_000_000;
  assert.equal(isWatching(null, now), false);
  assert.equal(isWatching(undefined, now), false);
  assert.equal(isWatching(now, now), true);
  assert.equal(isWatching(now - TRIAL_WATCH.watchingMs + 1, now), true);
  assert.equal(isWatching(now - TRIAL_WATCH.watchingMs, now), false);
});

test('the cash desk: a report every minute and a changed snapshot every minute while watched, 5 / 30 minutes otherwise', () => {
  assert.equal(trialReportEveryMs(true), 60_000);
  assert.equal(trialReportEveryMs(false), 5 * 60_000);
  const now = 10 * 3_600_000;
  assert.equal(trialSnapshotDue(now, undefined, false), true, 'never sent');
  assert.equal(trialSnapshotDue(now, null, true), true);
  assert.equal(trialSnapshotDue(now, now - 29 * 60_000, false), false);
  assert.equal(trialSnapshotDue(now, now - 30 * 60_000, false), true);
  assert.equal(trialSnapshotDue(now, now - 59_000, true), false);
  assert.equal(trialSnapshotDue(now, now - 60_000, true), true);
});

test('the phone downloads only a newer snapshot', () => {
  assert.equal(watchSnapshotNewer(null, null), false, 'nothing in the cloud yet');
  assert.equal(watchSnapshotNewer(5, null), true);
  assert.equal(watchSnapshotNewer(5, 5), false);
  assert.equal(watchSnapshotNewer(5, 6), false);
  assert.equal(watchSnapshotNewer(7, 6), true);
});

test('the read-only copy: reading, signing in and out pass; every other write is refused', () => {
  for (const [method, path] of [
    ['GET', '/api/state'],
    ['get', '/api/counter/orders?day=2026-11-02'],
    ['HEAD', '/api/state'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/login/'],
  ] as const) {
    assert.equal(watchRequestAllowed(method, path), true, `${method} ${path}`);
  }
  for (const [method, path] of [
    ['POST', '/api/counter/orders'],
    ['POST', '/api/shifts/open'],
    ['PUT', '/api/settings'],
    ['PATCH', '/api/staff/1'],
    ['DELETE', '/api/products/1'],
    ['POST', '/api/auth/keys'],
    ['PUT', '/api/auth/login'],
    ['POST', '/api/license'],
  ] as const) {
    assert.equal(watchRequestAllowed(method, path), false, `${method} ${path}`);
  }
});
