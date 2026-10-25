import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type {
  CounterService,
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
import { printReceipt } from '../cash/print/Receipt.tsx';
import { OpenShiftForm } from '../cash/ShiftPanel.tsx';
import { Icon } from '../icons.tsx';
import { OfflineBanner } from '../OfflineBanner.tsx';
import { sellable, sortCatalog } from '../pages/bar/useCatalog.tsx';
import { GuestPad } from '../loyalty/GuestPad.tsx';
import type { PickedGuest } from '../loyalty/GuestPad.tsx';
import { earnedLine, giftOrdinal, guestChip, loyaltyOf } from '../loyalty/model.ts';
import { Loading } from '../ui.tsx';
import { useHub } from '../useHub.tsx';
import { createCounterOrder, optionsOf, useCachedCatalog } from './cafe.ts';
import type { Draft, Held, Line } from './pos-model.ts';
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
  sameChoices,
  searchProducts,
  toggleChoice,
  topProducts,
  tryPrice,
  writeAutoPrint,
  writeHeld,
  writeLast,
} from './pos-model.ts';
import './cafe.css';

const HITS = 'hits';
/** The «Заказ 17» card stays this long after the HUB confirmed, then the counter is ready for the next guest. */
const FLASH_MS = 3000;

/** What the order card shows right after «Оплатить»: at once, before the HUB answers. */
interface Flash {
  id: string;
  state: 'sending' | 'ok' | 'failed';
  method: PaymentMethod | null;
  total: Minor;
  change: Minor;
  /** Split: the part paid by card or QR after the cash. */
  rest: { method: PaymentMethod; amount: Minor } | null;
  service: CounterService;
  guestName: string;
  res?: CreateCounterOrderResponse;
  error?: string;
  /** «Гостю начислено 45 ₸ бонусами» after the HUB confirmed. */
  loyaltyNote?: string | null;
}

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
  const narrow = useMedia('(max-width: 960px)');

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
  const activeTab = tab === HITS || categories.some((c) => c.id === tab) ? tab : HITS;
  const shown = useMemo(() => {
    if (query.trim()) return searchProducts(products, query);
    if (activeTab === HITS) return hits;
    return products.filter((p) => p.categoryId === activeTab);
  }, [query, products, activeTab, hits]);

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
  const orderBlocked = blockedReason('counter.take');
  const canSend = online && canOrder && !empty && !broken;
  const canPayNow = canSend && !noShift;

  const patchLines = (fn: (lines: Line[]) => Line[]) => setDraft((d) => ({ ...d, lines: fn(d.lines) }));

  const inOrderKey = draft.lines.map((l) => `${l.productId}:${l.qty}`).join(',');
  const inOrder = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of draftRef.current.lines) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inOrderKey]);

  const tapProduct = (p: ProductView) => {
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
    const defaults = defaultChoices(options);
    // The same drink with the same options and no comment: one more on that line.
    const same = draft.lines.find((l) => l.productId === p.id && sameChoices(l.choices, defaults) && !lineComment(l));
    if (same) {
      patchLines((ls) => ls.map((l) => (l.id === same.id ? { ...l, qty: l.qty + add } : l)));
      setSelected(options.length ? same.id : null);
    } else {
      const line: Line = { id: lineId(), productId: p.id, choices: defaults, qty: add, comments: [], text: '' };
      patchLines((ls) => [...ls, line]);
      setSelected(options.length ? line.id : null);
    }
    if (query) setQuery('');
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
    if (!canSend || (method !== null && noShift)) {
      if (method !== null && noShift) setFailure('Смена не открыта — оплату принять нельзя');
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

    setFlash({ id, state: 'sending', method, total: amount, change, rest, service: d.service, guestName: d.guestName.trim() });
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

    createCounterOrder(actor, body, key)
      .then((res) => {
        writeLast(d);
        recordHits(d.lines);
        setHitsVersion((v) => v + 1);
        setFlash((f) => (f?.id === id ? { ...f, state: 'ok', res, loyaltyNote: earnedLine(res.loyalty, loyalty, currency) } : f));
        if (readAutoPrint()) printReceipt(res.check, state.club, undefined, Date.now(), res.order.number);
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
  useEffect(() => {
    if (flash?.state !== 'ok') return;
    const t = setTimeout(() => setFlash((f) => (f?.id === flash.id ? null : f)), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash?.state, flash?.id]);

  // ── Keyboard (desktop counter) ────────────────────────────────────────────
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (shiftDialog || guestOpen || document.querySelector('dialog[open]')) return;
    const typing = isTyping(e.target);
    if (e.key === 'Escape') {
      if (typing) (e.target as HTMLElement).blur();
      if (flash) setFlash(null);
      else if (qtyPad) setQtyPad(false);
      else if (mode === 'pay') setMode('order');
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
      if (e.key === 'F1') {
        if (!empty) setMode('pay');
      } else pay(e.key === 'F2' ? 'CARD' : 'QR');
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^\d$/.test(e.key)) {
      if (mode === 'pay') setTendered((t) => (t + e.key).replace(/^0+(?=\d)/, '').slice(0, 9));
      else setMultiplier((m) => Math.min(99, (m ?? 0) * 10 + Number(e.key)) || null);
      e.preventDefault();
      return;
    }
    if (e.key === 'Backspace') {
      if (mode === 'pay') setTendered((t) => t.slice(0, -1));
      else setMultiplier((m) => (m && m >= 10 ? Math.floor(m / 10) : null));
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
      if (mode === 'pay' && typed !== null && typed >= due) pay('CASH', { tendered: typed });
      else if (mode === 'pay' && typed !== null) return;
      else pay('CASH');
      return;
    }
    if (e.key === ' ' && !(e.target instanceof HTMLButtonElement) && !empty) {
      e.preventDefault();
      setMode('pay');
      return;
    }
    // Letters start a search, like on a desktop POS.
    if (e.key.length === 1 && /\p{L}/u.test(e.key) && mode === 'order') {
      searchRef.current?.focus();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // ── Tiles ─────────────────────────────────────────────────────────────────
  const tiles = useMemo(
    () =>
      shown.map((p) => {
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
        };
      }),
    [shown, pendingStock, inOrder, hueOf, money],
  );

  if (!sorted) {
    return <section className="page">{catalogError ? <p className="bar-error">{catalogError}</p> : <Loading online={online} />}</section>;
  }

  const selectedLine = priced.find((p) => p.line.id === selected) ?? null;
  const optionsPanel =
    selectedLine?.product && optionsOf(selectedLine.product).length > 0 ? (
      <OptionsPanel
        key={selectedLine.line.id}
        line={selectedLine.line}
        groups={optionsOf(selectedLine.product)}
        title={selectedLine.product.name}
        currency={currency}
        problem={selectedLine.problem}
        docked={narrow}
        onChoices={(choices) => updateLine(selectedLine.line.id, { choices })}
        onComments={(comments) => updateLine(selectedLine.line.id, { comments })}
        onText={(text) => updateLine(selectedLine.line.id, { text })}
        onClose={() => setSelected(null)}
      />
    ) : null;
  const plainComment =
    selectedLine?.product && optionsOf(selectedLine.product).length === 0 ? selectedLine : null;

  const searching = query.trim().length > 0;
  const last = empty ? readLast() : null;

  return (
    <section
      className="page pos"
      data-mode={mode}
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
                placeholder="Поиск: капучино, rfgexbyj…"
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
          </div>
          {multiplier !== null && (
            <p className="pos-mult-note" role="status">
              Следующий товар добавится ×{multiplier}
              <button type="button" className="link" onClick={() => setMultiplier(null)}>
                отменить
              </button>
            </p>
          )}

          <div className="pos-tabs" role="tablist" aria-label="Категории" data-dim={searching || undefined}>
            <button type="button" role="tab" className="pos-tab pos-tab-hits" aria-selected={!searching && activeTab === HITS} onClick={() => { setTab(HITS); setQuery(''); }}>
              <span aria-hidden="true">★</span> Хиты
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                className="pos-tab"
                style={{ '--hue': hueOf.get(c.id) } as CSSProperties}
                aria-selected={!searching && c.id === activeTab}
                onClick={() => {
                  setTab(c.id);
                  setQuery('');
                }}
              >
                <span className="pos-tab-dot" aria-hidden="true" />
                {c.name}
              </button>
            ))}
          </div>

          {products.length === 0 ? (
            <p className="empty">В меню пока нет товаров. Добавьте их в разделе «Меню».</p>
          ) : tiles.length === 0 ? (
            <p className="empty pos-noresult">Ничего не нашлось по «{query}».</p>
          ) : (
            <MenuGrid tiles={tiles} onTap={onTap} />
          )}

          {narrow && (optionsPanel || plainComment) && (
            <div className="pos-dock">
              {optionsPanel ?? (
                <CommentPanel
                  line={plainComment!.line}
                  title={plainComment!.product!.name}
                  docked
                  onComments={(comments) => updateLine(plainComment!.line.id, { comments })}
                  onText={(text) => updateLine(plainComment!.line.id, { text })}
                  onClose={() => setSelected(null)}
                />
              )}
            </div>
          )}
        </div>

        <div className="pos-side" data-open={sheetOpen || undefined}>
          {narrow && sheetOpen && <button type="button" className="pos-scrim" aria-label="Свернуть заказ" onClick={() => setSheetOpen(false)} />}
          <aside className="pos-order" aria-label="Текущий заказ">
            <header className="pos-order-head">
              {mode === 'pay' ? (
                <>
                  <button type="button" className="pos-back" onClick={() => setMode('order')} aria-label="Назад к заказу">
                    <Icon name="back" size={20} />
                  </button>
                  <h2>Оплата</h2>
                </>
              ) : (
                <>
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
                </>
              )}
              {narrow && (
                <button type="button" className="pos-back pos-sheet-close" aria-label="Свернуть заказ" onClick={() => setSheetOpen(false)}>
                  <Icon name="chevron-down" size={22} />
                </button>
              )}
            </header>

            {held.length > 0 && mode === 'order' && (
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

            {mode === 'pay' ? (
              <PayView
                total={due}
                currency={currency}
                tendered={tendered}
                typed={typed}
                quick={quickTenders(due, currency, 3)}
                canPay={canPayNow}
                canSend={canSend}
                noShift={noShift}
                autoPrint={autoPrint}
                onAutoPrint={(on) => {
                  setAutoPrint(on);
                  writeAutoPrint(on);
                }}
                onTendered={setTendered}
                onPay={pay}
              />
            ) : (
              <>
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
                        <kbd>/</kbd> поиск · <kbd>2</kbd>…<kbd>9</kbd> количество · <kbd>Enter</kbd> без сдачи · <kbd>F2</kbd> карта · <kbd>Esc</kbd> очистить
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
                            {isSel && !narrow && (optionsPanel ?? (plainComment && (
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

                  {noShift && canOrder && (
                    <div className="pos-shift" role="alert">
                      <span>Смена не открыта — оплату принять нельзя.</span>
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
                  <div className="pos-express" role="group" aria-label="Оплата в одно нажатие">
                    <button type="button" className="pos-express-btn" disabled={!canPayNow} onClick={() => pay('CASH')}>
                      Без сдачи<kbd className="pos-kbd">Enter</kbd>
                    </button>
                    <button type="button" className="pos-express-btn" disabled={!canPayNow} onClick={() => pay('CARD')}>
                      {METHOD_LABEL.CARD}<kbd className="pos-kbd">F2</kbd>
                    </button>
                    <button type="button" className="pos-express-btn" disabled={!canPayNow} onClick={() => pay('QR')}>
                      {METHOD_LABEL.QR}<kbd className="pos-kbd">F3</kbd>
                    </button>
                  </div>
                  <button type="button" className="pos-paybar" disabled={empty || broken || !canOrder} onClick={() => setMode('pay')}>
                    <span>Оплатить</span>
                    <strong>{money(due)}</strong>
                  </button>
                </footer>
              </>
            )}
          </aside>
          {flash && <DoneFlash flash={flash} currency={currency} onClose={() => setFlash(null)} onPrint={(res) => printReceipt(res.check, state.club, undefined, Date.now(), res.order.number)} />}
        </div>
      </div>

      {/* Phone: the order is a bottom sheet; this bar opens it. */}
      {narrow && !sheetOpen && (
        <div className="pos-bar">
          <button type="button" className="pos-bar-order" onClick={() => setSheetOpen(true)} disabled={empty && held.length === 0}>
            <span className="pos-bar-count">{count}</span>
            <span>{empty ? (held.length ? `Отложено: ${held.length}` : 'Заказ пуст') : 'Заказ'}</span>
            <Icon name="chevron-down" size={18} className="pos-bar-up" />
          </button>
          <button
            type="button"
            className="pos-bar-pay"
            disabled={empty || broken || !canOrder}
            onClick={() => {
              setMode('pay');
              setSheetOpen(true);
            }}
          >
            {money(due)}
          </button>
        </div>
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
}

/** The menu grid; re-renders only when the tiles change (not on the HUB clock tick). */
const MenuGrid = memo(function MenuGrid({ tiles, onTap }: { tiles: Tile[]; onTap: (id: string) => void }) {
  return (
    <div className="pos-tiles" role="group" aria-label="Товары">
      {tiles.map((t) => (
        <button
          key={t.id}
          type="button"
          className="pos-tile"
          style={{ '--hue': t.hue } as CSSProperties}
          data-in-order={t.count > 0 || undefined}
          data-out={t.out || undefined}
          disabled={t.out}
          // pointerdown would add on a scroll gesture; click is fast with touch-action: manipulation.
          onClick={() => onTap(t.id)}
        >
          <span className="pos-tile-name">{t.name}</span>
          <span className="pos-tile-foot">
            <span className="pos-tile-price">{t.price}</span>
            {t.out ? (
              <span className="pos-badge pos-badge-out">нет</span>
            ) : t.low !== null ? (
              <span className="pos-badge pos-badge-low">ост. {t.low}</span>
            ) : t.options ? (
              <span className="pos-tile-more" aria-hidden="true">
                <Icon name="settings" size={14} />
              </span>
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

// ── Options and comments next to the line ───────────────────────────────────

function OptionsPanel({
  line,
  groups,
  title,
  currency,
  problem,
  docked,
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
          <strong>{title}</strong>
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
      <Comments line={line} onComments={onComments} onText={onText} />
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

function Comments({ line, onComments, onText }: { line: Line; onComments: (c: string[]) => void; onText: (t: string) => void }) {
  return (
    <div className="pos-opt-row">
      <span className="pos-opt-label">Комментарий</span>
      <div className="pos-opt-chips">
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
        <input
          className="pos-opt-text"
          value={line.text}
          maxLength={60}
          placeholder="Свой комментарий"
          aria-label="Свой комментарий"
          onChange={(e) => onText(e.target.value)}
        />
      </div>
    </div>
  );
}

// ── Payment ─────────────────────────────────────────────────────────────────

function PayView({
  total,
  currency,
  tendered,
  typed,
  quick,
  canPay,
  canSend,
  noShift,
  autoPrint,
  onAutoPrint,
  onTendered,
  onPay,
}: {
  total: Minor;
  currency: string;
  tendered: string;
  typed: Minor | null;
  quick: Minor[];
  canPay: boolean;
  canSend: boolean;
  noShift: boolean;
  autoPrint: boolean;
  onAutoPrint: (on: boolean) => void;
  onTendered: (v: string) => void;
  onPay: (method: PaymentMethod | null, opts?: { tendered?: Minor; rest?: 'CARD' | 'QR' }) => void;
}) {
  const money = (a: Minor) => formatMoney(a, currency);
  const short = typed !== null && typed < total ? total - typed : 0;
  const change = typed !== null && typed >= total ? typed - total : null;
  const press = (k: string) => {
    if (k === '⌫') onTendered(tendered.slice(0, -1));
    else onTendered((tendered + k).replace(/^0+(?=\d)/, '').slice(0, 9));
  };
  return (
    <div className="pos-pay">
      <div className="pos-pay-due">
        <span>К оплате</span>
        <strong>{money(total)}</strong>
      </div>

      <div className="pos-pay-quick" role="group" aria-label="Наличные: сумма от гостя">
        <button type="button" className="pos-cash-btn pos-cash-exact" disabled={!canPay} onClick={() => onPay('CASH')}>
          <small>Наличные</small>
          Без сдачи
        </button>
        {quick.map((q) => (
          <button key={q} type="button" className="pos-cash-btn" disabled={!canPay} onClick={() => onPay('CASH', { tendered: q })}>
            <small>сдача {money(q - total)}</small>
            {money(q)}
          </button>
        ))}
      </div>

      <div className="pos-pay-cash">
        <div className="pos-display" aria-live="polite">
          <span className="pos-display-label">Гость даёт</span>
          <span className="pos-display-sum" data-empty={tendered === '' || undefined}>
            {tendered === '' ? 'сумма' : typed !== null ? money(typed) : tendered}
          </span>
          <span className="pos-display-change" data-short={short > 0 || undefined}>
            {change !== null ? `Сдача ${money(change)}` : short > 0 ? `Не хватает ${money(short)}` : ' '}
          </span>
        </div>
        <div className="pos-keypad" role="group" aria-label="Цифры">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'].map((k) => (
            <button key={k} type="button" aria-label={k === '⌫' ? 'Стереть' : k} onClick={() => press(k)}>
              {k}
            </button>
          ))}
        </div>
        {short > 0 && typed !== null && typed > 0 ? (
          <div className="pos-split" role="group" aria-label="Остаток другим способом">
            <span>Остаток {money(short)}:</span>
            <button type="button" className="btn" disabled={!canPay} onClick={() => onPay('CASH', { tendered: typed, rest: 'CARD' })}>
              картой
            </button>
            <button type="button" className="btn" disabled={!canPay} onClick={() => onPay('CASH', { tendered: typed, rest: 'QR' })}>
              QR
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-primary pos-accept"
            disabled={!canPay || (typed !== null && typed < total)}
            onClick={() => onPay('CASH', typed !== null ? { tendered: typed } : {})}
          >
            Принять {money(typed ?? total)}
          </button>
        )}
      </div>

      <div className="pos-pay-methods">
        <button type="button" className="pos-method" disabled={!canPay} onClick={() => onPay('CARD')}>
          {METHOD_LABEL.CARD}
        </button>
        <button type="button" className="pos-method" disabled={!canPay} onClick={() => onPay('QR')}>
          {METHOD_LABEL.QR}
        </button>
      </div>

      <div className="pos-pay-extra">
        <button type="button" className="link" disabled={!canSend} onClick={() => onPay(null)} title="Заказ уйдёт бариста, счёт останется открытым в «Счетах»">
          Без оплаты — счёт потом
        </button>
        <label className="check">
          <input type="checkbox" checked={autoPrint} onChange={(e) => onAutoPrint(e.target.checked)} />
          Печатать чек сам
        </label>
      </div>
      {noShift && <p className="hint hint-warn">Смена не открыта — откройте её, чтобы принять оплату.</p>}
    </div>
  );
}

// ── «Заказ 17» ──────────────────────────────────────────────────────────────

function DoneFlash({
  flash,
  currency,
  onClose,
  onPrint,
}: {
  flash: Flash;
  currency: string;
  onClose: () => void;
  onPrint: (res: CreateCounterOrderResponse) => void;
}) {
  const money = (a: Minor) => formatMoney(a, currency);
  const number = flash.res?.order.number;
  return (
    <div className="pos-flash" data-state={flash.state} role="status" aria-live="assertive" onClick={onClose}>
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
            <p className="pos-flash-label">Заказ</p>
            <p className="pos-flash-number" data-pending={number === undefined || undefined}>
              {number ?? '···'}
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
            {!flash.method && <p className="hint hint-warn">Без оплаты — счёт ждёт в «Счетах».</p>}
            {flash.loyaltyNote && <p className="pos-flash-paid">{flash.loyaltyNote}</p>}
            <div className="pos-flash-actions">
              <button type="button" className="btn btn-small" disabled={!flash.res} onClick={() => flash.res && onPrint(flash.res)}>
                Печать чека
              </button>
              <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
                Дальше
              </button>
            </div>
            {flash.state === 'ok' && <span className="pos-flash-timer" style={{ animationDuration: `${FLASH_MS}ms` }} />}
          </>
        )}
      </div>
    </div>
  );
}
