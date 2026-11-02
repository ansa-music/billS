import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckItemView, CheckPaymentView, CheckView } from '../src/api.ts';
import {
  buildReceipt,
  DEFAULT_RECEIPT_SETTINGS,
  groupCheckLines,
  normalizeReceiptSettings,
  qrCaption,
  RECEIPT_LIMITS,
  RECEIPT_NOTICE,
  receiptSettingsProblems,
  sampleReceiptCheck,
  splitItemTitle,
} from '../src/receipt.ts';
import { DEFAULT_CLUB_SETTINGS, normalizeClubSettings } from '../src/settings.ts';

const NOW = Date.UTC(2026, 10, 3, 9, 30);
const CLUB = { name: 'Кофейня «Демо»', currency: 'KZT', timezone: 'Asia/Almaty' };

function item(over: Partial<CheckItemView> & Pick<CheckItemView, 'id' | 'title' | 'amount'>): CheckItemView {
  return {
    kind: 'ORDER',
    orderId: 'o1',
    qty: 1,
    unitPrice: over.amount,
    sessionId: null,
    tableId: null,
    startedAt: null,
    stoppedAt: null,
    playedSeconds: null,
    ...over,
  };
}

function payment(over: Partial<CheckPaymentView> & Pick<CheckPaymentView, 'id' | 'amount'>): CheckPaymentView {
  return {
    operationId: 'op1',
    kind: 'PAYMENT',
    method: 'CASH',
    tendered: null,
    change: null,
    reason: null,
    approvedBy: null,
    shiftId: 's1',
    at: NOW,
    actor: 'Данияр',
    ...over,
  };
}

/** A paid counter check: «Капучино · L · Овсяное» and two croissants, cash 5 000 with change. */
function counterCheck(over: Partial<CheckView> = {}): CheckView {
  const items = [
    item({ id: 'i1', title: 'Капучино · L · Овсяное', optionNames: ['L', 'Овсяное'], amount: 1900_00 }),
    item({ id: 'i2', title: 'Круассан', qty: 2, unitPrice: 900_00, amount: 1800_00 }),
  ];
  return {
    id: 'c1',
    number: 12,
    status: 'PAID',
    items,
    discount: null,
    subtotal: 3700_00,
    discountAmount: 0,
    total: 3700_00,
    paid: 3700_00,
    refunded: 0,
    due: 0,
    payments: [payment({ id: 'p1', amount: 3700_00, tendered: 5000_00, change: 1300_00 })],
    createdAt: NOW - 60_000,
    createdBy: 'Данияр',
    closedAt: NOW,
    updatedAt: NOW,
    counter: [{ id: 'o1', number: 17, service: 'TAKEAWAY', guestName: 'Аня', status: 'CLOSED' }],
    actorRoles: { Данияр: 'bartender' },
    ...over,
  };
}

const cafe = (check: CheckView, settings = DEFAULT_RECEIPT_SETTINGS) =>
  buildReceipt({ check, club: CLUB, settings, business: 'cafe', now: NOW + 3_600_000 });

test('a counter check: order number, «С собой», guest, lines with options, cash with change', () => {
  const r = cafe(counterCheck());
  assert.equal(r.venue.name, 'Кофейня «Демо»');
  assert.deepEqual(r.orderNumbers, [17]);
  assert.equal(r.service, 'С собой');
  assert.equal(r.guestName, 'Аня');
  assert.equal(r.checkNumber, 12);
  assert.equal(r.at, NOW, 'a paid check is dated by its payment, not by the reprint');
  assert.deepEqual(r.cashier, { label: 'Бариста', name: 'Данияр' });
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0]!.heading, null);
  assert.deepEqual(
    r.groups[0]!.items.map((i) => [i.name, i.options, i.qty, i.unitPrice, i.amount]),
    [
      ['Капучино', ['L', 'Овсяное'], 1, 1900_00, 1900_00],
      ['Круассан', [], 2, 900_00, 1800_00],
    ],
  );
  assert.equal(r.total, 3700_00);
  assert.deepEqual(
    r.payments.map((p) => [p.label, p.amount, p.tendered, p.change, p.at]),
    [['Наличные', 3700_00, 5000_00, 1300_00, null]],
  );
  assert.equal(r.paid, null, 'one payment of the whole total needs no «Оплачено» row');
  assert.equal(r.due, null);
  assert.deepEqual(r.thanks, ['Спасибо! Ждём снова']);
  assert.equal(r.notice, RECEIPT_NOTICE);
  assert.equal(r.paper, '80');
  assert.equal(r.copies, 1);
});

test('the lines add up to the total the check says (nothing lost on the way)', () => {
  const r = cafe(counterCheck());
  const sum = r.groups.flatMap((g) => g.items).reduce((s, i) => s + i.amount, 0);
  assert.equal(sum, r.subtotal);
  assert.equal(r.subtotal - (r.discount?.amount ?? 0), r.total);
});

test('exact cash prints no «Получено / Сдача»; card, QR and mixed payments are listed with their time', () => {
  const exact = cafe(counterCheck({ payments: [payment({ id: 'p1', amount: 3700_00, tendered: 3700_00, change: 0 })] }));
  assert.deepEqual([exact.payments[0]!.tendered, exact.payments[0]!.change], [null, null]);

  const mixed = cafe(
    counterCheck({
      payments: [
        payment({ id: 'p1', operationId: 'a', amount: 2000_00, tendered: 2000_00, change: 0, at: NOW - 1000 }),
        payment({ id: 'p2', operationId: 'b', method: 'CARD', amount: 1700_00, at: NOW }),
      ],
    }),
  );
  assert.deepEqual(
    mixed.payments.map((p) => [p.label, p.amount, p.at]),
    [
      ['Наличные', 2000_00, NOW - 1000],
      ['Карта', 1700_00, NOW],
    ],
  );
  assert.equal(mixed.paid, 3700_00, 'two payments: «Оплачено» sums them');
});

test('«счёт потом»: an open check is a precheck with what is due, dated now; paid later it is a receipt', () => {
  const open = counterCheck({ status: 'OPEN', paid: 0, due: 3700_00, payments: [], closedAt: null, counter: [{ id: 'o1', number: 17, service: 'HERE', guestName: null, status: 'OPEN' }] });
  const pre = cafe(open);
  assert.equal(pre.precheck, true);
  assert.equal(pre.due, 3700_00);
  assert.equal(pre.at, NOW + 3_600_000);
  assert.deepEqual(pre.cashier, { label: 'Бариста', name: 'Данияр' }, 'before any payment: who opened the check');
  assert.equal(pre.service, 'Здесь');
  assert.equal(pre.guestName, null);

  const later = cafe(counterCheck({ payments: [payment({ id: 'p1', method: 'QR', amount: 3700_00, actor: 'Айгерим', at: NOW + 1000 })], actorRoles: { Данияр: 'bartender', Айгерим: 'cashier' } }));
  assert.equal(later.precheck, false);
  assert.deepEqual(later.cashier, { label: 'Кассир', name: 'Айгерим' });
  assert.equal(later.payments[0]!.label, 'QR');
});

test('discounts and loyalty rewards print as a discount line with the reason', () => {
  const r = cafe(
    counterCheck({
      discount: { kind: 'AMOUNT', value: 500_00, reason: 'Бонусы гостя', by: 'Данияр' },
      discountAmount: 500_00,
      total: 3200_00,
      paid: 3200_00,
      payments: [payment({ id: 'p1', method: 'CARD', amount: 3200_00 })],
    }),
  );
  assert.deepEqual(r.discount, { label: 'Скидка', amount: 500_00, reason: 'Бонусы гостя' });
  assert.equal(r.subtotal, 3700_00);
  assert.equal(r.total, 3200_00);

  const pct = cafe(counterCheck({ discount: { kind: 'PERCENT', value: 10, reason: 'Сотрудник', by: 'x' }, discountAmount: 370_00, total: 3330_00 }));
  assert.equal(pct.discount?.label, 'Скидка 10%');
});

test('refunds are listed and summed; a cancelled order still names the check it was on', () => {
  const r = cafe(
    counterCheck({
      refunded: 3700_00,
      payments: [
        payment({ id: 'p1', amount: 3700_00, tendered: 5000_00, change: 1300_00 }),
        payment({ id: 'r1', kind: 'REFUND', amount: 3700_00, reason: 'Остыл', operationId: 'op2', approvedBy: 'Марат' }),
      ],
      counter: [{ id: 'o1', number: 17, service: 'HERE', guestName: null, status: 'CANCELLED' }],
    }),
  );
  assert.deepEqual(r.refunds.map((x) => [x.label, x.amount, x.reason]), [['Возврат · Наличные', 3700_00, 'Остыл']]);
  assert.equal(r.refunded, 3700_00);
  assert.equal(r.paid, 3700_00);
  assert.deepEqual(r.orderNumbers, [17]);
});

test('the counter order the screen holds fills in for a check view without counter data', () => {
  const r = cafe(counterCheck({ counter: undefined, actorRoles: undefined }), DEFAULT_RECEIPT_SETTINGS);
  assert.deepEqual(r.orderNumbers, []);
  assert.deepEqual(r.cashier, { label: 'Кассир', name: 'Данияр' }, 'role unknown → «Кассир»');
  const withOrder = buildReceipt({
    check: counterCheck({ counter: undefined }),
    club: CLUB,
    settings: DEFAULT_RECEIPT_SETTINGS,
    business: 'cafe',
    now: NOW,
    orders: [{ id: 'o1', number: 5, service: 'HERE', guestName: 'Лео' }],
  });
  assert.deepEqual([withOrder.orderNumbers, withOrder.service, withOrder.guestName], [[5], 'Здесь', 'Лео']);
});

test('the venue settings: details, footer lines, Wi-Fi, Instagram, QR and what to hide', () => {
  const settings = normalizeReceiptSettings({
    title: 'Coffee Lab',
    address: 'ул. Абая 10',
    phone: '+7 777 123 45 67',
    taxId: '123456789012',
    header: 'Кофе с собой с 8:00',
    footer: 'Спасибо!\nЖдём снова',
    wifiName: 'Lab_Guest',
    wifiPassword: 'coffee2026',
    instagram: '@coffee.lab',
    qrUrl: 'https://2gis.kz/almaty/firm/70000001234567890',
    showCashier: false,
    showGuest: false,
    showService: false,
    paper: '58',
    copies: 2,
  });
  const r = cafe(counterCheck(), settings);
  assert.deepEqual(r.venue, {
    name: 'Coffee Lab',
    logo: null,
    address: 'ул. Абая 10',
    phone: '+7 777 123 45 67',
    taxId: '123456789012',
    header: 'Кофе с собой с 8:00',
  });
  assert.deepEqual(r.thanks, ['Спасибо!', 'Ждём снова']);
  assert.deepEqual(r.wifi, { name: 'Lab_Guest', password: 'coffee2026' });
  assert.equal(r.instagram, '@coffee.lab');
  assert.equal(r.qr?.url, 'https://2gis.kz/almaty/firm/70000001234567890');
  assert.ok(r.qr!.caption.length <= 30);
  assert.equal(r.cashier, null);
  assert.equal(r.guestName, null);
  assert.equal(r.service, null);
  assert.deepEqual(r.orderNumbers, [17], 'the order number is not a setting');
  assert.equal(r.total, 3700_00, 'amounts are not a setting');
  assert.equal(r.notice, RECEIPT_NOTICE, 'the non-fiscal note is not a setting');
  assert.deepEqual([r.paper, r.copies], ['58', 2]);
});

test('a billiard check looks as before: «Кассир», «Спасибо за игру!», bar lines under their game', () => {
  const game: CheckItemView = {
    id: 'g1',
    kind: 'GAME',
    title: 'Стол 1',
    amount: 4500_00,
    orderId: null,
    qty: null,
    unitPrice: null,
    sessionId: 's1',
    tableId: 't1',
    startedAt: NOW - 90 * 60_000,
    stoppedAt: NOW,
    playedSeconds: 5400,
  };
  const check: CheckView = {
    ...counterCheck(),
    items: [game, item({ id: 'b1', title: 'Чай', qty: 2, unitPrice: 600_00, amount: 1200_00, sessionId: 's1', tableId: 't1' }), item({ id: 'b2', title: 'Пиво', amount: 900_00, sessionId: 's2', tableId: 't2' })],
    subtotal: 6600_00,
    total: 6600_00,
    counter: undefined,
    actorRoles: undefined,
    payments: [payment({ id: 'p1', amount: 6600_00, actor: 'Айгерим', method: 'CARD' })],
  };
  const r = buildReceipt({ check, club: { ...CLUB, name: 'Клуб' }, settings: DEFAULT_RECEIPT_SETTINGS, business: 'billiards', now: NOW, tableNames: new Map([['t2', 'Стол 2']]) });
  assert.deepEqual(r.cashier, { label: 'Кассир', name: 'Айгерим' });
  assert.deepEqual(r.thanks, ['Спасибо за игру!']);
  assert.deepEqual(r.orderNumbers, []);
  assert.equal(r.service, null);
  assert.deepEqual(
    r.groups.map((g) => [g.heading, g.items.map((i) => i.name)]),
    [
      [null, ['Стол 1', 'Чай']],
      ['Бар · Стол 2', ['Пиво']],
    ],
  );
  assert.deepEqual(r.groups[0]!.items[0]!.span, { from: NOW - 90 * 60_000, to: NOW, seconds: 5400 });
  // A billiard club's admin is still «Кассир» on paper, even when the HUB names roles.
  const roles = buildReceipt({ check: { ...check, actorRoles: { Айгерим: 'admin' } }, club: CLUB, settings: DEFAULT_RECEIPT_SETTINGS, business: 'billiards', now: NOW });
  assert.equal(roles.cashier?.label, 'Кассир');
});

test('coffee shop role words on the cashier line', () => {
  const label = (role: 'manager' | 'admin' | 'senior' | 'cashier' | 'waiter' | 'owner') =>
    cafe(counterCheck({ actorRoles: { Данияр: role } })).cashier?.label;
  assert.equal(label('manager'), 'Директор');
  assert.equal(label('admin'), 'Управляющий');
  assert.equal(label('senior'), 'Старший смены');
  assert.equal(label('cashier'), 'Кассир');
  assert.equal(label('waiter'), 'Официант');
  assert.equal(label('owner'), 'Кассир', 'the platform is not a role of the venue');
});

test('splitItemTitle takes the options off the product name only when they match', () => {
  assert.deepEqual(splitItemTitle('Капучино · L · Овсяное', ['L', 'Овсяное']), { name: 'Капучино', options: ['L', 'Овсяное'] });
  assert.deepEqual(splitItemTitle('Капучино', []), { name: 'Капучино', options: [] });
  assert.deepEqual(splitItemTitle('Капучино · L', undefined), { name: 'Капучино · L', options: [] });
  assert.deepEqual(splitItemTitle('Чай · мята', ['лимон']), { name: 'Чай · мята', options: [] });
});

test('groupCheckLines keeps a coffee shop check as one group in the HUB order', () => {
  const groups = groupCheckLines(counterCheck().items);
  assert.equal(groups.length, 2, 'lines without a game: one group each, no heading needed');
  assert.deepEqual(groups.map((g) => g.orders.map((o) => o.id)), [['i1'], ['i2']]);
});

test('settings problems: lengths, characters, BIN/IIN, phone, Instagram, QR link, logo', () => {
  const fields = (patch: Parameters<typeof receiptSettingsProblems>[0]) => receiptSettingsProblems(patch).map((p) => p.field);
  assert.deepEqual(fields({ title: 'Coffee Lab', taxId: '123456789012', phone: '+7 (777) 123-45-67', instagram: '@coffee.lab', qrUrl: 'https://instagram.com/coffee.lab' }), []);
  assert.deepEqual(fields({ title: 'x'.repeat(RECEIPT_LIMITS.title + 1) }), ['title']);
  assert.deepEqual(fields({ title: 'Кофе ☕' }), ['title'], 'emoji print as empty boxes');
  assert.deepEqual(fields({ header: 'a\u0007b' }), ['header']);
  assert.deepEqual(fields({ taxId: '12345' }), ['taxId']);
  assert.deepEqual(fields({ taxId: '12345678901a' }), ['taxId']);
  assert.deepEqual(fields({ phone: 'позвоните' }), ['phone']);
  assert.deepEqual(fields({ instagram: 'кофе' }), ['instagram']);
  assert.deepEqual(fields({ qrUrl: 'javascript:alert(1)' }), ['qrUrl']);
  assert.deepEqual(fields({ qrUrl: 'https://localhost' }), ['qrUrl']);
  assert.deepEqual(fields({ footer: 'раз\nдва\nтри\nчетыре' }), ['footer']);
  assert.deepEqual(fields({ footer: 'Спасибо!\nЖдём снова' }), []);
  assert.deepEqual(fields({ wifiPassword: 'secret' }), ['wifiName'], 'a password without the network name');
  assert.deepEqual(fields({ wifiName: 'Guest', wifiPassword: 'secret' }), []);
  assert.deepEqual(fields({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' }), ['logo'], 'only the converted PNG');
  assert.deepEqual(fields({ logo: `data:image/png;base64,${'A'.repeat(RECEIPT_LIMITS.logo)}` }), ['logo']);
  assert.deepEqual(fields({ logo: 'data:image/png;base64,iVBORw0KGgo=' }), []);
  assert.deepEqual(fields({ paper: '57' as never, copies: 3 as never, showGuest: 'yes' as never }), ['showGuest', 'paper', 'copies']);
  // Blank means «not printed»: never a problem.
  assert.deepEqual(fields({ title: '   ', taxId: '', qrUrl: null }), []);
});

test('normalize keeps the base for missing or broken values and trims what is kept', () => {
  assert.deepEqual(normalizeReceiptSettings(undefined), DEFAULT_RECEIPT_SETTINGS);
  const base = normalizeReceiptSettings({ title: '  Coffee   Lab ', instagram: '@coffee.lab', phone: '+7  777 123 45 67' });
  assert.equal(base.title, 'Coffee Lab');
  assert.equal(base.instagram, 'coffee.lab');
  assert.equal(base.phone, '+7 777 123 45 67');
  const next = normalizeReceiptSettings({ taxId: 'nope', copies: 5, header: 'Утро' }, base);
  assert.equal(next.taxId, null);
  assert.equal(next.copies, 1);
  assert.equal(next.title, 'Coffee Lab');
  assert.equal(next.header, 'Утро');
  assert.equal(normalizeReceiptSettings({ title: null }, base).title, null);
  assert.equal(normalizeReceiptSettings({ footer: ' Спасибо! \n\n Ждём ' }).footer, 'Спасибо!\nЖдём');
});

test('club settings carry the receipt; a patch of something else keeps it', () => {
  assert.deepEqual(DEFAULT_CLUB_SETTINGS.receipt, DEFAULT_RECEIPT_SETTINGS);
  const withReceipt = normalizeClubSettings({ receipt: { title: 'Coffee Lab', paper: '58' } });
  assert.equal(withReceipt.receipt.title, 'Coffee Lab');
  const after = normalizeClubSettings({ display: { theme: 'light' } }, withReceipt);
  assert.equal(after.receipt.title, 'Coffee Lab');
  assert.equal(after.receipt.paper, '58');
});

test('the sample check of the preview is a real, consistent check', () => {
  for (const business of ['cafe', 'billiards'] as const) {
    const check = sampleReceiptCheck(NOW, 'KZT', business);
    const r = buildReceipt({ check, club: CLUB, settings: DEFAULT_RECEIPT_SETTINGS, business, now: NOW });
    const sum = r.groups.flatMap((g) => g.items).reduce((s, i) => s + i.amount, 0);
    assert.equal(sum, r.total, business);
    assert.ok(r.payments[0]!.change! > 0, `${business}: the sample shows change`);
  }
  assert.deepEqual(buildReceipt({ check: sampleReceiptCheck(NOW, 'KZT', 'cafe'), club: CLUB, settings: DEFAULT_RECEIPT_SETTINGS, business: 'cafe', now: NOW }).orderNumbers, [17]);
});

test('qrCaption names where the code leads, short enough for 58 mm', () => {
  assert.equal(qrCaption('https://www.instagram.com/coffee.lab/'), 'instagram.com/coffee.lab');
  assert.ok(qrCaption('https://2gis.kz/almaty/firm/70000001234567890/very/long/path').endsWith('…'));
});
