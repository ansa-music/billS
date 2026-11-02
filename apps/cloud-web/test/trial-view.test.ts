import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checksText, isStale, lastActivityText, updatedText, viewErrorText, viewTokenOf, weekdayOf } from '../src/trial-view-words.ts';

const MIN = 60_000;
// 29 Oct 2026, 12:00 in Almaty (UTC+5).
const NOW = Date.UTC(2026, 9, 29, 7, 0, 0);

test('phone page: #/v/<token> only, a plausible token', () => {
  assert.equal(viewTokenOf('#/v/AbC_def-1234567890xyzABCDEFGH'), 'AbC_def-1234567890xyzABCDEFGH');
  assert.equal(viewTokenOf('#/v/AbC_def-1234567890xyzABCDEFGH/'), 'AbC_def-1234567890xyzABCDEFGH');
  assert.equal(viewTokenOf('#/v/short'), null);
  assert.equal(viewTokenOf('#/v/has space in it 1234567'), null);
  assert.equal(viewTokenOf('#/book/club'), null);
  assert.equal(viewTokenOf(''), null);
});

test('phone page: «обновлено N минут назад», stale after 30 minutes', () => {
  assert.equal(updatedText(NOW - 20_000, NOW), 'обновлено только что');
  assert.equal(updatedText(NOW - 1 * MIN, NOW), 'обновлено 1 минуту назад');
  assert.equal(updatedText(NOW - 5 * MIN, NOW), 'обновлено 5 минут назад');
  assert.equal(updatedText(NOW - 22 * MIN, NOW), 'обновлено 22 минуты назад');
  assert.equal(updatedText(NOW - 3 * 60 * MIN, NOW), 'обновлено 3 часа назад');
  assert.equal(updatedText(NOW - 2 * 24 * 60 * MIN, NOW), 'обновлено 2 дня назад');
  assert.equal(isStale(NOW - 10 * MIN, NOW), false);
  assert.equal(isStale(NOW - 31 * MIN, NOW), true);
});

test('phone page: words', () => {
  assert.equal(checksText(1), '1 чек');
  assert.equal(checksText(3), '3 чека');
  assert.equal(checksText(11), '11 чеков');
  assert.equal(lastActivityText(null, NOW, 'Asia/Almaty'), 'заказов ещё не было');
  assert.equal(lastActivityText(NOW - 35 * MIN, NOW, 'Asia/Almaty'), 'последний заказ в 11:25');
  assert.equal(lastActivityText(NOW - 24 * 60 * MIN, NOW, 'Asia/Almaty'), 'последний заказ вчера в 12:00');
  assert.equal(lastActivityText(NOW - 5 * 24 * 60 * MIN, NOW, 'Asia/Almaty'), 'последний заказ 24 октября');
  assert.equal(weekdayOf('2026-10-29'), 'чт');
  assert.match(viewErrorText('VIEW_NOT_FOUND', 404), /выключили или заменили/);
  assert.match(viewErrorText('X', 503), /Сервер не ответил/);
});
