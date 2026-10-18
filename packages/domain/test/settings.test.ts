import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CLUB_SETTINGS, normalizeClubSettings, validateClubSettings } from '../src/settings.ts';

test('empty or garbage input yields the defaults', () => {
  assert.deepEqual(normalizeClubSettings(undefined), DEFAULT_CLUB_SETTINGS);
  assert.deepEqual(normalizeClubSettings('{}'), DEFAULT_CLUB_SETTINGS);
  assert.deepEqual(
    normalizeClubSettings({ display: { theme: 'neon' }, rules: { defaultStepMinutes: 0 } }),
    DEFAULT_CLUB_SETTINGS,
  );
});

test('a partial patch keeps the other values of the base', () => {
  const base = normalizeClubSettings({ display: { title: 'Клуб у реки', theme: 'light' } });
  const next = normalizeClubSettings({ rules: { defaultFreeMinutes: 5 } }, base);
  assert.equal(next.display.title, 'Клуб у реки');
  assert.equal(next.display.theme, 'light');
  assert.equal(next.rules.defaultFreeMinutes, 5);
  assert.equal(next.rules.defaultMinimumMinutes, 30);
});

test('title can be cleared with null and is trimmed and capped', () => {
  const base = normalizeClubSettings({ display: { title: '  Название  ' } });
  assert.equal(base.display.title, 'Название');
  assert.equal(normalizeClubSettings({ display: { title: null } }, base).display.title, null);
  assert.equal(normalizeClubSettings({ display: { title: 'x'.repeat(100) } }).display.title?.length, 60);
});

test('only http(s), data:image and site-relative logos are accepted', () => {
  assert.equal(normalizeClubSettings({ display: { logoUrl: 'javascript:alert(1)' } }).display.logoUrl, null);
  assert.equal(normalizeClubSettings({ display: { logoUrl: 'https://x/logo.png' } }).display.logoUrl, 'https://x/logo.png');
  assert.equal(
    normalizeClubSettings({ display: { logoUrl: 'data:image/png;base64,AAAA' } }).display.logoUrl,
    'data:image/png;base64,AAAA',
  );
});

test('numbers from form fields are accepted as strings and range-checked', () => {
  const s = normalizeClubSettings({ rules: { defaultMinimumMinutes: '45', defaultRoundingMinor: '-5' } });
  assert.equal(s.rules.defaultMinimumMinutes, 45);
  assert.equal(s.rules.defaultRoundingMinor, 1000);
});

test('validation flags a minimum shorter than the free minutes', () => {
  const s = normalizeClubSettings({ rules: { defaultFreeMinutes: 10, defaultMinimumMinutes: 5 } });
  assert.equal(validateClubSettings(s).length, 1);
  assert.deepEqual(validateClubSettings(DEFAULT_CLUB_SETTINGS), []);
});
