import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRedeem,
  bonusBalance,
  cashbackAccrual,
  DAY_MS,
  DEFAULT_CLUB_SETTINGS,
  DEFAULT_LOYALTY_SETTINGS,
  formatPhone,
  LoyaltyError,
  maskPhone,
  normalizeClubSettings,
  normalizeLoyaltySettings,
  normalizePhone,
  redeemLimit,
  stampCategories,
  stampPlan,
  stampProgress,
} from '../src/index.ts';

test('phone: KZ numbers in any usual form become +7 and ten digits', () => {
  for (const raw of ['7011234567', '8 701 123 45 67', '+7 (701) 123-45-67', '87011234567', '77011234567', ' 701-123-45-67 ']) {
    assert.equal(normalizePhone(raw), '+77011234567', raw);
  }
  assert.equal(normalizePhone('9161234567'), '+79161234567');
  for (const bad of ['', '12345', '0011234567', '1234567890', '57011234567', '770112345678', null, undefined]) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
});

test('phone: masked everywhere except the manager, who sees it formatted', () => {
  assert.equal(maskPhone('+77011234567'), '+7 ••• ••• 45 67');
  assert.equal(formatPhone('+77011234567'), '+7 701 123 45 67');
  assert.equal(maskPhone('garbage'), '•••');
});

test('settings: off by default, invalid values fall back, patches keep the rest', () => {
  assert.deepEqual(DEFAULT_CLUB_SETTINGS.loyalty, DEFAULT_LOYALTY_SETTINGS);
  assert.equal(DEFAULT_LOYALTY_SETTINGS.enabled, false);
  assert.equal(DEFAULT_LOYALTY_SETTINGS.maxRedeemPercent, 50);
  assert.equal(DEFAULT_LOYALTY_SETTINGS.expiryDays, 180);
  const s = normalizeLoyaltySettings({ enabled: true, program: 'stamps', stampsEvery: 1, cashbackPercent: 70, expiryDays: '0' });
  assert.equal(s.enabled, true);
  assert.equal(s.program, 'stamps');
  assert.equal(s.stampsEvery, 6, 'N=1 would make everything free');
  assert.equal(s.cashbackPercent, 5);
  assert.equal(s.expiryDays, 0);
  const club = normalizeClubSettings({ loyalty: { enabled: true } });
  const next = normalizeClubSettings({ display: { title: 'X' } }, club);
  assert.equal(next.loyalty.enabled, true, 'another section does not reset loyalty');
  assert.equal(normalizeLoyaltySettings({ program: 'points' }).program, 'cashback');
  assert.deepEqual(normalizeLoyaltySettings({ stampCategoryIds: ['a', 'a', 7, 'b'] }).stampCategoryIds, ['a', 'b']);
});

test('stamp categories: chosen ones, else every «Кофе…» category', () => {
  const cats = [
    { id: 'c1', name: 'Кофе' },
    { id: 'c2', name: 'Кофе без кофеина' },
    { id: 'c3', name: 'Выпечка' },
  ];
  assert.deepEqual([...stampCategories({ stampCategoryIds: [] }, cats)], ['c1', 'c2']);
  assert.deepEqual([...stampCategories({ stampCategoryIds: ['c3', 'gone'] }, cats)], ['c3']);
  assert.deepEqual([...stampCategories({ stampCategoryIds: ['gone'] }, cats)], ['c1', 'c2']);
});

test('cashback: percent of what was paid, rounded down to whole tenge', () => {
  assert.equal(cashbackAccrual(1_850_00, 5, 100), 92_00);
  assert.equal(cashbackAccrual(99_00, 1, 100), 0);
  assert.equal(cashbackAccrual(0, 5, 100), 0);
  assert.equal(cashbackAccrual(1000, 10), 100);
});

test('redemption: at most the share of the check and the balance, whole tenge', () => {
  assert.equal(redeemLimit({ subtotal: 2_000_00, balance: 450_00, maxPercent: 50, step: 100 }), 450_00);
  assert.equal(redeemLimit({ subtotal: 700_00, balance: 450_00, maxPercent: 50, step: 100 }), 350_00);
  assert.equal(redeemLimit({ subtotal: 1_001_00, balance: 10_000_00, maxPercent: 33, step: 100 }), 330_00);
  assert.equal(redeemLimit({ subtotal: 1_000_00, balance: 450_50, maxPercent: 100, step: 100 }), 450_00);
  assert.equal(redeemLimit({ subtotal: 1_000_00, balance: 450_00, maxPercent: 0, step: 100 }), 0);
  assert.equal(assertRedeem(300_00, 350_00, 100), 300_00);
  assert.throws(() => assertRedeem(400_00, 350_00, 100), (e: unknown) => e instanceof LoyaltyError && e.code === 'LOYALTY_REDEEM_LIMIT');
  assert.throws(() => assertRedeem(150_50, 350_00, 100), /целыми/);
  assert.throws(() => assertRedeem(0, 350_00, 100), /положительное/);
});

test('bonus balance: credits expire after M days, debits take the oldest first', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const moves = [
    { at: t0, amount: 100 },
    { at: t0 + 10 * DAY_MS, amount: 200 },
    { at: t0 + 20 * DAY_MS, amount: -150 }, // takes 100 of the first lot and 50 of the second
  ];
  assert.deepEqual(bonusBalance(moves, t0 + 21 * DAY_MS, 180), {
    balance: 150,
    expiring: { amount: 150, at: t0 + 190 * DAY_MS },
    expired: 0,
  });
  // The first lot was spent in full, so nothing burns on day 180; the second burns on day 190.
  assert.equal(bonusBalance(moves, t0 + 185 * DAY_MS, 180).balance, 150);
  assert.deepEqual(bonusBalance(moves, t0 + 191 * DAY_MS, 180), { balance: 0, expiring: null, expired: 150 });
  // 0 = never.
  assert.deepEqual(bonusBalance(moves, t0 + 5000 * DAY_MS, 0), { balance: 150, expiring: null, expired: 0 });
});

test('bonus balance: an expired lot cannot be spent; a refund larger than the balance is a debt', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const burnt = [
    { at: t0, amount: 100 },
    { at: t0 + 40 * DAY_MS, amount: -100 },
  ];
  assert.deepEqual(bonusBalance(burnt, t0 + 41 * DAY_MS, 30), { balance: 0, expiring: null, expired: 100 });
  const debt = [
    { at: t0, amount: 100 },
    { at: t0 + DAY_MS, amount: -100 }, // spent
    { at: t0 + 2 * DAY_MS, amount: -50 }, // a refund takes back bonuses that are gone
    { at: t0 + 3 * DAY_MS, amount: 80 }, // the next accrual pays the debt off first
  ];
  assert.equal(bonusBalance(debt, t0 + 4 * DAY_MS, 180).balance, 30);
  assert.equal(bonusBalance(debt, t0 + 2.5 * DAY_MS, 180).balance, 0, 'never negative');
  assert.equal(bonusBalance([{ at: t0 + DAY_MS, amount: 100 }], t0, 180).balance, 0, 'future moves are ignored');
});

test('stamps: the N-th unit is free, the cheapest qualifying one, within one check too', () => {
  // 4 of 6 and three coffees: one earns the 5th stamp, the next is the 6th — free.
  assert.deepEqual(stampPlan({ stamps: 4, every: 6, units: [1200, 900, 1500], applyFree: true }), {
    free: 1,
    freePrices: [900],
    discount: 900,
    earned: 2,
    used: 5,
    after: 1,
  });
  // Declined: every unit earns a stamp, the gift waits.
  assert.deepEqual(stampPlan({ stamps: 5, every: 6, units: [1200], applyFree: false }), {
    free: 0,
    freePrices: [],
    discount: 0,
    earned: 1,
    used: 0,
    after: 6,
  });
  // Not due yet.
  assert.equal(stampPlan({ stamps: 1, every: 6, units: [1200, 1200], applyFree: true }).free, 0);
  // Six coffees from zero: five paid, the sixth free.
  const six = stampPlan({ stamps: 0, every: 6, units: [1000, 1000, 1000, 1000, 1000, 800], applyFree: true });
  assert.deepEqual({ free: six.free, discount: six.discount, earned: six.earned, after: six.after }, { free: 1, discount: 800, earned: 5, after: 0 });
  // A saved-up card (11 of 6 after declines) gives two gifts.
  assert.equal(stampPlan({ stamps: 10, every: 6, units: [1000, 1000], applyFree: true }).free, 2);
  // Nothing qualifying, nothing happens.
  assert.deepEqual(stampPlan({ stamps: 5, every: 6, units: [], applyFree: true }).after, 5);
});

test('stamp progress: «3 из 6», ready at N − 1', () => {
  assert.deepEqual(stampProgress(3, 6), { have: 3, of: 6, ready: false });
  assert.deepEqual(stampProgress(5, 6), { have: 5, of: 6, ready: true });
});
