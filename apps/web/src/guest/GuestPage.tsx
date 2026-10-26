import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CreateGuestRequest, GuestMenuProduct, GuestPageView, GuestRequestView, Minor } from '@bills/domain';
import { defaultChoices, formatMoney, GUEST_NAME_MAX, guestPositions, guestRequestSummary, priceLine } from '@bills/domain';
import { HubRequestError, hubUrl } from '../api.ts';
import { BrandMark } from '../BrandMark.tsx';
import { toggleChoice } from '../cafe/pos-model.ts';
import { usePolling } from '../cafe/cafe.ts';
import { formatDuration } from '../format.ts';
import { Icon } from '../icons.tsx';
import { formatCountdown } from '../prepaid/prepaid.ts';
import { fetchGuestPage, sendGuestRequest } from './api.ts';
import './guest.css';

const POLL_MS = 5000;
const SENT_MS = 6000;
const MINE_MAX = 10;

interface CartLine {
  key: string;
  product: GuestMenuProduct;
  choices: string[];
  qty: number;
}

const STATUS_TEXT: Record<NonNullable<GuestPageView['table']>['status'], string> = {
  FREE: 'Стол свободен',
  OPENING: 'Включаем свет…',
  ACTIVE: 'Идёт игра',
  PAUSED: 'Пауза',
  AWAITING_PAYMENT: 'Игра окончена — ждёт оплаты',
};

const REQUEST_STATUS: Record<GuestRequestView['status'], string> = {
  PENDING: 'Отправлен — к вам подойдут',
  ACCEPTED: 'Принят',
  REJECTED: 'Отклонён — спросите сотрудника',
};

function readMine(token: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(`bills.guest.mine:${token}`) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MINE_MAX) : [];
  } catch {
    return [];
  }
}

function writeMine(token: string, ids: string[]): void {
  try {
    localStorage.setItem(`bills.guest.mine:${token}`, JSON.stringify(ids.slice(0, MINE_MAX)));
  } catch {
    // Private mode: the order is still on the board by its number.
  }
}

function linePrice(l: { product: GuestMenuProduct; choices: string[] }): { title: string; unit: Minor } {
  try {
    const p = priceLine({ name: l.product.name, price: l.product.price, options: l.product.options }, l.choices);
    return { title: p.title, unit: p.unitPrice };
  } catch {
    return { title: l.product.name, unit: l.product.price };
  }
}

/** Refetches at once when the HUB says something changed (SSE), on top of the poll. */
function useHubChanges(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const events = new EventSource(hubUrl('/api/events'));
    events.addEventListener('changed', () => setVersion((v) => v + 1));
    return () => events.close();
  }, []);
  return version;
}

/**
 * #/g/<token> — the page a guest opens from the QR sticker, without an app or a key.
 * Billiards: the table's time, amount and bar orders, and buttons that call staff.
 * Coffee shop: order ahead, then the order number and its stage live. Nothing here
 * pays or changes money: staff turn each request into an order the usual way.
 */
export function GuestPage({ token }: { token: string }) {
  const [mine, setMine] = useState<string[]>(() => readMine(token));
  const changes = useHubChanges();
  const load = useCallback(() => fetchGuestPage(token, mine), [token, mine]);
  const { data, error, reload } = usePolling(load, POLL_MS, `${changes}|${mine.join(',')}`);
  const [fatal, setFatal] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('bills.guest.name') ?? '';
    } catch {
      return '';
    }
  });

  // A dead link (rotated, off) is not retried forever as «нет связи».
  useEffect(() => {
    if (!error) return setFatal(null);
    void fetchGuestPage(token, []).catch((e: unknown) => {
      if (e instanceof HubRequestError && e.status === 404) setFatal(e.message);
    });
  }, [error, token]);

  useEffect(() => {
    if (data) document.title = data.table ? `${data.table.name} — ${data.venue.title}` : data.venue.title;
  }, [data]);

  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(null), SENT_MS);
    return () => clearTimeout(t);
  }, [sent]);

  const money = useCallback((a: Minor) => formatMoney(a, data?.venue.currency ?? 'KZT'), [data?.venue.currency]);

  const send = async (body: CreateGuestRequest, done: string) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const req = await sendGuestRequest(token, body);
      if (data?.business === 'cafe') {
        const next = [req.id, ...mine.filter((id) => id !== req.id)].slice(0, MINE_MAX);
        writeMine(token, next);
        setMine(next);
      }
      setSent(done);
      setCart([]);
      setMenuOpen(false);
      void reload();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (fatal || (!data && error)) {
    return (
      <main className="guest guest-dead">
        <BrandMark className="guest-mark" />
        <h1>{fatal ? 'Ссылка не работает' : 'Нет связи'}</h1>
        <p>{fatal ?? 'Проверьте, что телефон подключён к Wi-Fi заведения, и обновите страницу.'}</p>
        {!fatal && (
          <button type="button" className="btn btn-primary" onClick={() => void reload()}>
            Обновить
          </button>
        )}
      </main>
    );
  }
  if (!data) {
    return (
      <main className="guest guest-dead" aria-busy="true">
        <BrandMark className="guest-mark" />
        <p>Загрузка…</p>
      </main>
    );
  }

  const cafe = data.business === 'cafe';
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);
  const cartTotal = cart.reduce((s, l) => s + linePrice(l).unit * l.qty, 0);
  const submitCart = () => {
    const items = cart.map((l) => ({ productId: l.product.id, qty: l.qty, ...(l.choices.length ? { options: l.choices } : {}) }));
    if (cafe) {
      const n = name.trim();
      if (!n) return setProblem('Напишите имя — по нему вас позовут');
      try {
        localStorage.setItem('bills.guest.name', n);
      } catch {
        // Not remembered: fine.
      }
      void send({ kind: 'PREORDER', items, guestName: n }, 'Заказ отправлен — оплатите на кассе, назовите имя');
    } else {
      void send({ kind: 'BAR', items }, 'Запрос отправлен — к вам подойдут');
    }
  };

  return (
    <main className="guest">
      <header className="guest-head">
        {data.venue.logoUrl ? <img className="guest-logo" src={data.venue.logoUrl} alt="" /> : <BrandMark className="guest-mark" />}
        <div>
          <p className="guest-venue">{data.venue.title}</p>
          <h1>{data.table ? data.table.name : 'Заказ заранее'}</h1>
        </div>
        {error && <span className="guest-offline">Нет связи</span>}
      </header>

      {sent && (
        <p className="guest-sent" role="status">
          <Icon name="check" size={22} /> {sent}
        </p>
      )}
      {problem && (
        <p className="guest-problem" role="alert">
          {problem}
        </p>
      )}

      {data.table && <GuestTable view={data} money={money} />}

      {!cafe && (
        <section className="guest-actions" aria-label="Запросы">
          <button type="button" className="guest-action" disabled={busy || !data.can.WAITER} onClick={() => void send({ kind: 'WAITER' }, 'Запрос отправлен — к вам подойдут')}>
            <Icon name="bell" size={26} />
            Позвать официанта
          </button>
          <button type="button" className="guest-action" disabled={busy || !data.can.BAR || data.menu.products.length === 0} onClick={() => setMenuOpen(true)}>
            <Icon name="bar" size={26} />
            Заказать из бара
          </button>
          <button type="button" className="guest-action" disabled={busy || !data.can.EXTEND} onClick={() => void send({ kind: 'EXTEND', minutes: 30 }, 'Запрос отправлен — к вам подойдут')}>
            <Icon name="clock" size={26} />
            Продлить на 30 мин
          </button>
          <button type="button" className="guest-action" disabled={busy || !data.can.EXTEND} onClick={() => void send({ kind: 'EXTEND', minutes: 60 }, 'Запрос отправлен — к вам подойдут')}>
            <Icon name="clock" size={26} />
            Продлить на 60 мин
          </button>
          <button type="button" className="guest-action guest-action-wide" disabled={busy || !data.can.BILL} onClick={() => void send({ kind: 'BILL' }, 'Запрос отправлен — к вам подойдут')}>
            <Icon name="checks" size={26} />
            Попросить счёт
          </button>
        </section>
      )}

      {data.requests.length > 0 && <Requests list={data.requests} money={money} cafe={cafe} />}

      {cafe && !data.can.PREORDER && <p className="guest-note">Заказ заранее сейчас недоступен — подойдите к кассе.</p>}

      {(cafe ? data.can.PREORDER : menuOpen) && (
        <Menu
          view={data}
          money={money}
          cart={cart}
          onCart={setCart}
          onClose={cafe ? null : () => setMenuOpen(false)}
        />
      )}

      {cartCount > 0 && (cafe || menuOpen) && (
        <footer className="guest-cart">
          {cafe && (
            <label className="guest-name">
              <span>Ваше имя</span>
              <input
                value={name}
                maxLength={GUEST_NAME_MAX}
                autoComplete="given-name"
                placeholder="Например, Аня"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <button type="button" className="btn btn-primary guest-submit" disabled={busy} onClick={submitCart}>
            {cafe ? 'Заказать' : 'Отправить официанту'} · {guestPositions(cartCount)} · {money(cartTotal)}
          </button>
          <p className="guest-fine">{cafe ? 'Оплата на кассе, как обычно.' : 'Официант подтвердит заказ и принесёт его к столу.'}</p>
        </footer>
      )}
    </main>
  );
}

function GuestTable({ view, money }: { view: GuestPageView; money: (a: Minor) => string }) {
  const t = view.table!;
  const fetchedAt = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    fetchedAt.current = Date.now();
  }, [view]);
  useEffect(() => {
    if (t.status !== 'ACTIVE') return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [t.status]);
  const running = t.status === 'ACTIVE' ? Date.now() - fetchedAt.current : 0;
  const played = t.playedSeconds === null ? null : t.playedSeconds * 1000 + running;
  const left = t.prepaid?.leftMs == null ? null : Math.max(0, t.prepaid.leftMs - running);

  return (
    <section className="guest-card" data-status={t.status}>
      <p className="guest-status">{STATUS_TEXT[t.status]}</p>
      {t.status === 'FREE' ? (
        <p className="guest-note">Хотите поиграть? Позовите официанта — он откроет стол.</p>
      ) : (
        <>
          <div className="guest-figures">
            <div>
              <span>Время</span>
              <strong className="guest-timer">{played === null ? '—' : formatDuration(played)}</strong>
            </div>
            <div>
              <span>
                {t.prepaid?.paid && t.prepaid.extensionDue === 0
                  ? 'Бар к оплате'
                  : t.status === 'AWAITING_PAYMENT' || t.prepaid?.paid
                    ? 'К оплате'
                    : 'Сейчас к оплате'}
              </span>
              <strong>{money(t.total)}</strong>
            </div>
          </div>
          {t.prepaid && (
            <p className="guest-line guest-prepaid">
              {t.prepaid.paid ? 'Оплачено заранее' : 'Игра на время'}: {t.prepaid.minutes} мин
              {t.prepaid.extendedMinutes > 0 ? ` (продлено на ${t.prepaid.extendedMinutes})` : ''}
              {left !== null && t.status !== 'AWAITING_PAYMENT' ? (
                <>
                  {' · осталось '}
                  <strong className="guest-left">{formatCountdown(left)}</strong>
                  {t.status === 'PAUSED' ? ' (пауза)' : ''}
                </>
              ) : (
                ''
              )}
            </p>
          )}
          {t.prepaid?.paid && t.prepaid.extensionDue > 0 && (
            <p className="guest-line">Продление к оплате: {money(t.prepaid.extensionDue)}</p>
          )}
          {!t.prepaid && t.amount !== null && t.ordersTotal > 0 && (
            <p className="guest-line">
              Игра {money(t.amount)} + бар {money(t.ordersTotal)}
            </p>
          )}
          {t.tariffName && (
            <p className="guest-line guest-muted">
              Тариф «{t.tariffName}»{t.pricePerHour !== null ? ` · сейчас ${money(t.pricePerHour)} в час` : ''}
            </p>
          )}
          {t.orders.length > 0 && (
            <details className="guest-orders">
              <summary>
                Заказы из бара · {money(t.orders.reduce((s, o) => s + o.total, 0))}
              </summary>
              <ul>
                {t.orders.flatMap((o) =>
                  o.items.map((it, i) => (
                    <li key={`${o.id}-${i}`}>
                      <span>
                        {it.qty > 1 ? `${it.qty} × ` : ''}
                        {it.title}
                      </span>
                      <span>{money(it.amount)}</span>
                    </li>
                  )),
                )}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function Requests({ list, money, cafe }: { list: GuestRequestView[]; money: (a: Minor) => string; cafe: boolean }) {
  return (
    <section className="guest-requests" aria-label={cafe ? 'Ваши заказы' : 'Ваши запросы'}>
      <h2>{cafe ? 'Ваши заказы' : 'Ваши запросы'}</h2>
      <ul>
        {list.map((r) => (
          <li key={r.id} data-status={r.status} data-ready={r.order?.stage === 'READY' || undefined}>
            {r.kind === 'PREORDER' ? (
              r.order ? (
                <div className="guest-ticket">
                  <span className="guest-ticket-label">Заказ</span>
                  <strong className="guest-ticket-number">{r.order.number}</strong>
                  <span className="guest-ticket-stage">{r.order.stageText}</span>
                </div>
              ) : (
                <div>
                  <strong>
                    {r.guestName ? `${r.guestName}: ` : ''}
                    {guestPositions(r.items.reduce((s, i) => s + i.qty, 0))} · {money(r.total)}
                  </strong>
                  <p>{r.status === 'REJECTED' ? 'Касса не приняла заказ — подойдите к кассе' : 'Ждёт кассира: подойдите к кассе, назовите имя и оплатите'}</p>
                </div>
              )
            ) : (
              <div>
                <strong>{guestRequestSummary({ kind: r.kind, minutes: r.minutes, itemCount: r.items.reduce((s, i) => s + i.qty, 0) })}</strong>
                <p>{REQUEST_STATUS[r.status]}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Menu({
  view,
  money,
  cart,
  onCart,
  onClose,
}: {
  view: GuestPageView;
  money: (a: Minor) => string;
  cart: CartLine[];
  onCart: (fn: (c: CartLine[]) => CartLine[]) => void;
  onClose: (() => void) | null;
}) {
  const { categories, products } = view.menu;
  const [tab, setTab] = useState(categories[0]?.id ?? '');
  const [picking, setPicking] = useState<CartLine | null>(null);
  const shown = useMemo(() => products.filter((p) => p.categoryId === (tab || categories[0]?.id)), [products, tab, categories]);

  const add = (line: CartLine) =>
    onCart((c) => {
      const same = c.find((x) => x.product.id === line.product.id && [...x.choices].sort().join() === [...line.choices].sort().join());
      return same ? c.map((x) => (x === same ? { ...x, qty: Math.min(99, x.qty + line.qty) } : x)) : [...c, line];
    });

  const tap = (p: GuestMenuProduct) => {
    const line: CartLine = { key: `${p.id}-${Date.now()}`, product: p, choices: defaultChoices(p.options), qty: 1 };
    if (p.options.length) setPicking(line);
    else add(line);
  };

  return (
    <section className="guest-menu" aria-label="Меню">
      <header className="guest-menu-head">
        <h2>Меню</h2>
        {onClose && (
          <button type="button" className="icon-btn" aria-label="Закрыть меню" onClick={onClose}>
            <Icon name="close" />
          </button>
        )}
      </header>
      {categories.length > 1 && (
        <div className="guest-tabs" role="tablist">
          {categories.map((c) => (
            <button key={c.id} type="button" role="tab" className="chip" aria-pressed={c.id === tab} onClick={() => setTab(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
      )}
      <ul className="guest-products">
        {shown.map((p) => {
          const inCart = cart.filter((l) => l.product.id === p.id).reduce((s, l) => s + l.qty, 0);
          return (
            <li key={p.id}>
              <button type="button" onClick={() => tap(p)}>
                <span className="guest-product-name">{p.name}</span>
                <span className="guest-product-price">{p.options.length ? 'от ' : ''}{money(p.price)}</span>
                {inCart > 0 ? <span className="guest-badge">{inCart}</span> : <Icon name="plus" size={20} />}
              </button>
            </li>
          );
        })}
      </ul>
      {cart.length > 0 && (
        <ul className="guest-cart-lines" aria-label="Корзина">
          {cart.map((l) => {
            const { title, unit } = linePrice(l);
            return (
              <li key={l.key}>
                <span>{title}</span>
                <span className="guest-qty">
                  <button type="button" aria-label="Меньше" onClick={() => onCart((c) => c.flatMap((x) => (x.key !== l.key ? [x] : x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : [])))}>
                    −
                  </button>
                  {l.qty}
                  <button type="button" aria-label="Больше" onClick={() => onCart((c) => c.map((x) => (x.key === l.key ? { ...x, qty: Math.min(99, x.qty + 1) } : x)))}>
                    +
                  </button>
                </span>
                <span>{money(unit * l.qty)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {picking && (
        <OptionsSheet
          line={picking}
          money={money}
          onChange={setPicking}
          onAdd={() => {
            add(picking);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </section>
  );
}

function OptionsSheet({
  line,
  money,
  onChange,
  onAdd,
  onClose,
}: {
  line: CartLine;
  money: (a: Minor) => string;
  onChange: (l: CartLine) => void;
  onAdd: () => void;
  onClose: () => void;
}) {
  const { unit } = linePrice(line);
  return (
    <div className="guest-sheet" role="dialog" aria-modal="true" aria-label={line.product.name}>
      <button type="button" className="guest-scrim" aria-label="Закрыть" onClick={onClose} />
      <div className="guest-sheet-body">
        <header className="guest-menu-head">
          <h2>{line.product.name}</h2>
          <button type="button" className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {line.product.options.map((g) => (
          <fieldset key={g.id} className="guest-group">
            <legend>
              {g.name}
              {g.required ? '' : ' (по желанию)'}
            </legend>
            <div className="guest-chips">
              {g.choices.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="chip"
                  aria-pressed={line.choices.includes(c.id)}
                  onClick={() => onChange({ ...line, choices: toggleChoice(line.product.options, line.choices, g.id, c.id) })}
                >
                  {c.name}
                  {c.priceDelta ? ` +${money(c.priceDelta)}` : ''}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
        <button type="button" className="btn btn-primary guest-submit" onClick={onAdd}>
          Добавить · {money(unit)}
        </button>
      </div>
    </div>
  );
}
