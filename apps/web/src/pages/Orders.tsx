import { useEffect, useMemo, useState } from 'react';
import type { OrderView, ProductView, SessionView } from '@bills/domain';
import { calculateCharge, formatMoney, ORDER_MAX_QTY, orderTotal, sessionTotal } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useAuth } from '../auth.ts';
import { formatClock, formatDuration } from '../format.ts';
import { OfflineBanner } from '../OfflineBanner.tsx';
import { Empty, Field, Loading, Modal, Page, Section, Toast, useToast } from '../ui.tsx';
import { useCommands, useHub, useServerNow } from '../useHub.tsx';
import { sellable, sortCatalog, useCatalog } from './bar/useCatalog.tsx';
import './bar.css';

interface Target {
  session: SessionView;
  tableName: string;
  phase: 'playing' | 'unpaid';
}

/** Waiter's screen (#/orders): pick a table with a game, compose an order, see the game's orders. */
export function OrdersPage() {
  const { state, online } = useHub();
  const serverNow = useServerNow();
  const { can } = useAuth();
  const { toast, show, clear } = useToast();
  const { run, busy, isBusy } = useCommands(show);
  const { catalog, error: catalogError } = useCatalog();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [category, setCategory] = useState<'all' | string>('all');
  const [cart, setCart] = useState<Map<string, number>>(() => new Map());
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<{ sessionId: string; orders: OrderView[] } | null>(null);
  const [cancelling, setCancelling] = useState<OrderView | null>(null);
  const [reason, setReason] = useState('');

  // Tables that can take an order: a running game, or a stopped game waiting for payment.
  const targets = useMemo<Target[]>(() => {
    if (!state) return [];
    const names = new Map(state.tables.map((t) => [t.id, t.name]));
    const live: Target[] = state.tables
      .filter((t) => t.session?.status === 'ACTIVE')
      .map((t) => ({ session: t.session!, tableName: t.name, phase: 'playing' }));
    const unpaid: Target[] = state.unpaid.map((s) => ({
      session: s,
      tableName: names.get(s.tableId) ?? 'Стол',
      phase: 'unpaid',
    }));
    return [...live, ...unpaid];
  }, [state]);

  const selected = targets.find((t) => t.session.id === selectedId) ?? null;

  // The game may have been closed meanwhile: drop the selection.
  useEffect(() => {
    if (selectedId && state && !selected) setSelectedId(null);
  }, [selectedId, selected, state]);

  // History of the selected game (cancelled orders included); refetched on every state change.
  useEffect(() => {
    if (!selectedId) {
      setHistory(null);
      return;
    }
    let alive = true;
    fetchJson<{ orders: OrderView[] }>(`/api/sessions/${selectedId}/orders`)
      .then((r) => alive && setHistory({ sessionId: selectedId, orders: r.orders }))
      .catch(() => {
        // The live state still shows open orders; the history just lags.
      });
    return () => {
      alive = false;
    };
  }, [selectedId, state]);

  if (!state) {
    return (
      <Page title="Заказы на столы">
        <Loading online={online} />
      </Page>
    );
  }

  const currency = state.club.currency;
  const timezone = state.club.timezone;
  const locked = busy.size > 0 || !online;
  const products = catalog ? sellable(catalog) : [];
  const productById = new Map((catalog ? sortCatalog(catalog).products : []).map((p) => [p.id, p]));
  const activeCategories = catalog ? sortCatalog(catalog).categories.filter((c) => c.isActive) : [];
  const shownProducts = category === 'all' ? products : products.filter((p) => p.categoryId === category);

  const cartLines = [...cart.entries()].map(([productId, qty]) => ({ productId, qty, product: productById.get(productId) }));
  const cartTotal = orderTotal(cartLines.map((l) => ({ price: l.product?.price ?? 0, qty: l.qty })));
  const cartCount = cartLines.reduce((n, l) => n + l.qty, 0);

  const add = (p: ProductView) => {
    const cap = Math.min(ORDER_MAX_QTY, p.stock ?? ORDER_MAX_QTY);
    const qty = (cart.get(p.id) ?? 0) + 1;
    if (qty > cap) {
      show(p.stock !== null && qty > p.stock ? `Нет в наличии: ${p.name} (осталось ${p.stock})` : `Не больше ${ORDER_MAX_QTY} шт.`);
      return;
    }
    setCart((c) => new Map(c).set(p.id, qty));
  };

  const change = (productId: string, delta: number) => {
    setCart((c) => {
      const next = new Map(c);
      const qty = (next.get(productId) ?? 0) + delta;
      if (qty <= 0) next.delete(productId);
      else next.set(productId, Math.min(ORDER_MAX_QTY, qty));
      return next;
    });
  };

  const submit = async () => {
    if (!selected || cartLines.length === 0) return;
    const items = cartLines.map((l) => ({ productId: l.productId, qty: l.qty }));
    const trimmed = note.trim();
    const res = await run<OrderView>('order', `/api/sessions/${selected.session.id}/orders`, {
      items,
      ...(trimmed ? { note: trimmed } : {}),
    });
    if (!res) return;
    setCart(new Map());
    setNote('');
    show('Заказ добавлен');
  };

  const confirmCancel = async () => {
    if (!cancelling) return;
    const res = await run<OrderView>(`cancel:${cancelling.id}`, `/api/orders/${cancelling.id}/cancel`, {
      reason: reason.trim(),
    });
    if (!res) return;
    setCancelling(null);
    setReason('');
    show('Заказ отменён');
  };

  // Orders of the selected game: the history (all statuses) plus anything newer from the live state.
  const orders: OrderView[] = (() => {
    if (!selected) return [];
    const map = new Map<string, OrderView>();
    for (const o of state.orders) if (o.sessionId === selected.session.id) map.set(o.id, o);
    if (history?.sessionId === selected.session.id) for (const o of history.orders) map.set(o.id, o);
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  })();

  return (
    <Page
      title="Заказы на столы"
      subtitle="Выберите стол с игрой, соберите заказ и отправьте — он попадёт в счёт гостя."
      wide
    >
      <OfflineBanner online={online} />
      {catalogError && <p className="bar-error">{catalogError}</p>}

      <Section title="Столы с игрой" aside={<span className="muted">{targets.length}</span>}>
        {targets.length === 0 ? (
          <Empty>Сейчас нет ни идущих игр, ни неоплаченных. Заказ можно добавить только к игре.</Empty>
        ) : (
          <div className="order-targets" role="group" aria-label="Столы">
            {targets.map((t) => (
              <TargetCard
                key={t.session.id}
                target={t}
                serverNow={serverNow}
                currency={currency}
                timezone={timezone}
                selected={t.session.id === selectedId}
                onSelect={() => setSelectedId(t.session.id === selectedId ? null : t.session.id)}
              />
            ))}
          </div>
        )}
      </Section>

      {selected && (
        <>
          <div className="order-composer">
            <Section title={`Заказ · ${selected.tableName}`}>
              {!catalog ? (
                <Loading online={online} />
              ) : products.length === 0 ? (
                <Empty>В меню пока нет товаров. Управляющий добавляет их в разделе «Бар и меню».</Empty>
              ) : (
                <>
                  <div className="bar-chips" role="group" aria-label="Категории">
                    <button type="button" className="chip" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
                      Все
                    </button>
                    {activeCategories.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="chip"
                        aria-pressed={category === c.id}
                        onClick={() => setCategory(c.id)}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                  <div className="order-products" role="group" aria-label="Товары">
                    {shownProducts.map((p) => {
                      const inCart = cart.get(p.id) ?? 0;
                      const out = p.stock === 0;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          className="order-product"
                          data-in-cart={inCart > 0 ? '' : undefined}
                          disabled={out || locked}
                          onClick={() => add(p)}
                        >
                          <span className="order-product-name">{p.name}</span>
                          <span className="order-product-foot">
                            <span className="bar-money">{formatMoney(p.price, currency)}</span>
                            {out ? (
                              <span className="tag tag-danger">нет</span>
                            ) : inCart > 0 ? (
                              <span className="order-product-count" aria-label={`В заказе: ${inCart}`}>
                                {inCart}
                              </span>
                            ) : p.stock !== null ? (
                              <span className="muted">{p.stock} шт.</span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })}
                    {shownProducts.length === 0 && <Empty>В этой категории нет товаров.</Empty>}
                  </div>
                </>
              )}
            </Section>

            <Section title="Корзина" aside={cartCount > 0 && <span className="muted">{cartCount} шт.</span>}>
              <div className="order-cart">
                {cartLines.length === 0 ? (
                  <Empty>Нажимайте на товары, чтобы добавить их в заказ.</Empty>
                ) : (
                  <ul className="order-cart-lines">
                    {cartLines.map((l) => (
                      <li key={l.productId}>
                        <span className="order-cart-title">{l.product?.name ?? 'Товар недоступен'}</span>
                        <span className="order-cart-sub">
                          {l.product
                            ? `${formatMoney(l.product.price, currency)} × ${l.qty} = ${formatMoney(l.product.price * l.qty, currency)}`
                            : 'уберите из заказа'}
                        </span>
                        <span className="order-qty" role="group" aria-label={`Количество: ${l.product?.name ?? ''}`}>
                          <button type="button" className="btn btn-small" onClick={() => change(l.productId, -1)} aria-label="Меньше">
                            −
                          </button>
                          <output>{l.qty}</output>
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={!l.product || l.qty >= Math.min(ORDER_MAX_QTY, l.product.stock ?? ORDER_MAX_QTY)}
                            onClick={() => change(l.productId, 1)}
                            aria-label="Больше"
                          >
                            +
                          </button>
                          <button
                            type="button"
                            className="btn btn-small btn-ghost"
                            onClick={() => change(l.productId, -l.qty)}
                            aria-label="Убрать"
                          >
                            ✕
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <Field label="Комментарий">
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    maxLength={200}
                    placeholder="Например: без льда"
                  />
                </Field>
                <div className="order-cart-total">
                  <span>Итого</span>
                  <span className="bar-money">{formatMoney(cartTotal, currency)}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={locked || cartLines.length === 0 || cartLines.some((l) => !l.product)}
                  onClick={() => void submit()}
                >
                  {isBusy('order') ? 'Отправляем…' : `Отправить заказ · ${selected.tableName}`}
                </button>
              </div>
            </Section>
          </div>

          <Section
            title={`Заказы · ${selected.tableName}`}
            aside={
              <span className="muted">
                Открытых на {formatMoney(selected.session.ordersTotal, currency)}
              </span>
            }
          >
            {orders.length === 0 ? (
              <Empty>На эту игру заказов ещё нет.</Empty>
            ) : (
              <ul className="order-list">
                {orders.map((o) => (
                  <li key={o.id} className="order-card" data-cancelled={o.status === 'CANCELLED' ? '' : undefined}>
                    <div className="order-card-head">
                      <span>
                        <strong>{formatClock(o.createdAt, timezone)}</strong>{' '}
                        <span className="muted">· {o.createdBy}</span>
                      </span>
                      {o.status === 'CANCELLED' ? (
                        <span className="tag tag-danger">отменён</span>
                      ) : (
                        <span className="tag tag-ok">открыт</span>
                      )}
                    </div>
                    <ul className="order-card-items">
                      {o.items.map((it) => (
                        <li key={it.id}>
                          <span>
                            {it.title} × {it.qty}
                          </span>
                          <span className="bar-money">{formatMoney(it.amount, currency)}</span>
                        </li>
                      ))}
                    </ul>
                    {o.note && <p className="order-card-note">Комментарий: {o.note}</p>}
                    {o.status === 'CANCELLED' && (
                      <p className="order-card-note">
                        Отменил {o.cancelledBy}
                        {o.cancelledAt != null && ` в ${formatClock(o.cancelledAt, timezone)}`}: {o.cancelReason}
                      </p>
                    )}
                    <div className="order-card-foot">
                      <span className="order-card-total bar-money">{formatMoney(o.total, currency)}</span>
                      {o.status === 'OPEN' && can('order.cancel') && (
                        <button
                          type="button"
                          className="btn btn-small btn-outline-danger"
                          disabled={locked}
                          onClick={() => {
                            setReason('');
                            setCancelling(o);
                          }}
                        >
                          Отменить
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <Modal open={cancelling !== null} title="Отменить заказ" onClose={() => setCancelling(null)}>
        {cancelling && (
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmCancel();
            }}
          >
            <p>
              Заказ на {formatMoney(cancelling.total, currency)} от {formatClock(cancelling.createdAt, timezone)}. Остатки
              вернутся на склад, отмена попадёт в журнал.
            </p>
            <Field label="Причина" hint="Не короче 3 символов">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={300}
                autoFocus
                required
              />
            </Field>
            <div className="row wrap modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setCancelling(null)} disabled={locked}>
                Назад
              </button>
              <button type="submit" className="btn btn-danger" disabled={locked || reason.trim().length < 3}>
                Отменить заказ
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Toast message={toast} onClose={clear} />
    </Page>
  );
}

function TargetCard({
  target,
  serverNow,
  currency,
  timezone,
  selected,
  onSelect,
}: {
  target: Target;
  serverNow: number;
  currency: string;
  timezone: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const s = target.session;
  // A running game is priced from the HUB clock, like the hall screen; a stopped one is final.
  const gameAmount =
    target.phase === 'playing' && s.startedAt !== null
      ? calculateCharge(s.startedAt, Math.max(serverNow, s.startedAt), s.tariff, s.timezone).amount
      : (s.amount ?? 0);
  const total = sessionTotal(gameAmount, s.ordersTotal);
  return (
    <button type="button" className="order-target" aria-pressed={selected} onClick={onSelect}>
      <span className="order-target-head">
        <strong>{target.tableName}</strong>
        <span className="phase" data-phase={target.phase}>
          {target.phase === 'playing' ? 'Идёт игра' : 'Ожидает оплаты'}
        </span>
      </span>
      <span className="order-target-meta">
        <span className="line">
          <span>
            {target.phase === 'playing' && s.startedAt !== null
              ? formatDuration(serverNow - s.startedAt)
              : `${s.startedAt != null ? formatClock(s.startedAt, timezone) : ''}–${
                  s.stoppedAt != null ? formatClock(s.stoppedAt, timezone) : ''
                }`}
          </span>
          <span className="amount bar-money">{formatMoney(gameAmount, currency)}</span>
        </span>
        <span className="line">
          <span>Заказы</span>
          <span className="bar-money">{formatMoney(s.ordersTotal, currency)}</span>
        </span>
      </span>
      <span className="order-target-total">{formatMoney(total, currency)}</span>
    </button>
  );
}
