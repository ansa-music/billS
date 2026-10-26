import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookErrorField, bookErrorText, bookRefOf, dayChipTitle, dayNumber } from '../src/book-words.ts';
import { parseHash } from '../src/hooks.ts';

test('the guest page route: #/book/<slug or clubId>', () => {
  assert.equal(bookRefOf('#/book/kiy-almaty'), 'kiy-almaty');
  assert.equal(bookRefOf('#/book/kiy-almaty/'), 'kiy-almaty');
  assert.equal(bookRefOf('#/book/0d6f0b5e-1c4b-4a8e-9a65-1f2c3d4e5f60'), '0d6f0b5e-1c4b-4a8e-9a65-1f2c3d4e5f60');
  assert.equal(bookRefOf('#/book/'), null);
  assert.equal(bookRefOf('#/clubs/x'), null);
  assert.equal(bookRefOf('#/book/%E0%A4%A'), null);
  // The cabinet's own route for the owner's tab.
  assert.deepEqual(parseHash('#/clubs/c1/bookings'), { kind: 'bookings', id: 'c1' });
});

test('day chips: Сегодня, Завтра, then the weekday', () => {
  assert.equal(dayChipTitle('2026-10-12', '2026-10-12'), 'Сегодня');
  assert.equal(dayChipTitle('2026-10-13', '2026-10-12'), 'Завтра');
  assert.equal(dayChipTitle('2026-10-14', '2026-10-12'), 'Ср');
  assert.equal(dayNumber('2026-10-05'), '5');
});

test('the cloud’s refusals in plain words', () => {
  assert.match(bookErrorText('SLOT_TAKEN', 409), /только что заняли/);
  assert.match(bookErrorText('BOOKING_NOT_FOUND', 404), /не работает/);
  assert.match(bookErrorText('RATE_LIMITED', 429), /Слишком много/);
  assert.match(bookErrorText('X', 500), /Сервер не ответил/);
  assert.equal(bookErrorText('PHONE_INVALID', 422, 'Проверьте телефон'), 'Проверьте телефон');
  assert.equal(bookErrorField('PHONE_INVALID'), 'phone');
  assert.equal(bookErrorField('NAME_REQUIRED'), 'name');
  assert.equal(bookErrorField('SLOT_TAKEN'), null);
});
