import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_RATE,
  guestRequestSummary,
  guestStageText,
  isGuestToken,
  pluralRu,
  rateCheck,
  validateGuestRequest,
} from '../src/guest.ts';

test('guest tokens: only long url-safe strings are looked up', () => {
  assert.equal(isGuestToken('AbCdEfGhIjKlMnOpQrStUvWx'), true);
  assert.equal(isGuestToken('abc'), false);
  assert.equal(isGuestToken('../../etc/passwd/xxxxxxxxxxxxxxx'), false);
  assert.equal(isGuestToken(42), false);
});

test('rate window: allows up to max, then says how long to wait', () => {
  let hits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = rateCheck(hits, 1000 + i, 60_000, 3);
    assert.equal(r.allowed, true);
    hits = r.hits;
  }
  const refused = rateCheck(hits, 2000, 60_000, 3);
  assert.equal(refused.allowed, false);
  assert.equal(refused.retryAfterMs, 1000 + 60_000 - 2000);
  // The oldest hit leaves the window.
  assert.equal(rateCheck(hits, 1000 + 60_000 + 1, 60_000, 3).allowed, true);
  assert.ok(GUEST_RATE.perCounter > GUEST_RATE.perTable);
});

test('plural forms in Russian', () => {
  assert.equal(pluralRu(1, ['позиция', 'позиции', 'позиций']), 'позиция');
  assert.equal(pluralRu(2, ['позиция', 'позиции', 'позиций']), 'позиции');
  assert.equal(pluralRu(5, ['позиция', 'позиции', 'позиций']), 'позиций');
  assert.equal(pluralRu(11, ['позиция', 'позиции', 'позиций']), 'позиций');
  assert.equal(pluralRu(21, ['позиция', 'позиции', 'позиций']), 'позиция');
});

test('summaries for the staff list', () => {
  assert.equal(guestRequestSummary({ kind: 'PREORDER', guestName: 'Аня', itemCount: 2 }), 'Заказ гостя: Аня, 2 позиции');
  assert.equal(guestRequestSummary({ kind: 'PREORDER', itemCount: 1 }), 'Заказ гостя: 1 позиция');
  assert.equal(guestRequestSummary({ kind: 'EXTEND', minutes: 30 }), 'Продлить на 30 мин');
  assert.equal(guestRequestSummary({ kind: 'BAR', itemCount: 5 }), 'Заказ из бара: 5 позиций');
  assert.equal(guestRequestSummary({ kind: 'WAITER' }), 'Позвать официанта');
  assert.equal(guestRequestSummary({ kind: 'BILL' }), 'Попросить счёт');
});

test('stage text on the guest page', () => {
  assert.equal(guestStageText('NEW'), 'Готовится');
  assert.equal(guestStageText('PREPARING'), 'Готовится');
  assert.equal(guestStageText('READY'), 'Готово — заберите');
  assert.equal(guestStageText('ISSUED'), 'Выдан');
  assert.match(guestStageText('READY', true), /отменён/);
});

test('request validation', () => {
  assert.deepEqual(validateGuestRequest({ kind: 'WAITER' }), []);
  assert.deepEqual(validateGuestRequest({ kind: 'EXTEND', minutes: 60 }), []);
  assert.equal(validateGuestRequest({ kind: 'EXTEND', minutes: 45 }).length, 1);
  assert.deepEqual(validateGuestRequest({ kind: 'BAR', items: [] }), ['В заказе нет позиций']);
  assert.deepEqual(validateGuestRequest({ kind: 'PREORDER', items: [{ productId: 'p', qty: 2 }] }), []);
  assert.deepEqual(validateGuestRequest({ kind: 'NOPE' as 'WAITER' }), ['Неизвестный запрос']);
  assert.equal(validateGuestRequest({ kind: 'WAITER', note: 'x'.repeat(500) }).length, 1);
});
