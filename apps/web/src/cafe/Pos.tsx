import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import type {
  CreateCounterOrderResponse,
  Minor,
  PaymentMethod,
  ProductOptionGroup,
  ProductView,
} from '@bills/domain';
import {
  COUNTER_SERVICE_LABEL,
  defaultChoices,
  formatMoney,
  GUEST_NAME_MAX,
  minorPerMajor,
  ORDER_MAX_QTY,
  parseMoney,
  redeemLimit,
  stampCategories,
  stampPlan,
} from '@bills/domain';
import type { LoyaltyApplyRequest } from '@bills/domain';
import { newKey } from '../api.ts';
import { toActionError, useDesk } from '../cash/desk.ts';
import { METHOD_LABEL } from '../cash/format.ts';
import { Modal } from '../cash/Modal.tsx';
import { printCounterReceipt } from '../cash/print/Receipt.tsx';
import { OpenShiftForm } from '../cash/ShiftPanel.tsx';
import { Icon } from '../icons.tsx';
import { OfflineBanner } from '../OfflineBanner.tsx';
import { sellable, sortCatalog } from '../pages/bar/useCatalog.tsx';
import type { StockTileHint } from '../stock/alerts.ts';
import { useStockHints } from '../stock/alerts.ts';
import { GuestPad } from '../loyalty/GuestPad.tsx';
import type { PickedGuest } from '../loyalty/GuestPad.tsx';
import { earnedLine, giftOrdinal, guestChip, loyaltyOf } from '../loyalty/model.ts';
import { Loading } from '../ui.tsx';
import { useHub } from '../useHub.tsx';
import { createCounterOrder, optionsOf, useCachedCatalog } from './cafe.ts';
import { takeGuestCounterOrder } from '../guest/api.ts';
import { draftOfGuestOrder, PosGuestOrders } from '../guest/PosGuestOrders.tsx';
import type { Draft, Flash, Held, Line } from './pos-model.ts';
import {
  buildRequest,
  categoryHue,
  COMMENT_PRESETS,
  emptyDraft,
  HELD_MAX,
  lineComment,
  lineId,
  LOW_STOCK,
  paymentParts,
  quickTenders,
  readAutoPrint,
  readHeld,
  readLast,
  recordHits,
  recordUsual,
  sameChoices,
  searchProducts,
  toggleChoice,
  topProducts,
  topUsual,
  tryPrice,
  writeAutoPrint,
  writeHeld,
  writeLast,
} from './pos-model.ts';
import './cafe.css';
import { EditGrid, lookStyle, TileBadge, TilePhoto } from './edit/EditGrid.tsx';
import type { PayLine } from './PayStep.tsx';
import { PAY_COMPACT, PayStep } from './PayStep.tsx';
import type { TileLook } from './edit/useTileLook.ts';
import { ordered, useTileLook } from './edit/useTileLook.ts';
// Last: phone, tablet and touch layout over the shared café styles.
import './pos-touch.css';
import './pos-polish.css';

const HITS = 'hits';
/** The «Заказ 17» card stays this long after the HUB confirmed, then the counter is ready for the next guest. */
const FLASH_MS = 3000;
/**
 * Phone: the card sits over the bar and blocks nothing (the next drink can be tapped at once), so
 * it stays longer — the waiter looks up from the guest and still reads «Заказ 17 отправлен бариста».
 */
const FLASH_DOCKED_MS = 6000;
/**
 * The full-screen payment step: «Заказ 17 · Сдача 450 ₸» stays this long after the HUB confirmed
 * (or until a tap), then the counter is empty for the next guest. With change to hand back it
 * stays a second longer — the cashier reads the sum while counting the coins.
 */
const STEP_DONE_MS = 2000;
const STEP_CHANGE_MS = 3000;

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const on = () => setOn(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return on;
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

/** Phones (a waiter on the floor): the order is a bottom sheet, categories and the pay button sit under the thumb. */
const PHONE = '(max-width: 767px)';

/**
 * Phone: tells the stylesheet how tall the app's tab bar is (`--pos-nav-h`, 0 when there is none)
 * and how tall the counter's own bottom dock is (`--pos-dock-h`), so the dock sits right on the
 * tab bar and the last tiles scroll clear of both. Measured, not guessed: safe areas, a bigger
 * system font or another tab bar all just work.
 */
function useBottomChrome(on: boolean, host: RefObject<HTMLElement | null>, dock: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = host.current;
    if (!on || !el) return;
    const nav = document.querySelector<HTMLElement>('.bottom-nav') ?? document.querySelector<HTMLElement>('nav[aria-label="Разделы"]');
    const update = () => {
      const navH = nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().height : 0;
      el.style.setProperty('--pos-nav-h', `${Math.round(navH)}px`);
      el.style.setProperty('--pos-dock-h', `${Math.round(dock.current?.getBoundingClientRect().height ?? 0)}px`);
    };
    update();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    if (nav) ro?.observe(nav);
    if (dock.current) ro?.observe(dock.current);
    window.addEventListener('resize', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      el.style.removeProperty('--pos-nav-h');
      el.style.removeProperty('--pos-dock-h');
    };
  }, [on, host, dock]);
}

/**
 * #/pos — «Касса» of a coffee shop. A tap on a drink adds it at once with the
 * usual options and opens its chips right next to the line; money is one more
 * tap (card, QR, cash without change) or two (cash with a round sum). The
 * order is cleared and «Заказ 17» shown at once; the HUB request runs in the
 * background with an idempotency key, and a refusal brings the order back.
 */
export function PosPage() {
  const hub = useHub();
  const { state, online, actor, canNow, blockedReason } = hub;
  const { currency } = state.club;
  const money = useCallback((a: Minor) => formatMoney(a, currency), [currency]);
  const desk = useDesk({ state, actor, refresh: hub.refresh, notify: hub.notify });
  const { catalog, error: catalogError } = useCachedCatalog(hub.version);
  const narrow = useMedia(PHONE);
  const payCompact = useMedia(PAY_COMPACT);
  const sectionRef = useRef<HTMLElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  // «Редактировать дизайн»: the owner dresses the tiles in place; selling is paused meanwhile.
  const [designing, setDesigning] = useState(false);
  const tileLook = useTileLook();

  const [draft, setDraft] = useState<Draft>(() => emptyDraft());
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<string>(HITS);
  const [query, setQuery] = useState('');
  const [multiplier, setMultiplier] = useState<number | null>(null);
  const [qtyPad, setQtyPad] = useState(false);
  const [mode, setMode] = useState<'order' | 'pay'>('order');
  const [tendered, setTendered] = useState('');
  const [flash, setFlash] = useState<Flash | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [held, setHeld] = useState<Held[]>(readHeld);
  const [cleared, setCleared] = useState<Draft | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [autoPrint, setAutoPrint] = useState(readAutoPrint);
  const [shiftDialog, setShiftDialog] = useState(false);
  const [hitsVersion, setHitsVersion] = useState(0);
  // Stock taken by orders still on their way to the HUB: the tiles do not oversell meanwhile.
  const [pendingStock, setPendingStock] = useState<ReadonlyMap<string, number>>(new Map());
  // A restored order keeps its idempotency key: paying it again is not a second order.
  const retryKey = useRef<{ body: string; key: string } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // «Гость» (loyalty): picked on a keypad, the reward is one tap; both reset with the order.
  const loyalty = useMemo(() => loyaltyOf(state.settings), [state.settings]);
  const [guest, setGuest] = useState<PickedGuest | null>(null);
  const [guestOpen, setGuestOpen] = useState(false);
  const [reward, setReward] = useState(false);

  useEffect(() => writeHeld(held), [held]);

  // ── Menu ──────────────────────────────────────────────────────────────────
  const sorted = useMemo(() => (catalog ? sortCatalog(catalog) : null), [catalog]);
  const products = useMemo(() => (catalog ? sellable(catalog) : []), [catalog]);
  const byId = useMemo(() => new Map((sorted?.products ?? []).map((p) => [p.id, p])), [sorted]);
  const categories = useMemo(
    () => (sorted?.categories ?? []).filter((c) => c.isActive && products.some((p) => p.categoryId === c.id)),
    [sorted, products],
  );
  const hueOf = useMemo(() => new Map(categories.map((c, i) => [c.id, categoryHue(i)])), [categories]);
  const hits = useMemo(() => topProducts(products), [products, hitsVersion]);
  // «Как обычно»: the drinks with their options this counter sells most at this time of day.
  const usual = useMemo(() => topUsual(products), [products, hitsVersion]);
  const activeTab = tab === HITS || categories.some((c) => c.id === tab) ? tab : HITS;
  // The field answers every key at once; the tiles follow a beat later (no jank on a slow phone).
  const deferredQuery = useDeferredValue(query);
  const shown = useMemo(() => {
    if (deferredQuery.trim()) return searchProducts(products, deferredQuery);
    if (activeTab === HITS) return hits;
    return products.filter((p) => p.categoryId === activeTab);
  }, [deferredQuery, products, activeTab, hits]);

  const available = useCallback(
    (p: ProductView) => Math.min(ORDER_MAX_QTY, p.stock === null ? ORDER_MAX_QTY : Math.max(0, p.stock - (pendingStock.get(p.id) ?? 0))),
    [pendingStock],
  );
  const qtyOf = (productId: string, except?: string) =>
    draft.lines.reduce((n, l) => (l.productId === productId && l.id !== except ? n + l.qty : n), 0);

  // ── The order ─────────────────────────────────────────────────────────────
  const priced = draft.lines.map((l) => {
    const product = byId.get(l.productId);
    const price = product ? tryPrice(product, l.choices) : { priced: null, problem: 'Товара больше нет в меню' };
    return { line: l, product, ...price };
  });
  const total = priced.reduce((sum, p) => sum + (p.priced ? p.priced.unitPrice * p.line.qty : 0), 0);

  // ── Loyalty: what the guest could get on this order (the HUB checks the same rules) ──
  const stampCats = useMemo(() => stampCategories(loyalty, sorted?.categories ?? []), [loyalty, sorted]);
  const offer = (() => {
    if (!loyalty.enabled || !guest) return null;
    if (loyalty.program === 'stamps') {
      const units = priced.flatMap((p) =>
        p.priced && p.product && stampCats.has(p.product.categoryId) ? Array<Minor>(p.line.qty).fill(p.priced.unitPrice) : [],
      );
      const plan = stampPlan({ stamps: guest.card.stamps, every: loyalty.stampsEvery, units, applyFree: true });
      if (plan.free === 0 || plan.discount === 0) return null;
      const coffee = (sorted?.categories ?? []).filter((c) => stampCats.has(c.id)).every((c) => /^\s*кофе/i.test(c.name));
      const what = `${giftOrdinal(loyalty.stampsEvery)} ${coffee ? 'кофе' : 'напиток'}`;
      return { kind: 'FREE' as const, discount: plan.discount, ask: `${what} в подарок — применить?`, done: `${what} в подарок` };
    }
    const max = redeemLimit({ subtotal: total, balance: guest.card.bonus, maxPercent: loyalty.maxRedeemPercent, step: minorPerMajor(currency) });
    if (max <= 0) return null;
    return { kind: 'BONUS' as const, discount: max, ask: `Списать ${money(max)} бонусами?`, done: 'Бонусами' };
  })();
  const loyaltyDiscount = reward && offer ? offer.discount : 0;
  /** What the guest pays in money: the order minus the loyalty reward. */
  const due = total - loyaltyDiscount;
  const count = draft.lines.reduce((n, l) => n + l.qty, 0);
  const broken = priced.some((p) => !p.priced || !p.product?.isActive);
  const empty = draft.lines.length === 0;

  const noShift = state.shift === null;
  const canOrder = canNow('counter.take');
  const canDesign = canNow('catalog.edit');
  const orderBlocked = blockedReason('counter.take');
  // Money with the order needs `payment.take` too (the HUB checks it): a plain waiter sends the
  // order to the barista and the till settles the check later. Without an open shift nobody takes
  // money either. Then the screen offers «Отправить бариста» instead of pay buttons that do nothing.
  const canTakeMoney = canNow('payment.take');
  const payNow = canTakeMoney && !noShift;
  const canSend = online && canOrder && !empty && !broken;
  const canPayNow = canSend && payNow;
  // «Оплатить» opens the full-screen payment step (offline too: it says why the money must wait).
  const canOpenPay = payNow && canOrder && !empty && !broken;

  const patchLines = (fn: (lines: Line[]) => Line[]) => setDraft((d) => ({ ...d, lines: fn(d.lines) }));

  const inOrderKey = draft.lines.map((l) => `${l.productId}:${l.qty}`).join(',');
  const inOrder = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of draftRef.current.lines) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inOrderKey]);

  /** A tile adds the drink with its default options; «Как обычно» passes the options it remembers. */
  const tapProduct = (p: ProductView, picked?: readonly string[]) => {
    setFlash(null);
    setFailure(null);
    setCleared(null);
    setMode('order');
    const want = multiplier ?? 1;
    setMultiplier(null);
    setQtyPad(false);
    const room = available(p) - qtyOf(p.id);
    if (room <= 0) {
      hub.notify(p.stock !== null ? `${p.name}: больше нет в наличии` : `Не больше ${ORDER_MAX_QTY} шт.`);
      return;
    }
    const add = Math.min(want, room);
    const options = optionsOf(p);
    const defaults = picked ? [...picked] : defaultChoices(options);
    // Options already chosen («Как обычно»): nothing to open under the line.
    const open = options.length > 0 && !picked;
    // The same drink with the same options and no comment: one more on that line.
    const same = draft.lines.find((l) => l.productId === p.id && sameChoices(l.choices, defaults) && !lineComment(l));
    if (same) {
      patchLines((ls) => ls.map((l) => (l.id === same.id ? { ...l, qty: l.qty + add } : l)));
      setSelected(open ? same.id : null);
    } else {
      const line: Line = { id: lineId(), productId: p.id, choices: defaults, qty: add, comments: [], text: '' };
      patchLines((ls) => [...ls, line]);
      setSelected(open ? line.id : null);
    }
    if (query) setQuery('');
    // Phone: the keyboard goes away, so the drink's chips and the total show at the bottom.
    if (narrow && document.activeElement === searchRef.current) searchRef.current?.blur();
  };
  const tapRef = useRef(tapProduct);
  tapRef.current = tapProduct;
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const onTap = useCallback((id: string) => {
    const p = byIdRef.current.get(id);
    if (p) tapRef.current(p);
  }, []);

  const setQty = (id: string, qty: number) => {
    const line = draft.lines.find((l) => l.id === id);
    if (!line) return;
    const product = byId.get(line.productId);
    const cap = product ? available(product) - qtyOf(line.productId, id) : line.qty;
    const next = Math.min(cap, qty);
    if (next <= 0) {
      patchLines((ls) => ls.filter((l) => l.id !== id));
      if (selected === id) setSelected(null);
    } else patchLines((ls) => ls.map((l) => (l.id === id ? { ...l, qty: next } : l)));
  };
  const updateLine = (id: string, patch: Partial<Line>) => patchLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const dropGuest = () => {
    setGuest(null);
    setReward(false);
    setGuestOpen(false);
  };

  const pickGuest = (g: PickedGuest) => {
    setGuest(g);
    setReward(false);
    setGuestOpen(false);
    // The name goes to the guest screen as well, unless the cashier typed one.
    if (g.name && !draftRef.current.guestName.trim()) setDraft((d) => ({ ...d, guestName: g.name }));
  };

  const clearOrder = () => {
    if (!empty) setCleared(draftRef.current);
    dropGuest();
    setDraft((d) => emptyDraft(d.service));
    setSelected(null);
    setMode('order');
    setTendered('');
    retryKey.current = null;
  };

  const loadDraft = (d: Draft, key?: Held['key']) => {
    setDraft({ ...d, lines: d.lines.map((l) => ({ ...l, id: lineId() })) });
    setSelected(null);
    setMode('order');
    setFlash(null);
    retryKey.current = key ?? null;
  };

  const park = () => {
    if (empty) return;
    setHeld((h) => [{ id: lineId(), at: Date.now(), draft: draftRef.current, ...(retryKey.current ? { key: retryKey.current } : {}) }, ...h].slice(0, HELD_MAX));
    dropGuest();
    setDraft((d) => emptyDraft(d.service));
    setSelected(null);
    setMode('order');
    retryKey.current = null;
    setSheetOpen(false);
  };

  const recall = (h: Held) => {
    setHeld((list) => {
      const rest = list.filter((x) => x.id !== h.id);
      return empty ? rest : [{ id: lineId(), at: Date.now(), draft: draftRef.current }, ...rest].slice(0, HELD_MAX);
    });
    loadDraft(h.draft, h.key);
    setFailure(h.failed ?? null);
  };

  // ── Money ─────────────────────────────────────────────────────────────────
  const typed = tendered === '' ? null : parseMoney(tendered, currency);

  /**
   * Sends the order with its payment and clears the counter at once. On a
   * refusal the order comes back (or is parked, when the next one is already
   * being typed) with the HUB's message.
   */
  const pay = (method: PaymentMethod | null, opts: { tendered?: Minor; rest?: 'CARD' | 'QR' } = {}) => {
    if (!canSend || (method !== null && !payNow)) {
      if (method !== null && !canTakeMoney) setFailure('Оплату принимает кассир — отправьте заказ без оплаты');
      else if (method !== null && noShift) setFailure('Смена не открыта — оплату принять нельзя');
      return;
    }
    const d = draftRef.current;
    const amount = due;
    const cash = opts.tendered ?? null;
    if (method === 'CASH' && !opts.rest && cash !== null && cash < amount) return;
    const split = opts.rest && cash !== null ? { cash, rest: opts.rest } : undefined;
    const payment = paymentParts(amount, method, cash, split);
    const applied = reward && offer ? offer : null;
    const pickedGuest = guest;
    const loyaltyBody: LoyaltyApplyRequest | null =
      pickedGuest && loyalty.enabled
        ? {
            phone: pickedGuest.digits,
            ...(!pickedGuest.known && pickedGuest.name ? { name: pickedGuest.name } : {}),
            ...(applied?.kind === 'BONUS' ? { redeem: applied.discount } : {}),
            ...(applied?.kind === 'FREE' ? { free: true } : {}),
            expectDiscount: applied ? applied.discount : 0,
          }
        : null;
    const body = { ...buildRequest(d, byId, payment), ...(loyaltyBody ? { loyalty: loyaltyBody } : {}) };
    const json = JSON.stringify(body);
    const key = retryKey.current?.body === json ? retryKey.current.key : newKey();
    const id = key;
    const change = method === 'CASH' && !split && cash !== null ? Math.max(0, cash - amount) : 0;
    const rest = split && amount - Math.min(cash!, amount) > 0 ? { method: split.rest as PaymentMethod, amount: amount - Math.min(cash!, amount) } : null;
    const taken = new Map<string, number>();
    for (const l of d.lines) taken.set(l.productId, (taken.get(l.productId) ?? 0) + l.qty);

    // Paid in the full-screen step: its screen shows «Заказ 17 · Сдача 450 ₸»; a one-tap button: the card over the order.
    const where = mode === 'pay' ? 'step' : 'panel';
    setFlash({ id, state: 'sending', method, total: amount, change, rest, service: d.service, guestName: d.guestName.trim(), where });
    setFailure(null);
    setCleared(null);
    dropGuest();
    setDraft(emptyDraft(d.service));
    setSelected(null);
    setMode('order');
    setTendered('');
    setSheetOpen(false);
    retryKey.current = null;
    setPendingStock((m) => addStock(m, taken, 1));

    (d.guestRequestId ? takeGuestCounterOrder(actor, d.guestRequestId, body, key) : createCounterOrder(actor, body, key))
      .then((res) => {
        writeLast({ ...d, guestRequestId: undefined });
        recordHits(d.lines);
        recordUsual(d.lines);
        setHitsVersion((v) => v + 1);
        setFlash((f) => (f?.id === id ? { ...f, state: 'ok', res, loyaltyNote: earnedLine(res.loyalty, loyalty, currency) } : f));
        if (readAutoPrint()) printCounterReceipt(res, state);
      })
      .catch((e: unknown) => {
        const message = toActionError(e).message;
        const back = { body: json, key };
        if (draftRef.current.lines.length === 0) {
          setDraft(d);
          setGuest(pickedGuest);
          setReward(applied !== null);
          retryKey.current = back;
          setFailure(`Заказ не прошёл: ${message}. Он снова в корзине — исправьте и оплатите ещё раз.`);
        } else {
          setHeld((h) => [{ id: lineId(), at: Date.now(), draft: d, key: back, failed: message }, ...h].slice(0, HELD_MAX));
          setFailure(`Предыдущий заказ не прошёл: ${message}. Он в «Отложенных».`);
        }
        setFlash((f) => (f?.id === id ? { ...f, state: 'failed', error: message } : f));
        void hub.refresh();
      })
      .finally(() => setPendingStock((m) => addStock(m, taken, -1)));
  };

  // The confirmation goes away by itself: the counter is ready for the next guest.
  const flashMs =
    flash?.where === 'step' ? (flash.change > 0 ? STEP_CHANGE_MS : STEP_DONE_MS) : narrow ? FLASH_DOCKED_MS : FLASH_MS;
  useEffect(() => {
    if (flash?.state !== 'ok') return;
    const t = setTimeout(() => setFlash((f) => (f?.id === flash.id ? null : f)), flashMs);
    return () => clearTimeout(t);
  }, [flash?.state, flash?.id, flashMs]);

  // ── Keyboard (desktop counter) ────────────────────────────────────────────
  // The full-screen payment step (a <dialog>) has keys of its own: PayStep.tsx.
  const stepOpen = mode === 'pay' || flash?.where === 'step';
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (stepOpen || designing || shiftDialog || guestOpen || document.querySelector('dialog[open]')) return;
    const typing = isTyping(e.target);
    if (e.key === 'Escape') {
      if (typing) (e.target as HTMLElement).blur();
      if (flash) setFlash(null);
      else if (qtyPad) setQtyPad(false);
      else if (query) setQuery('');
      else if (selected) setSelected(null);
      else if (multiplier) setMultiplier(null);
      else if (sheetOpen) setSheetOpen(false);
      else clearOrder();
      e.preventDefault();
      return;
    }
    if (typing) return;
    if (e.key === '/') {
      searchRef.current?.focus();
      e.preventDefault();
      return;
    }
    if (e.key === 'F1' || e.key === 'F2' || e.key === 'F3') {
      e.preventDefault();
      if (!payNow) return;
      if (e.key === 'F1') {
        if (canOpenPay) setMode('pay');
      } else pay(e.key === 'F2' ? 'CARD' : 'QR');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^\d$/.test(e.key)) {
      setMultiplier((m) => Math.min(99, (m ?? 0) * 10 + Number(e.key)) || null);
      e.preventDefault();
      return;
    }
    if (e.key === 'Backspace') {
      setMultiplier((m) => (m && m >= 10 ? Math.floor(m / 10) : null));
      e.preventDefault();
      return;
    }
    if ((e.key === '+' || e.key === '-') && !empty) {
      const target = draft.lines.find((l) => l.id === selected) ?? draft.lines[draft.lines.length - 1]!;
      setQty(target.id, target.qty + (e.key === '+' ? 1 : -1));
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      if (e.target instanceof HTMLButtonElement) return;
      e.preventDefault();
      // Without money (a waiter, or no shift yet) Enter sends the order to the barista.
      if (!payNow) pay(null);
      else pay('CASH');
      return;
    }
    if (e.key === ' ' && !(e.target instanceof HTMLButtonElement) && canOpenPay) {
      e.preventDefault();
      setMode('pay');
      return;
    }
    // Letters start a search, like on a desktop POS.
    if (e.key.length === 1 && /\p{L}/u.test(e.key)) {
      searchRef.current?.focus();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // Selling without money (a waiter, or no shift yet): the payment view has nothing to offer.
  useEffect(() => {
    if (!payNow && mode === 'pay') setMode('order');
  }, [payNow, mode]);

  useBottomChrome(narrow && sorted !== null, sectionRef, dockRef);

  // ── Tiles ─────────────────────────────────────────────────────────────────
  // «мало: молоко» / «закончилось: молоко» from the recipe and the levels of «Склад»: a hint only, the sale goes through.
  const stockHints = useStockHints();
  const tiles = useMemo(
    () =>
      ordered(shown, tileLook.looks.order).map((p) => {
        const options = optionsOf(p);
        const price = options.length ? (tryPrice(p, defaultChoices(options)).priced?.unitPrice ?? p.price) : p.price;
        const left = p.stock === null ? null : Math.max(0, p.stock - (pendingStock.get(p.id) ?? 0));
        return {
          id: p.id,
          name: p.name,
          price: money(price),
          hue: hueOf.get(p.categoryId) ?? 55,
          count: inOrder.get(p.id) ?? 0,
          out: left === 0,
          low: left !== null && left > 0 && left <= LOW_STOCK ? left : null,
          options: options.length > 0,
          hint: stockHints.get(p.id) ?? null,
        };
      }),
    [shown, pendingStock, inOrder, hueOf, money, tileLook.looks.order, stockHints],
  );

  if (!sorted) {
    return <section className="page">{catalogError ? <p className="bar-error">{catalogError}</p> : <Loading online={online} />}</section>;
  }

  const selectedLine = priced.find((p) => p.line.id === selected) ?? null;
  // Phone with the order folded: the drink's chips dock at the bottom, over the total and the pay
  // button (no dialog, the menu stays usable). In the open order and on wider screens they open
  // right under the line.
  const docked = narrow && !sheetOpen;
  const optionsPanel =
    selectedLine?.product && optionsOf(selectedLine.product).length > 0 ? (
      <OptionsPanel
        key={selectedLine.line.id}
        line={selectedLine.line}
        groups={optionsOf(selectedLine.product)}
        title={selectedLine.product.name}
        currency={currency}
        problem={selectedLine.problem}
        docked={docked}
        sum={selectedLine.priced ? money(selectedLine.priced.unitPrice * selectedLine.line.qty) : null}
        canMore={qtyOf(selectedLine.line.productId) < available(selectedLine.product)}
        onQty={(qty) => setQty(selectedLine.line.id, qty)}
        onChoices={(choices) => updateLine(selectedLine.line.id, { choices })}
        onComments={(comments) => updateLine(selectedLine.line.id, { comments })}
        onText={(text) => updateLine(selectedLine.line.id, { text })}
        onClose={() => setSelected(null)}
      />
    ) : null;
  const plainComment =
    selectedLine?.product && optionsOf(selectedLine.product).length === 0 ? selectedLine : null;
  const dockPanel = docked
    ? (optionsPanel ??
      (plainComment ? (
        <CommentPanel
          line={plainComment.line}
          title={plainComment.product!.name}
          docked
          onComments={(comments) => updateLine(plainComment.line.id, { comments })}
          onText={(text) => updateLine(plainComment.line.id, { text })}
          onClose={() => setSelected(null)}
        />
      ) : null))
    : null;

  const searching = query.trim().length > 0;
  const last = empty ? readLast() : null;
  const pickTab = (id: string) => {
    setTab(id);
    setQuery('');
  };
  const doneFlash = flash && flash.where === 'panel' ? (
    <DoneFlash
      flash={flash}
      currency={currency}
      docked={narrow}
      ms={flashMs}
      onClose={() => setFlash(null)}
      onPrint={(res) => printCounterReceipt(res, state)}
    />
  ) : null;

  return (
    <section
      ref={sectionRef}
      className="page pos"
      data-mode={mode}
      data-layout={narrow ? 'phone' : 'split'}
      data-sheet={(narrow && sheetOpen) || undefined}
      // A tapped button does not keep the focus: Enter and Space stay the counter's hotkeys.
      onMouseDown={(e) => {
        if (e.target instanceof Element && e.target.closest('button')) e.preventDefault();
      }}
    >
      <OfflineBanner online={online} />
      {orderBlocked && <p className="blocked-note">{orderBlocked}</p>}
      <div className="pos-grid">
        <div className="pos-menu">
          <div className="pos-toolbar">
            <label className="pos-search">
              <Icon name="search" size={20} />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="Поиск по меню"
                aria-label="Поиск по меню"
                autoComplete="off"
                enterKeyHint="go"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && shown[0]) {
                    e.preventDefault();
                    tapProduct(shown[0]);
                  }
                }}
              />
              {searching && (
                <button type="button" className="pos-search-clear" aria-label="Очистить поиск" onClick={() => setQuery('')}>
                  <Icon name="close" size={18} />
                </button>
              )}
              <kbd className="pos-kbd">/</kbd>
            </label>
            <div className="pos-mult-wrap">
              <button
                type="button"
                className="pos-mult"
                aria-pressed={multiplier !== null}
                aria-expanded={qtyPad}
                aria-label="Количество для следующего товара"
                onClick={() => setQtyPad((o) => !o)}
              >
                ×{multiplier ?? 'N'}
              </button>
              {qtyPad && (
                <div className="pos-mult-pad" role="group" aria-label="Сколько штук добавить">
                  {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={multiplier === n}
                      onClick={() => {
                        setMultiplier(n);
                        setQtyPad(false);
                      }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* The tiles' look is part of the menu: the manager's and the administrator's (catalog.edit). */}
            {canDesign && (
              <button
                type="button"
                className="ts-design-toggle"
                aria-pressed={designing}
                aria-label={designing ? 'Готово' : 'Редактировать дизайн'}
                onClick={() => setDesigning((d) => !d)}
              >
                <span aria-hidden="true">✎</span>{' '}
                <span className="ts-design-toggle-text">{designing ? 'Готово' : 'Редактировать дизайн'}</span>
              </button>
            )}
          </div>
          {multiplier !== null && (
            <p className="pos-mult-note" role="status">
              Следующий товар добавится ×{multiplier}
              <button type="button" className="link" onClick={() => setMultiplier(null)}>
                отменить
              </button>
            </p>
          )}

          {/* Phone: the categories live at the bottom, under the thumb (the dock below). */}
          {!narrow && <CategoryTabs categories={categories} hueOf={hueOf} active={activeTab} searching={searching} onTab={pickTab} />}

          {/* «Как обычно»: one tap, the drink with its usual options; only on «Хиты», not while searching. */}
          {activeTab === HITS && !searching && !designing && usual.length > 0 && (
            <div className="pos-usual" role="group" aria-label="Как обычно">
              <span className="pos-usual-title">Как обычно</span>
              <div className="pos-usual-list">
                {usual.map((u) => (
                  <button
                    key={`${u.product.id}|${u.choices.join(',')}`}
                    type="button"
                    className="pos-usual-chip"
                    style={{ '--hue': hueOf.get(u.product.categoryId) } as CSSProperties}
                    onClick={() => tapProduct(u.product, u.choices)}
                  >
                    <span className="pos-usual-name">{u.product.name}</span>
                    <span className="pos-usual-opts">{u.options}</span>
                    <strong className="pos-usual-price">{money(u.price)}</strong>
                  </button>
                ))}
              </div>
            </div>
          )}

          {products.length === 0 ? (
            <p className="empty">В меню пока нет товаров. Добавьте их в разделе «Меню».</p>
          ) : tiles.length === 0 ? (
            <p className="empty pos-noresult">Ничего не нашлось по «{deferredQuery}».</p>
          ) : designing && canDesign ? (
            <EditGrid
              tiles={tiles}
              looks={tileLook.looks.tiles}
              patch={tileLook.patch}
              reorder={tileLook.reorder}
              reset={tileLook.reset}
              undo={tileLook.undo}
              onDone={() => setDesigning(false)}
            />
          ) : (
            <MenuGrid tiles={tiles} looks={tileLook.looks.tiles} onTap={onTap} />
          )}
        </div>

        <div className="pos-side" data-open={sheetOpen || undefined}>
          {narrow && sheetOpen && <button type="button" className="pos-scrim" aria-label="Свернуть заказ" onClick={() => setSheetOpen(false)} />}
          <aside className="pos-order" aria-label="Текущий заказ">
            <header className="pos-order-head">
              <h2>
                Заказ{count > 0 && <span className="pos-count">{count}</span>}
              </h2>
              <div className="pos-head-tools">
                <button type="button" className="pos-tool" disabled={empty} onClick={park} title="Гость отошёл — заказ подождёт">
                  Отложить
                </button>
                <button type="button" className="pos-tool" disabled={empty} onClick={clearOrder} title="Esc">
                  Очистить
                </button>
              </div>
              {narrow && (
                <button type="button" className="pos-back pos-sheet-close" aria-label="Свернуть заказ" onClick={() => setSheetOpen(false)}>
                  <Icon name="chevron-down" size={22} />
                </button>
              )}
            </header>

            <PosGuestOrders
              loaded={new Set([draft.guestRequestId, ...held.map((h) => h.draft.guestRequestId)].filter((x): x is string => !!x))}
              onLoad={(r) => {
                if (!empty) park();
                loadDraft(draftOfGuestOrder(r, draft.service));
              }}
            />
            {held.length > 0 && (
              <div className="pos-held" role="group" aria-label="Отложенные заказы">
                {held.map((h) => (
                  <button key={h.id} type="button" className="pos-held-chip" data-failed={h.failed ? '' : undefined} onClick={() => recall(h)} title={h.failed ?? 'Вернуть заказ'}>
                    <span>{h.draft.guestName.trim() || timeOf(h.at)}</span>
                    <strong>{money(draftTotal(h.draft, byId))}</strong>
                  </button>
                ))}
              </div>
            )}

            {failure && (
              <div className="pos-failure" role="alert">
                <Icon name="alert" size={20} />
                <span>{failure}</span>
                <button type="button" className="pos-failure-x" aria-label="Скрыть" onClick={() => setFailure(null)}>
                  <Icon name="close" size={16} />
                </button>
              </div>
            )}

            <div className="pos-lines-wrap">
              {empty ? (
                <div className="pos-empty">
                  <Icon name="cup" size={40} />
                  <p>Нажмите на напиток — он сразу в заказе.</p>
                  {cleared && (
                    <button type="button" className="btn btn-small" onClick={() => { loadDraft(cleared); setCleared(null); }}>
                      Вернуть очищенный заказ
                    </button>
                  )}
                  {last && !cleared && last.lines.length > 0 && (
                    <button type="button" className="pos-repeat" onClick={() => loadDraft(last)}>
                      <Icon name="rotate" size={18} />
                      <span>
                        Повторить последний
                        <small>{describe(last, byId)}</small>
                      </span>
                    </button>
                  )}
                  <p className="pos-keys-hint">
                    <kbd>/</kbd> поиск · <kbd>2</kbd>…<kbd>9</kbd> количество ·{' '}
                    {payNow ? (
                      <>
                        <kbd>Enter</kbd> без сдачи · <kbd>F2</kbd> карта
                      </>
                    ) : (
                      <>
                        <kbd>Enter</kbd> отправить бариста
                      </>
                    )}{' '}
                    · <kbd>Esc</kbd> очистить
                  </p>
                </div>
              ) : (
                <ul className="pos-lines">
                  {priced.map(({ line, product, priced: pl, problem }) => {
                    const isSel = line.id === selected;
                    const comment = lineComment(line);
                    return (
                      <li key={line.id} className="pos-line" data-selected={isSel || undefined} data-broken={!pl || undefined}>
                        <button
                          type="button"
                          className="pos-line-main"
                          aria-expanded={isSel}
                          onClick={() => setSelected(isSel ? null : line.id)}
                          title="Добавки и комментарий"
                        >
                          <span className="pos-line-name">{product?.name ?? 'Товар недоступен'}</span>
                          <span className="pos-line-sub">
                            {pl ? (pl.optionNames.length ? pl.optionNames.join(' · ') : `${money(pl.unitPrice)}`) : (problem ?? 'уберите из заказа')}
                          </span>
                          {comment && <span className="pos-line-comment">«{comment}»</span>}
                        </button>
                        <span className="pos-qty" role="group" aria-label="Количество">
                          <button type="button" className="pos-qty-btn" aria-label={line.qty === 1 ? 'Убрать' : 'Меньше'} onClick={() => setQty(line.id, line.qty - 1)}>
                            <Icon name={line.qty === 1 ? 'trash' : 'minus'} size={18} />
                          </button>
                          <output>{line.qty}</output>
                          <button
                            type="button"
                            className="pos-qty-btn"
                            aria-label="Больше"
                            disabled={!product || qtyOf(line.productId) >= available(product)}
                            onClick={() => setQty(line.id, line.qty + 1)}
                          >
                            <Icon name="plus" size={18} />
                          </button>
                        </span>
                        <span className="pos-line-sum">{pl ? money(pl.unitPrice * line.qty) : '—'}</span>
                        {isSel && !docked && (optionsPanel ?? (plainComment && (
                          <CommentPanel
                            line={line}
                            title={product?.name ?? ''}
                            onComments={(comments) => updateLine(line.id, { comments })}
                            onText={(text) => updateLine(line.id, { text })}
                            onClose={() => setSelected(null)}
                          />
                        )))}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className="pos-foot">
              <div className="pos-meta">
                <div className="pos-seg" role="radiogroup" aria-label="Где пьёт гость">
                  {(['HERE', 'TAKEAWAY'] as const).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={draft.service === s} onClick={() => setDraft((d) => ({ ...d, service: s }))}>
                      {COUNTER_SERVICE_LABEL[s]}
                    </button>
                  ))}
                </div>
                <input
                  className="pos-guest"
                  value={draft.guestName}
                  maxLength={GUEST_NAME_MAX}
                  autoComplete="off"
                  autoCapitalize="words"
                  enterKeyHint="done"
                  placeholder="Имя гостя"
                  aria-label="Имя гостя (на экране заказов)"
                  onChange={(e) => setDraft((d) => ({ ...d, guestName: e.target.value }))}
                />
                {loyalty.enabled && (
                  <div className="loy-anchor">
                    <button
                      type="button"
                      className="loy-chip"
                      data-on={guest ? '' : undefined}
                      aria-expanded={guestOpen}
                      title="Гость по номеру телефона: бонусы и подарки"
                      onClick={() => setGuestOpen((o) => !o)}
                    >
                      <Icon name="user" size={18} />
                      <span>{guest ? guestChip(guest.card, loyalty, currency) : 'Гость — бонусы и подарки'}</span>
                    </button>
                    {guestOpen && (
                      <div className="loy-pop" onClick={(e) => e.target === e.currentTarget && setGuestOpen(false)}>
                        <GuestPad
                          settings={loyalty}
                          currency={currency}
                          initial={guest}
                          onDone={pickGuest}
                          onRemove={guest ? dropGuest : null}
                          onClose={() => setGuestOpen(false)}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Only for whoever takes the money: a waiter has nothing to do about the shift. */}
              {noShift && canOrder && canTakeMoney && (
                <div className="pos-shift" role="alert">
                  <Icon name="alert" size={18} />
                  <span>Смена не открыта</span>
                  {canNow('shift.open') && (
                    <button type="button" className="btn btn-small btn-primary" onClick={() => setShiftDialog(true)}>
                      Открыть смену
                    </button>
                  )}
                </div>
              )}

              {offer && (
                <button type="button" className="loy-offer" aria-pressed={reward} onClick={() => setReward((r) => !r)}>
                  <span>{reward ? `✓ ${offer.done}` : offer.ask}</span>
                  <small>{reward ? `−${money(offer.discount)} · отменить` : `−${money(offer.discount)}`}</small>
                </button>
              )}
              <div className="pos-total">
                <span>Итого</span>
                <strong>{money(due)}</strong>
              </div>
              {payNow ? (
                <>
                  <div className="pos-express" role="group" aria-label="Оплата в одно нажатие">
                    <button type="button" className="pos-express-btn" data-method="CASH" disabled={!canPayNow} onClick={() => pay('CASH')}>
                      <span className="pos-express-name">{METHOD_LABEL.CASH}</span>
                      <kbd className="pos-kbd">без сдачи · Enter</kbd>
                    </button>
                    <button type="button" className="pos-express-btn" data-method="CARD" disabled={!canPayNow} onClick={() => pay('CARD')}>
                      <span className="pos-express-name">{METHOD_LABEL.CARD}</span>
                      <kbd className="pos-kbd">F2</kbd>
                    </button>
                    <button type="button" className="pos-express-btn" data-method="QR" disabled={!canPayNow} onClick={() => pay('QR')}>
                      <span className="pos-express-name">{METHOD_LABEL.QR}</span>
                      <kbd className="pos-kbd">F3</kbd>
                    </button>
                  </div>
                  {/* The full-screen payment step: round sums, the keypad and the change in large type. */}
                  <button type="button" className="pos-paybar" disabled={!canOpenPay} onClick={() => setMode('pay')}>
                    <span>Оплатить</span>
                    <strong>{money(due)}</strong>
                  </button>
                </>
              ) : canOrder ? (
                <>
                  <button type="button" className="pos-paybar pos-sendbar" disabled={!canSend} onClick={() => pay(null)}>
                    <span>Отправить бариста</span>
                    <strong>{money(due)}</strong>
                  </button>
                  <p className="pos-send-note">
                    {canTakeMoney ? 'Без оплаты — счёт оплатят, когда откроют смену' : 'Без оплаты — счёт оплатят на кассе'}
                  </p>
                </>
              ) : null}
            </footer>
          </aside>
          {!narrow && doneFlash}
        </div>
      </div>

      {/*
        Phone: everything the thumb needs sits at the bottom, right on the app's tab bar — the
        drink's chips (or the «Заказ 17» card), the categories with search, and the bar with the
        total and the one button: «Оплатить» or, without money, «Отправить».
      */}
      {narrow && (
        <div className="pos-dockbar" ref={dockRef} data-hidden={sheetOpen || undefined}>
          {doneFlash ??
            dockPanel ?? (
              <CategoryTabs
                categories={categories}
                hueOf={hueOf}
                active={activeTab}
                searching={searching}
                onTab={pickTab}
                onSearch={() => {
                  // Synchronously, inside the tap: a phone opens its keyboard only then.
                  searchRef.current?.focus({ preventScroll: true });
                  window.scrollTo({ top: 0 });
                }}
              />
            )}
          <div className="pos-orderbar">
            <button
              type="button"
              className="pos-orderbar-sum"
              aria-label={empty ? 'Открыть заказ' : `Открыть заказ: ${count} шт., ${money(due)}`}
              disabled={empty && held.length === 0}
              onClick={() => setSheetOpen(true)}
            >
              <span key={count} className="pos-orderbar-count">
                {count}
              </span>
              <span className="pos-orderbar-text">
                <strong>{empty ? (held.length ? `Отложено: ${held.length}` : 'Заказ пуст') : money(due)}</strong>
                <small>
                  {empty
                    ? held.length
                      ? 'нажмите, чтобы вернуть'
                      : 'нажмите на напиток'
                    : `${COUNTER_SERVICE_LABEL[draft.service]}${draft.guestName.trim() ? ` · ${draft.guestName.trim()}` : ''}`}
                </small>
              </span>
              <Icon name="chevron-down" size={20} className="pos-orderbar-up" />
            </button>
            {!empty && canOrder && (
              <button
                type="button"
                className="pos-orderbar-go"
                data-kind={payNow ? 'pay' : 'send'}
                disabled={broken}
                onClick={() => {
                  setSelected(null);
                  // «Оплатить» — the full-screen payment step over everything; «Отправить» — the order sheet.
                  if (payNow) setMode('pay');
                  else {
                    setMode('order');
                    setSheetOpen(true);
                  }
                }}
              >
                {payNow ? 'Оплатить' : 'Отправить'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* «Оплатить»: the whole screen, and after the money «Заказ 17 · Сдача 450 ₸» on the same screen. */}
      {stepOpen && (
        <PayStep
          currency={currency}
          lines={priced.map(
            ({ line, product, priced: pl, problem }): PayLine => ({
              id: line.id,
              name: product?.name ?? 'Товар недоступен',
              detail: pl ? pl.optionNames.join(' · ') : (problem ?? 'уберите из заказа'),
              comment: lineComment(line),
              qty: line.qty,
              sum: pl ? pl.unitPrice * line.qty : null,
            }),
          )}
          count={count}
          total={total}
          due={due}
          offer={offer ? { ask: offer.ask, done: offer.done, amount: offer.discount } : null}
          rewardOn={reward && offer !== null}
          onReward={() => setReward((r) => !r)}
          guestCard={guest ? guestChip(guest.card, loyalty, currency) : null}
          service={draft.service}
          onService={(s) => setDraft((d) => ({ ...d, service: s }))}
          guestName={draft.guestName}
          onGuestName={(v) => setDraft((d) => ({ ...d, guestName: v }))}
          tendered={tendered}
          typed={typed}
          onTendered={setTendered}
          quick={quickTenders(due, currency, 4)}
          canPay={canPayNow}
          canSend={canSend}
          online={online}
          compact={payCompact}
          autoPrint={autoPrint}
          onAutoPrint={(on) => {
            setAutoPrint(on);
            writeAutoPrint(on);
          }}
          onPay={pay}
          onBack={() => setMode('order')}
          flash={flash?.where === 'step' ? flash : null}
          doneMs={flashMs}
          onDone={() => setFlash(null)}
          // A refused order is back in the cart: pay it again right here (same idempotency key).
          onRetry={
            empty
              ? null
              : () => {
                  setFlash(null);
                  setMode('pay');
                }
          }
          onPrint={(res) => printCounterReceipt(res, state)}
        />
      )}

      {shiftDialog && (
        <Modal title="Открыть смену" onClose={() => setShiftDialog(false)}>
          <OpenShiftForm
            desk={desk}
            onOpened={() => {
              setShiftDialog(false);
              setFailure(null);
              hub.notify('Смена открыта');
            }}
          />
        </Modal>
      )}
    </section>
  );
}

function addStock(m: ReadonlyMap<string, number>, taken: ReadonlyMap<string, number>, sign: 1 | -1): Map<string, number> {
  const next = new Map(m);
  for (const [id, n] of taken) {
    const v = (next.get(id) ?? 0) + sign * n;
    if (v > 0) next.set(id, v);
    else next.delete(id);
  }
  return next;
}

function draftTotal(d: Draft, byId: ReadonlyMap<string, ProductView>): Minor {
  return d.lines.reduce((sum, l) => {
    const p = byId.get(l.productId);
    return sum + (p ? (tryPrice(p, l.choices).priced?.unitPrice ?? 0) * l.qty : 0);
  }, 0);
}

function describe(d: Draft, byId: ReadonlyMap<string, ProductView>): string {
  const parts = d.lines.map((l) => {
    const p = byId.get(l.productId);
    const name = p ? (tryPrice(p, l.choices).priced?.title.replace(/ · /g, ' ') ?? p.name) : '…';
    return l.qty > 1 ? `${name} ×${l.qty}` : name;
  });
  const text = parts.join(', ');
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

const timeOf = (at: number) => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// ── Tiles ───────────────────────────────────────────────────────────────────

interface Tile {
  id: string;
  name: string;
  price: string;
  hue: number;
  count: number;
  out: boolean;
  low: number | null;
  options: boolean;
  /** A raw material of the drink is low or out (alerts.ts): never blocks the sale. */
  hint: StockTileHint | null;
}

/** The menu grid; re-renders only when the tiles change (not on the HUB clock tick). */
const MenuGrid = memo(function MenuGrid({
  tiles,
  looks,
  onTap,
}: {
  tiles: Tile[];
  looks: Record<string, TileLook>;
  onTap: (id: string) => void;
}) {
  return (
    <div className="pos-tiles" role="group" aria-label="Товары">
      {tiles.map((t) => (
        <button
          key={t.id}
          type="button"
          className={looks[t.id] ? 'pos-tile ts-tile' : 'pos-tile'}
          style={lookStyle(t.hue, looks[t.id])}
          data-photo={looks[t.id]?.photo ? '' : undefined}
          data-in-order={t.count > 0 || undefined}
          data-out={t.out || undefined}
          disabled={t.out}
          // pointerdown would add on a scroll gesture; click is fast with touch-action: manipulation.
          onClick={() => onTap(t.id)}
        >
          <TilePhoto look={looks[t.id]} />
          <TileBadge look={looks[t.id]} />
          <span className="pos-tile-name">{t.name}</span>
          {t.hint && !t.out && (
            <span className="pos-tile-hint" data-level={t.hint.level} title={t.hint.text}>
              {t.hint.text}
            </span>
          )}
          <span className="pos-tile-foot">
            <span className="pos-tile-price">{t.price}</span>
            {t.out ? (
              <span className="pos-badge pos-badge-out">нет</span>
            ) : t.low !== null ? (
              <span className="pos-badge pos-badge-low">ост. {t.low}</span>
            ) : t.options ? (
              <span className="pos-tile-more">добавки</span>
            ) : null}
          </span>
          {t.count > 0 && (
            <span className="pos-tile-count" aria-label={`В заказе: ${t.count}`}>
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
});

/**
 * «Хиты» and the categories. On a phone the strip sits at the bottom with a search button first:
 * the waiter reaches both with the thumb of the hand that holds the phone.
 */
function CategoryTabs({
  categories,
  hueOf,
  active,
  searching,
  onTab,
  onSearch,
}: {
  categories: readonly { id: string; name: string }[];
  hueOf: ReadonlyMap<string, number>;
  active: string;
  searching: boolean;
  onTab: (id: string) => void;
  onSearch?: () => void;
}) {
  const strip = (
    <div className="pos-tabs" role="tablist" aria-label="Категории" data-dim={searching || undefined}>
      <button type="button" role="tab" className="pos-tab pos-tab-hits" aria-selected={!searching && active === HITS} onClick={() => onTab(HITS)}>
        <span aria-hidden="true">★</span> Хиты
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          role="tab"
          className="pos-tab"
          style={{ '--hue': hueOf.get(c.id) } as CSSProperties}
          aria-selected={!searching && c.id === active}
          onClick={() => onTab(c.id)}
        >
          <span className="pos-tab-dot" aria-hidden="true" />
          {c.name}
        </button>
      ))}
    </div>
  );
  if (!onSearch) return strip;
  return (
    <div className="pos-catbar">
      <button type="button" className="pos-catbar-search" aria-label="Поиск по меню" aria-pressed={searching} onClick={onSearch}>
        <Icon name="search" size={22} />
      </button>
      {strip}
    </div>
  );
}

// ── Options and comments next to the line ───────────────────────────────────

function OptionsPanel({
  line,
  groups,
  title,
  currency,
  problem,
  docked,
  sum,
  canMore,
  onQty,
  onChoices,
  onComments,
  onText,
  onClose,
}: {
  line: Line;
  groups: ProductOptionGroup[];
  title: string;
  currency: string;
  problem: string | null;
  docked: boolean;
  /** Docked (phone): the line's sum and its quantity next to the name, so nothing else is needed. */
  sum: string | null;
  canMore: boolean;
  onQty: (qty: number) => void;
  onChoices: (choices: string[]) => void;
  onComments: (comments: string[]) => void;
  onText: (text: string) => void;
  onClose: () => void;
}) {
  const delta = (d: Minor) => (d === 0 ? '' : `${d > 0 ? '+' : '−'}${formatMoney(Math.abs(d), currency)}`);
  return (
    <div className="pos-opts" data-docked={docked || undefined} role="group" aria-label={`Добавки: ${title}`}>
      {docked && (
        <div className="pos-opts-head">
          <span className="pos-opts-title">
            <strong>{title}</strong>
            {sum && <small>{sum}</small>}
          </span>
          <span className="pos-qty" role="group" aria-label="Количество">
            <button type="button" className="pos-qty-btn" aria-label={line.qty === 1 ? 'Убрать' : 'Меньше'} onClick={() => onQty(line.qty - 1)}>
              <Icon name={line.qty === 1 ? 'trash' : 'minus'} size={18} />
            </button>
            <output>{line.qty}</output>
            <button type="button" className="pos-qty-btn" aria-label="Больше" disabled={!canMore} onClick={() => onQty(line.qty + 1)}>
              <Icon name="plus" size={18} />
            </button>
          </span>
          <button type="button" className="pos-opts-done" onClick={onClose}>
            Готово
          </button>
        </div>
      )}
      {groups.map((g) => {
        const segmented = g.required && !g.multiple && g.choices.length <= 4;
        return (
          <div key={g.id} className="pos-opt-row">
            <span className="pos-opt-label">{g.name}</span>
            <div className={segmented ? 'pos-opt-seg' : 'pos-opt-chips'} role={g.multiple ? 'group' : 'radiogroup'} aria-label={g.name}>
              {g.choices.map((c) => {
                const on = line.choices.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role={g.multiple ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    className="pos-opt"
                    onClick={() => onChoices(toggleChoice(groups, line.choices, g.id, c.id))}
                  >
                    <span>{c.name}</span>
                    {c.priceDelta !== 0 && <small>{delta(c.priceDelta)}</small>}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <Comments line={line} compact={docked} onComments={onComments} onText={onText} />
      {problem && <p className="form-error">{problem}</p>}
      {!docked && (
        <button type="button" className="pos-opts-collapse" onClick={onClose}>
          Свернуть
        </button>
      )}
    </div>
  );
}

function CommentPanel({
  line,
  title,
  docked,
  onComments,
  onText,
  onClose,
}: {
  line: Line;
  title: string;
  docked?: boolean;
  onComments: (comments: string[]) => void;
  onText: (text: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="pos-opts" data-docked={docked || undefined} role="group" aria-label={`Комментарий: ${title}`}>
      {docked && (
        <div className="pos-opts-head">
          <strong>{title}</strong>
          <button type="button" className="pos-opts-done" onClick={onClose}>
            Готово
          </button>
        </div>
      )}
      <Comments line={line} onComments={onComments} onText={onText} />
      {!docked && (
        <button type="button" className="pos-opts-collapse" onClick={onClose}>
          Свернуть
        </button>
      )}
    </div>
  );
}

function Comments({
  line,
  compact = false,
  onComments,
  onText,
}: {
  line: Line;
  /** Phone dock: one swipeable row; the own-words field opens on «Свой комментарий». */
  compact?: boolean;
  onComments: (c: string[]) => void;
  onText: (t: string) => void;
}) {
  const [typing, setTyping] = useState(() => !compact || line.text !== '');
  return (
    <div className="pos-opt-row pos-note-row">
      {!compact && <span className="pos-opt-label">Комментарий</span>}
      <div className="pos-opt-chips pos-notes" role="group" aria-label="Комментарий" data-compact={compact || undefined}>
        {COMMENT_PRESETS.map((c) => {
          const on = line.comments.includes(c);
          return (
            <button
              key={c}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="pos-opt pos-opt-note"
              onClick={() => onComments(on ? line.comments.filter((x) => x !== c) : [...line.comments, c])}
            >
              {c}
            </button>
          );
        })}
        {!typing && (
          <button type="button" className="pos-opt pos-opt-note" onClick={() => setTyping(true)}>
            ✎ Свой комментарий
          </button>
        )}
      </div>
      {typing && (
        <input
          className="pos-opt-text"
          value={line.text}
          maxLength={60}
          placeholder="Свой комментарий"
          aria-label="Свой комментарий"
          enterKeyHint="done"
          autoFocus={compact}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      )}
    </div>
  );
}

// ── «Заказ 17» ──────────────────────────────────────────────────────────────

function DoneFlash({
  flash,
  currency,
  docked,
  ms,
  onClose,
  onPrint,
}: {
  flash: Flash;
  currency: string;
  /** Phone: a card at the bottom over the total, not a cover over the order. */
  docked: boolean;
  /** How long it stays after the HUB confirmed (the bar at its bottom runs out meanwhile). */
  ms: number;
  onClose: () => void;
  onPrint: (res: CreateCounterOrderResponse) => void;
}) {
  const money = (a: Minor) => formatMoney(a, currency);
  const number = flash.res?.order.number;
  return (
    <div className="pos-flash" data-state={flash.state} data-docked={docked || undefined} role="status" aria-live="assertive" onClick={onClose}>
      <div className="pos-flash-card" onClick={(e) => e.stopPropagation()}>
        {flash.state === 'failed' ? (
          <>
            <p className="pos-flash-label">Заказ не прошёл</p>
            <p className="pos-flash-error">{flash.error}</p>
            <button type="button" className="btn btn-primary" onClick={onClose}>
              Понятно
            </button>
          </>
        ) : (
          <>
            <div className="pos-flash-num">
              <p className="pos-flash-label">Заказ</p>
              <p className="pos-flash-number" data-pending={number === undefined || undefined}>
                {number ?? '···'}
              </p>
            </div>
            <div className="pos-flash-info">
              {/* «Заказ 17 отправлен бариста»: the words the waiter waits for. */}
              <p className="pos-flash-sent" data-ok={flash.state === 'ok' || undefined}>
                {flash.state === 'ok' ? (
                  <>
                    <Icon name="check" size={18} /> отправлен бариста
                  </>
                ) : (
                  'отправляем бариста…'
                )}
              </p>
              <p className="pos-flash-sub">
                {COUNTER_SERVICE_LABEL[flash.service]}
                {flash.guestName ? ` · ${flash.guestName}` : ''} · {money(flash.total)}
              </p>
              {flash.method === 'CASH' && !flash.rest && (
                <p className="pos-flash-change" data-zero={flash.change === 0 || undefined}>
                  {flash.change > 0 ? (
                    <>
                      <small>Сдача</small>
                      {money(flash.change)}
                    </>
                  ) : (
                    'Без сдачи'
                  )}
                </p>
              )}
              {flash.rest && (
                <p className="pos-flash-paid">
                  Наличными {money(flash.total - flash.rest.amount)} + {METHOD_LABEL[flash.rest.method]} {money(flash.rest.amount)}
                </p>
              )}
              {flash.method && flash.method !== 'CASH' && <p className="pos-flash-paid">Оплачено: {METHOD_LABEL[flash.method]}</p>}
              {!flash.method && <p className="pos-flash-later">Без оплаты — счёт оплатят потом на кассе</p>}
              {flash.loyaltyNote && <p className="pos-flash-paid">{flash.loyaltyNote}</p>}
            </div>
            <div className="pos-flash-actions">
              <button type="button" className="btn btn-small" disabled={!flash.res} onClick={() => flash.res && onPrint(flash.res)}>
                Печать чека
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
                Дальше
              </button>
            </div>
            {flash.state === 'ok' && <span className="pos-flash-timer" style={{ animationDuration: `${ms}ms` }} />}
          </>
        )}
      </div>
    </div>
  );
}
