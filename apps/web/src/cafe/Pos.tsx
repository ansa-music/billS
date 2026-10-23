import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CounterService,
  CreateCounterOrderRequest,
  CreateCounterOrderResponse,
  Minor,
  PaymentMethod,
  PricedLine,
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
  planPayment,
  priceLine,
} from '@bills/domain';
import { newKey } from '../api.ts';
import type { Desk } from '../cash/desk.ts';
import { toActionError, useAction, useDesk } from '../cash/desk.ts';
import { METHOD_LABEL, toMoneyInput } from '../cash/format.ts';
import { FormError, Modal } from '../cash/Modal.tsx';
import { printReceipt } from '../cash/print/Receipt.tsx';
import { OpenShiftForm } from '../cash/ShiftPanel.tsx';
import { Icon } from '../icons.tsx';
import { OfflineBanner } from '../OfflineBanner.tsx';
import { sellable, sortCatalog, useCatalog } from '../pages/bar/useCatalog.tsx';
import { Loading } from '../ui.tsx';
import { useHub } from '../useHub.tsx';
import { createCounterOrder, optionsOf } from './cafe.ts';
import './cafe.css';

/** One line of the order being taken: a product with its chosen options. */
interface Line {
  key: string;
  productId: string;
  choices: string[];
  qty: number;
}

/** The product sheet: a new line, or an existing one being changed. */
interface Sheet {
  product: ProductView;
  choices: string[];
  qty: number;
  editing: string | null;
}

interface Done {
  res: CreateCounterOrderResponse;
  method: PaymentMethod | null;
}

const lineKey = (productId: string, choices: readonly string[]) => `${productId}|${[...choices].sort().join(',')}`;

function tryPrice(product: ProductView, choices: readonly string[]): { priced: PricedLine | null; problem: string | null } {
  try {
    return { priced: priceLine({ name: product.name, price: product.price, options: optionsOf(product) }, choices), problem: null };
  } catch (e) {
    return { priced: null, problem: (e as Error).message };
  }
}

/** Round sums a guest is likely to hand over: the next 500, 1 000, 5 000… above the total. */
function quickTenders(total: Minor, currency: string): Minor[] {
  const per = minorPerMajor(currency);
  const steps = ['USD', 'EUR'].includes(currency) ? [5, 10, 20, 50, 100] : [500, 1000, 2000, 5000, 10000, 20000];
  const out = new Set<Minor>();
  for (const step of steps) {
    const unit = step * per;
    const up = Math.ceil(total / unit) * unit;
    if (up > total) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, 4);
}

/**
 * #/pos — «Касса» of a coffee shop: tap drinks (with options: size, milk,
 * syrup), take the money, the guest gets a number. The order goes to the
 * barista's screen at once; the check and payment land in the open shift.
 */
export function PosPage() {
  const hub = useHub();
  const { state, online, actor, canNow, blockedReason } = hub;
  const { currency } = state.club;
  const money = (a: Minor) => formatMoney(a, currency);
  const desk = useDesk({ state, actor, refresh: hub.refresh, notify: hub.notify });
  const { catalog, error: catalogError } = useCatalog();

  const [category, setCategory] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [service, setService] = useState<CounterService>('TAKEAWAY');
  const [guestName, setGuestName] = useState('');
  const [cashOpen, setCashOpen] = useState(false);
  const [tendered, setTendered] = useState('');
  const [done, setDone] = useState<Done | null>(null);
  const [shiftDialog, setShiftDialog] = useState(false);
  const action = useAction();
  // The same order sent again (a retry after a lost answer) keeps its idempotency key.
  const pendingKey = useRef<{ body: string; key: string } | null>(null);
  const orderRef = useRef<HTMLElement>(null);

  const sorted = useMemo(() => (catalog ? sortCatalog(catalog) : null), [catalog]);
  const products = useMemo(() => (catalog ? sellable(catalog) : []), [catalog]);
  const byId = useMemo(() => new Map((sorted?.products ?? []).map((p) => [p.id, p])), [sorted]);
  const categories = useMemo(
    () => (sorted?.categories ?? []).filter((c) => c.isActive && products.some((p) => p.categoryId === c.id)),
    [sorted, products],
  );
  const activeCategory = categories.some((c) => c.id === category) ? category : (categories[0]?.id ?? null);
  const shown = products.filter((p) => p.categoryId === activeCategory);

  const priced = lines.map((l) => {
    const product = byId.get(l.productId);
    const price = product ? tryPrice(product, l.choices) : { priced: null, problem: 'Товара больше нет в меню' };
    return { line: l, product, ...price };
  });
  const total = priced.reduce((sum, p) => sum + (p.priced ? p.priced.unitPrice * p.line.qty : 0), 0);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const broken = priced.some((p) => !p.priced || !p.product?.isActive);

  const noShift = state.shift === null;
  // Taking an order includes its payment (counter.take: cashier and barista); the HUB decides the rest.
  const canOrder = canNow('counter.take');
  const canPay = canOrder;
  const orderBlocked = blockedReason('counter.take');
  const locked = action.pending || !online || !canOrder;

  // A paid order clears the form; the confirmation stays until «Новый заказ».
  const reset = () => {
    setLines([]);
    setGuestName('');
    setCashOpen(false);
    setTendered('');
    action.setError(null);
  };

  // A changed order is a different request: drop the cash form's stale amount.
  useEffect(() => {
    setTendered('');
  }, [total]);

  const maxQty = (p: ProductView) => Math.min(ORDER_MAX_QTY, p.stock ?? ORDER_MAX_QTY);
  const qtyOf = (productId: string, except?: string) =>
    lines.reduce((n, l) => (l.productId === productId && l.key !== except ? n + l.qty : n), 0);

  const addLine = (product: ProductView, choices: string[], qty: number, replacing: string | null) => {
    const key = lineKey(product.id, choices);
    setLines((ls) => {
      const rest = replacing ? ls.filter((l) => l.key !== replacing) : ls;
      const same = rest.find((l) => l.key === key);
      if (same) return rest.map((l) => (l.key === key ? { ...l, qty: Math.min(maxQty(product), l.qty + qty) } : l));
      const line: Line = { key, productId: product.id, choices, qty };
      if (!replacing) return [...rest, line];
      // Keep the edited line where it was.
      const at = ls.findIndex((l) => l.key === replacing);
      const next = [...rest];
      next.splice(Math.max(0, Math.min(at, next.length)), 0, line);
      return next;
    });
    action.setError(null);
  };

  const tapProduct = (p: ProductView) => {
    if (qtyOf(p.id) >= maxQty(p)) {
      hub.notify(p.stock !== null ? `Нет в наличии: ${p.name} (осталось ${p.stock})` : `Не больше ${ORDER_MAX_QTY} шт.`);
      return;
    }
    const options = optionsOf(p);
    if (options.length === 0) addLine(p, [], 1, null);
    else setSheet({ product: p, choices: defaultChoices(options), qty: 1, editing: null });
  };

  const changeQty = (key: string, delta: number) => {
    setLines((ls) =>
      ls.flatMap((l) => {
        if (l.key !== key) return [l];
        const product = byId.get(l.productId);
        const cap = product ? maxQty(product) - qtyOf(l.productId, l.key) : l.qty;
        const qty = Math.min(cap, l.qty + delta);
        return qty <= 0 ? [] : [{ ...l, qty }];
      }),
    );
  };

  const submit = (method: PaymentMethod | null) => {
    if (lines.length === 0 || broken) return;
    let parts: Array<{ method: PaymentMethod; amount: Minor }> | null = null;
    if (method === 'CASH') {
      const typed = tendered.trim() === '' ? total : parseMoney(tendered, currency);
      if (typed === null || typed < total) {
        action.setError({ code: 'TENDER', message: typed === null ? 'Проверьте сумму наличных' : `Не хватает ${money(total - typed)}` });
        return;
      }
      parts = total > 0 ? [{ method, amount: typed }] : [];
    } else if (method) {
      parts = total > 0 ? [{ method, amount: total }] : [];
    }
    const name = guestName.trim();
    const body: CreateCounterOrderRequest = {
      items: lines.map((l) => ({ productId: l.productId, qty: l.qty, ...(l.choices.length ? { options: l.choices } : {}) })),
      service,
      ...(name ? { guestName: name } : {}),
      payment: parts ? { parts } : null,
    };
    const json = JSON.stringify(body);
    if (pendingKey.current?.body !== json) pendingKey.current = { body: json, key: newKey() };
    const key = pendingKey.current.key;
    void action.run(async () => {
      try {
        const res = await createCounterOrder(actor, body, key);
        pendingKey.current = null;
        setDone({ res, method });
        reset();
      } finally {
        void hub.refresh();
      }
    });
  };

  const shiftProblem = action.error?.code === 'SHIFT_NOT_OPEN' || (noShift && canPay);

  if (!sorted) {
    return (
      <section className="page">
        {catalogError ? <p className="bar-error">{catalogError}</p> : <Loading online={online} />}
      </section>
    );
  }

  return (
    <section className="page pos">
      <OfflineBanner online={online} />
      {orderBlocked && <p className="blocked-note">{orderBlocked}</p>}
      <div className="pos-grid">
        <div className="pos-menu">
          {categories.length > 1 && (
            <div className="pos-tabs" role="tablist" aria-label="Категории">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  className="pos-tab"
                  aria-selected={c.id === activeCategory}
                  onClick={() => setCategory(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {products.length === 0 ? (
            <p className="empty">В меню пока нет товаров. Добавьте их в разделе «Меню».</p>
          ) : (
            <div className="pos-tiles" role="group" aria-label="Товары">
              {shown.map((p) => {
                const options = optionsOf(p);
                const from = options.length ? tryPrice(p, defaultChoices(options)).priced?.unitPrice ?? p.price : p.price;
                const inOrder = qtyOf(p.id);
                const out = p.stock === 0;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className="pos-tile"
                    data-in-order={inOrder > 0 || undefined}
                    disabled={out || locked}
                    onClick={() => tapProduct(p)}
                  >
                    <span className="pos-tile-name">{p.name}</span>
                    <span className="pos-tile-foot">
                      <span className="pos-tile-price">{money(from)}</span>
                      {out ? (
                        <span className="tag tag-danger">нет</span>
                      ) : inOrder > 0 ? (
                        <span className="pos-tile-count" aria-label={`В заказе: ${inOrder}`}>
                          {inOrder}
                        </span>
                      ) : options.length > 0 ? (
                        <span className="pos-tile-more">добавки</span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <aside className="pos-order panel" aria-label="Текущий заказ" ref={orderRef}>
          <header className="pos-order-head">
            <h2>Заказ</h2>
            {count > 0 && (
              <button type="button" className="btn btn-small btn-ghost" disabled={action.pending} onClick={reset}>
                Очистить
              </button>
            )}
          </header>

          {lines.length === 0 ? (
            <p className="empty pos-order-empty">Нажимайте на напитки слева — они появятся здесь.</p>
          ) : (
            <ul className="pos-lines">
              {priced.map(({ line, product, priced: pl, problem }) => {
                const editable = product && optionsOf(product).length > 0;
                return (
                  <li key={line.key} data-broken={!pl || undefined}>
                    <button
                      type="button"
                      className="pos-line-title"
                      disabled={!editable || action.pending}
                      onClick={() =>
                        product && setSheet({ product, choices: line.choices, qty: line.qty, editing: line.key })
                      }
                      title={editable ? 'Изменить добавки' : undefined}
                    >
                      <strong>{pl?.title ?? product?.name ?? 'Товар недоступен'}</strong>
                      <span className="muted">{pl ? `${money(pl.unitPrice)} × ${line.qty}` : (problem ?? 'уберите из заказа')}</span>
                    </button>
                    <span className="pos-qty" role="group" aria-label="Количество">
                      <button type="button" className="pos-qty-btn" aria-label="Меньше" disabled={action.pending} onClick={() => changeQty(line.key, -1)}>
                        <Icon name="minus" size={18} />
                      </button>
                      <output>{line.qty}</output>
                      <button
                        type="button"
                        className="pos-qty-btn"
                        aria-label="Больше"
                        disabled={action.pending || !product || qtyOf(line.productId) >= maxQty(product)}
                        onClick={() => changeQty(line.key, 1)}
                      >
                        <Icon name="plus" size={18} />
                      </button>
                    </span>
                    <span className="pos-line-sum">{pl ? money(pl.unitPrice * line.qty) : '—'}</span>
                    <button
                      type="button"
                      className="pos-remove"
                      aria-label="Убрать"
                      disabled={action.pending}
                      onClick={() => changeQty(line.key, -line.qty)}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="pos-service" role="radiogroup" aria-label="Где пьёт гость">
            {(['HERE', 'TAKEAWAY'] as const).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={service === s} className="pos-service-btn" onClick={() => setService(s)}>
                {COUNTER_SERVICE_LABEL[s]}
              </button>
            ))}
          </div>
          <label className="field pos-guest">
            <span>Имя гостя (на экране заказов)</span>
            <input
              value={guestName}
              maxLength={GUEST_NAME_MAX}
              autoComplete="off"
              placeholder="Необязательно"
              onChange={(e) => setGuestName(e.target.value)}
            />
          </label>

          <div className="pos-total">
            <span>Итого</span>
            <strong>{money(total)}</strong>
          </div>

          {shiftProblem && (
            <div className="pos-shift" role="alert">
              <span>Смена не открыта — оплату принять нельзя.</span>
              {canNow('shift.open') && (
                <button type="button" className="btn btn-small btn-primary" onClick={() => setShiftDialog(true)}>
                  Открыть смену
                </button>
              )}
            </div>
          )}
          <FormError error={action.error && action.error.code !== 'SHIFT_NOT_OPEN' ? action.error.message : null} />

          {cashOpen ? (
            <CashForm
              total={total}
              currency={currency}
              tendered={tendered}
              onTendered={setTendered}
              busy={locked || lines.length === 0 || broken || noShift}
              onPay={() => submit('CASH')}
              onBack={() => {
                setCashOpen(false);
                setTendered('');
                action.setError(null);
              }}
            />
          ) : (
            <div className="pos-pay">
              <button
                type="button"
                className="btn pos-pay-btn pos-pay-cash"
                disabled={locked || !canPay || noShift || lines.length === 0 || broken}
                onClick={() => {
                  action.setError(null);
                  setCashOpen(true);
                }}
              >
                {METHOD_LABEL.CASH}
              </button>
              <button
                type="button"
                className="btn pos-pay-btn"
                disabled={locked || !canPay || noShift || lines.length === 0 || broken}
                onClick={() => submit('CARD')}
              >
                {METHOD_LABEL.CARD}
              </button>
              <button
                type="button"
                className="btn pos-pay-btn"
                disabled={locked || !canPay || noShift || lines.length === 0 || broken}
                onClick={() => submit('QR')}
              >
                {METHOD_LABEL.QR}
              </button>
              <button
                type="button"
                className="btn btn-ghost pos-pay-later"
                disabled={locked || lines.length === 0 || broken}
                title="Заказ уйдёт бариста, счёт останется открытым в «Счетах»"
                onClick={() => submit(null)}
              >
                Без оплаты
              </button>
            </div>
          )}
          {action.pending && <p className="hint">Отправляем заказ…</p>}
        </aside>
      </div>

      {/* Phone: the order is below the menu — a bar to jump to it. */}
      {count > 0 && (
        <button
          type="button"
          className="pos-jump"
          onClick={() => orderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          <span>
            Заказ · {count} шт.
          </span>
          <strong>{money(total)}</strong>
        </button>
      )}

      {sheet && (
        <OptionsSheet
          sheet={sheet}
          currency={currency}
          maxQty={maxQty(sheet.product) - qtyOf(sheet.product.id, sheet.editing ?? undefined)}
          onClose={() => setSheet(null)}
          onAdd={(choices, qty) => {
            addLine(sheet.product, choices, qty, sheet.editing);
            setSheet(null);
          }}
        />
      )}

      {done && <DoneDialog done={done} desk={desk} onClose={() => setDone(null)} />}

      {shiftDialog && (
        <Modal title="Открыть смену" onClose={() => setShiftDialog(false)}>
          <OpenShiftForm
            desk={desk}
            onOpened={() => {
              setShiftDialog(false);
              action.setError(null);
              hub.notify('Смена открыта');
            }}
          />
        </Modal>
      )}
    </section>
  );
}

/** Product sheet: option groups, live price, quantity, «Добавить». */
function OptionsSheet({
  sheet,
  currency,
  maxQty,
  onClose,
  onAdd,
}: {
  sheet: Sheet;
  currency: string;
  maxQty: number;
  onClose: () => void;
  onAdd: (choices: string[], qty: number) => void;
}) {
  const { product } = sheet;
  const options = optionsOf(product);
  const [choices, setChoices] = useState<string[]>(sheet.choices);
  const [qty, setQty] = useState(Math.max(1, Math.min(sheet.qty, maxQty)));
  const { priced, problem } = tryPrice(product, choices);
  const money = (a: Minor) => formatMoney(a, currency);
  const delta = (d: Minor) => (d === 0 ? '' : `${d > 0 ? '+' : '−'}${money(Math.abs(d))}`);

  const pick = (groupId: string, choiceId: string) => {
    const group = options.find((g) => g.id === groupId);
    if (!group) return;
    setChoices((cs) => {
      const has = cs.includes(choiceId);
      if (group.multiple) return has ? cs.filter((c) => c !== choiceId) : [...cs, choiceId];
      const others = cs.filter((c) => !group.choices.some((gc) => gc.id === c));
      // A required group always keeps one choice; an optional one can be cleared by tapping again.
      if (has) return group.required ? cs : others;
      return [...others, choiceId];
    });
  };

  return (
    <Modal
      title={product.name}
      onClose={onClose}
      className="modal-options"
      footer={
        <>
          <FormError error={problem} />
          <div className="sheet-foot">
            <span className="pos-qty sheet-qty" role="group" aria-label="Количество">
              <button type="button" className="pos-qty-btn" aria-label="Меньше" disabled={qty <= 1} onClick={() => setQty((q) => q - 1)}>
                <Icon name="minus" size={20} />
              </button>
              <output>{qty}</output>
              <button
                type="button"
                className="pos-qty-btn"
                aria-label="Больше"
                disabled={qty >= maxQty}
                onClick={() => setQty((q) => q + 1)}
              >
                <Icon name="plus" size={20} />
              </button>
            </span>
            <button
              type="button"
              className="btn btn-primary sheet-add"
              disabled={!priced || maxQty < 1}
              data-autofocus=""
              onClick={() => onAdd(choices, qty)}
            >
              {sheet.editing ? 'Сохранить' : 'Добавить'} · {priced ? money(priced.unitPrice * qty) : '—'}
            </button>
          </div>
        </>
      }
    >
      <div className="sheet-groups">
        {options.map((g) => (
          <fieldset key={g.id} className="sheet-group">
            <legend>
              {g.name}
              <span className="muted">{g.required ? ' · обязательно' : g.multiple ? ' · можно несколько' : ' · по желанию'}</span>
            </legend>
            <div className="sheet-choices" role={g.multiple ? 'group' : 'radiogroup'} aria-label={g.name}>
              {g.choices.map((c) => {
                const on = choices.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    role={g.multiple ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    className="sheet-choice"
                    onClick={() => pick(g.id, c.id)}
                  >
                    <span>{c.name}</span>
                    {c.priceDelta !== 0 && <span className="sheet-delta">{delta(c.priceDelta)}</span>}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}

/** Cash: what the guest hands over, quick round sums, the change. */
function CashForm({
  total,
  currency,
  tendered,
  onTendered,
  busy,
  onPay,
  onBack,
}: {
  total: Minor;
  currency: string;
  tendered: string;
  onTendered: (v: string) => void;
  busy: boolean;
  onPay: () => void;
  onBack: () => void;
}) {
  const money = (a: Minor) => formatMoney(a, currency);
  const typed = tendered.trim() === '' ? total : parseMoney(tendered, currency);
  let preview: { change: Minor } | { problem: string } | null = null;
  if (typed === null) preview = { problem: 'Проверьте сумму' };
  else if (typed < total) preview = { problem: `Не хватает ${money(total - typed)}` };
  else if (total > 0) {
    try {
      preview = { change: planPayment(total, [{ method: 'CASH', amount: typed }]).change };
    } catch (e) {
      preview = { problem: toActionError(e).message };
    }
  }
  const quick = quickTenders(total, currency);

  return (
    <div className="pos-cash">
      <label className="field">
        <span>Гость даёт наличными</span>
        <input
          className="money-input pos-cash-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={toMoneyInput(total, currency)}
          value={tendered}
          autoFocus
          onChange={(e) => onTendered(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) onPay();
          }}
        />
      </label>
      <div className="pos-quick" role="group" aria-label="Быстрые суммы">
        <button type="button" className="chip" aria-pressed={tendered.trim() === ''} onClick={() => onTendered('')}>
          Без сдачи
        </button>
        {quick.map((q) => (
          <button
            key={q}
            type="button"
            className="chip"
            aria-pressed={typed === q && tendered.trim() !== ''}
            onClick={() => onTendered(toMoneyInput(q, currency))}
          >
            {money(q)}
          </button>
        ))}
      </div>
      <p className="pos-change" data-zero={preview && 'change' in preview && preview.change === 0 ? '' : undefined} aria-live="polite">
        {preview === null ? '' : 'problem' in preview ? preview.problem : `Сдача: ${money(preview.change)}`}
      </p>
      <div className="row">
        <button type="button" className="btn btn-ghost btn-narrow" onClick={onBack}>
          Назад
        </button>
        <button
          type="button"
          className="btn btn-primary pos-cash-pay"
          disabled={busy || preview === null || 'problem' in preview}
          onClick={onPay}
        >
          Принять {money(typed ?? total)}
        </button>
      </div>
    </div>
  );
}

/** «Заказ 17»: the number to tell the guest, the change to give, the receipt. */
function DoneDialog({ done, desk, onClose }: { done: Done; desk: Desk; onClose: () => void }) {
  const { order, check, payment } = done.res;
  const { club } = desk.state;
  const money = (a: Minor) => formatMoney(a, club.currency);
  const change = payment?.change ?? 0;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <Modal
      title="Заказ принят"
      onClose={onClose}
      className="modal-done"
      footer={
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => printReceipt(check, club, undefined, Date.now(), order.number)}>
            Печать чека
          </button>
          <button ref={ref} type="button" className="btn btn-primary" onClick={onClose}>
            Новый заказ
          </button>
        </div>
      }
    >
      <div className="pos-done" role="status">
        <p className="pos-done-label">Заказ</p>
        <p className="pos-done-number">{order.number}</p>
        <p className="pos-done-sub">
          {COUNTER_SERVICE_LABEL[order.service]}
          {order.guestName ? ` · ${order.guestName}` : ''} · {money(order.total)}
        </p>
        {done.method === 'CASH' && (
          <p className="pay-change pos-done-change" data-zero={change === 0 || undefined}>
            {change > 0 ? `Сдача: ${money(change)}` : 'Без сдачи'}
          </p>
        )}
        {done.method && done.method !== 'CASH' && <p className="pos-done-paid">Оплачено: {METHOD_LABEL[done.method]}</p>}
        {!done.method && <p className="hint hint-warn">Без оплаты — счёт №{check.number} ждёт в «Счетах».</p>}
      </div>
    </Modal>
  );
}
