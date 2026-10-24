import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PASSWORD_MIN, passwordStrength, signupErrorField, signupErrorText, signupProblems } from '../src/signup.ts';

const ok = { venueName: 'Coffee Point', email: 'owner@mail.kz', password: 'kofe2026!' };

test('a filled form has no problems', () => {
  assert.deepEqual(signupProblems(ok), {});
});

test('each field says what is wrong', () => {
  const p = signupProblems({ venueName: '  ', email: 'owner@', password: 'short' });
  assert.match(p.venueName ?? '', /называется/);
  assert.match(p.email ?? '', /ошибкой/);
  assert.match(p.password ?? '', new RegExp(String(PASSWORD_MIN)));
  assert.match(signupProblems({ ...ok, email: '' }).email ?? '', /почту/);
  assert.match(signupProblems({ ...ok, venueName: 'x'.repeat(121) }).venueName ?? '', /длиннее/);
});

test('password strength hint', () => {
  assert.equal(passwordStrength('').level, 0);
  assert.equal(passwordStrength('abc').level, 1);
  assert.match(passwordStrength('abc').text, /Ещё 5 символов/);
  assert.match(passwordStrength('abcdefg').text, /Ещё 1 символ$/);
  assert.equal(passwordStrength('12345678').level, 1);
  assert.equal(passwordStrength('aaaaaaaa').level, 1);
  assert.equal(passwordStrength('kofekofe').level, 1);
  assert.equal(passwordStrength('kofe2026').level, 2);
  assert.equal(passwordStrength('Kofe-Point-2026').level, 3);
});

test('cloud errors go under the right field, in plain words', () => {
  assert.equal(signupErrorField('EMAIL_TAKEN'), 'email');
  assert.equal(signupErrorField('INVALID_EMAIL'), 'email');
  assert.equal(signupErrorField('WEAK_PASSWORD'), 'password');
  assert.equal(signupErrorField('NAME_REQUIRED'), 'venueName');
  assert.equal(signupErrorField('RATE_LIMITED'), null);
  assert.match(signupErrorText('EMAIL_TAKEN', 409), /уже зарегистрирована/);
  assert.match(signupErrorText('RATE_LIMITED', 429), /Подождите/);
  assert.match(signupErrorText('SIGNUP_DISABLED', 403), /закрыта/);
  assert.match(signupErrorText('HTTP_ERROR', 404), /пока не работает/);
  assert.match(signupErrorText('HTTP_ERROR', 500), /не ответил/);
  assert.equal(signupErrorText('SOMETHING', 400, 'Текст облака'), 'Текст облака');
});
