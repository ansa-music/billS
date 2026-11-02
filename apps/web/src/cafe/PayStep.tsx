import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Dispatch, MouseEvent, RefObject, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import type { CounterService, CreateCounterOrderResponse, Minor, PaymentMethod } from '@bills/domain';
import { COUNTER_SERVICE_LABEL, formatMoney, GUEST_NAME_MAX } from '@bills/domain';
import { METHOD_LABEL } from '../cash/format.ts';
import { Icon } from '../icons.tsx';
import type { Flash } from './pos-model.ts';
import { typeDigit } from './pos-model.ts';
import './pay-step.css';

/** One line of the order as the payment step lists it. */
export interface PayLine {
  id: string;
  name: string;
  /** «L · овсяное», or why the line cannot be sold. */
  detail: string;
  comment: string;
  qty: number;
  sum: Minor | null;
}

export type PayOpts = { tendered?: Minor; rest?: 'CARD' | 'QR' };

/** Phones and low windows: one scrolling column, the keypad waits behind «Другая сумма». */
export const PAY_COMPACT = '(max-width: 599px), (max-height: 599px)';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'] as const;

/** Text fields keep their keys; a checkbox does not (digits still type the cash). */
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  ((el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type)) ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable);

interface PayStepProps {
  currency: string;
  lines: PayLine[];
  count: number;
  /** The order before a loyalty reward. */
  total: Minor;
  /** What the guest pays in money. */
  due: Minor;
  /** Loyalty: the reward on offer for the picked guest, and whether it is applied. */
  offer: { ask: string; done: string; amount: Minor } | null;
  rewardOn: boolean;
  onReward: () => void;
  /** «Аня · 4 из 6» — the guest picked by phone. */
  guestCard: string | null;
  service: CounterService;
  onService: (s: CounterService) => void;
  guestName: string;
  onGuestName: (v: string) => void;
  /** Cash the guest hands over, as typed (major units) and as money. */
  tendered: string;
  typed: Minor | null;
  onTendered: Dispatch<SetStateAction<string>>;
  quick: Minor[];
  canPay: boolean;
  canSend: boolean;
  online: boolean;
  compact: boolean;
  autoPrint: boolean;
  onAutoPrint: (on: boolean) => void;
  onPay: (method: PaymentMethod | null, opts?: PayOpts) => void;
  onBack: () => void;
  /** Set right after a payment from this step: the screen becomes «Заказ 17 · Сдача 450 ₸». */
  flash: Flash | null;
  doneMs: number;
  onDone: () => void;
  /** After a refusal, when the order is back in the cart: pay it again right here. */
  onRetry: (() => void) | null;
  onPrint: (res: CreateCounterOrderResponse) => void;
}

/**
 * «Оплатить» → the whole screen: the sum huge, the order with «Здесь / С собой» and the guest's
 * name, three big ways to pay, round sums and a keypad for the cash the guest hands over with the
 * change in large type. A native modal <dialog>: it covers the menu, the order column and the
 * app's bars, the focus stays inside, Esc goes back to the order (nothing is lost). The keys work
 * as at the counter: Enter — cash without change (or the typed sum), F2 card, F3 QR, digits and
 * Backspace type the cash. After the money the same screen shows the order number and the change
 * for a moment, then the counter is empty for the next guest. The money itself is `onPay` — the
 * counter's one payment function, the same requests as the one-tap buttons.
 */
export function PayStep(p: PayStepProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const cashRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const [keypad, setKeypad] = useState(() => !p.compact || p.tendered !== '');
  const showPad = !p.compact || keypad;
  const view = p.flash ? 'done' : 'form';
  const { typed, due } = p;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    live.current = true;
    if (!dialog.open) dialog.showModal();
    // The panel, not the first button: Enter stays «наличные без сдачи», not «Назад».
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      live.current = false;
      if (dialog.open) dialog.close();
    };
  }, []);

  // The form turned into the confirmation (or back): the pressed button is gone, keep the keys here.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [view]);

  // A sum typed on a keyboard opens the phone's keypad too.
  useEffect(() => {
    if (p.tendered !== '') setKeypad(true);
  }, [p.tendered]);

  const enter = () => {
    if (!p.canPay) return;
    if (typed !== null && typed >= due) p.onPay('CASH', { tendered: typed });
    else if (typed === null) p.onPay('CASH');
  };

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    // Esc arrives as the dialog's `cancel` (below).
    if (e.key === 'Escape' || e.defaultPrevented) return;
    const onButton = e.target instanceof HTMLButtonElement;
    if (p.flash) {
      if (e.key === 'F2' || e.key === 'F3') e.preventDefault();
      else if ((e.key === 'Enter' || e.key === ' ') && !onButton) {
        e.preventDefault();
        p.onDone();
      }
      return;
    }
    if (e.key === 'F2' || e.key === 'F3') {
      e.preventDefault();
      if (p.canPay) p.onPay(e.key === 'F2' ? 'CARD' : 'QR');
      return;
    }
    if (isTyping(e.target)) {
      if (e.key === 'Enter') {
        e.preventDefault();
        panelRef.current?.focus({ preventScroll: true });
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      const key = e.key;
      p.onTendered((t) => typeDigit(t, key));
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      p.onTendered((t) => t.slice(0, -1));
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      p.onTendered('');
      return;
    }
    if (e.key === 'Enter' && !onButton) {
      e.preventDefault();
      enter();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  const escape = () => {
    if (p.flash) {
      p.onDone();
      return;
    }
    if (isTyping(document.activeElement)) {
      panelRef.current?.focus({ preventScroll: true });
      return;
    }
    p.onBack();
  };

  const openPad = () => {
    setKeypad(true);
    requestAnimationFrame(() => cashRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };

  return createPortal(
    <dialog
      ref={ref}
      className="pay-step"
      aria-label="Оплата"
      onCancel={(e) => {
        e.preventDefault();
        escape();
      }}
      onClose={() => {
        // Esc twice without a tap in between: the browser closes the dialog itself.
        if (!live.current || ref.current?.open) return;
        if (p.flash) p.onDone();
        else p.onBack();
      }}
    >
      <div className="pay-step-panel" ref={panelRef} tabIndex={-1} data-view={view}>
        {p.flash ? (
          <PayDone flash={p.flash} currency={p.currency} ms={p.doneMs} onDone={p.onDone} onRetry={p.onRetry} onPrint={p.onPrint} />
        ) : (
          <PayForm {...p} showPad={showPad} cashRef={cashRef} onOpenPad={openPad} />
        )}
      </div>
    </dialog>,
    document.body,
  );
}

function PayForm(
  p: PayStepProps & { showPad: boolean; cashRef: RefObject<HTMLDivElement | null>; onOpenPad: () => void },
) {
  const money = (a: Minor) => formatMoney(a, p.currency);
  const { typed, due } = p;
  const short = typed !== null && typed > 0 && typed < due ? due - typed : 0;
  const change = typed !== null && typed >= due ? typed - due : null;
  const press = (k: (typeof KEYS)[number]) => {
    if (k === '⌫') p.onTendered((t) => t.slice(0, -1));
    else p.onTendered((t) => typeDigit(t, k));
  };

  // A real button, not a footnote: the order goes to the barista now, the money later in «Счета».
  const later = (
    <button type="button" className="pay-step-later" disabled={!p.canSend} onClick={() => p.onPay(null)}>
      <span>Без оплаты — счёт потом</span>
      <small>заказ уйдёт бариста, счёт будет в «Счетах»</small>
    </button>
  );
  const print = (
    <label className="pay-step-print">
      <input type="checkbox" checked={p.autoPrint} onChange={(e) => p.onAutoPrint(e.target.checked)} />
      Печатать чек сам
    </label>
  );

  return (
    <>
      <header className="pay-step-head">
        <button type="button" className="pay-step-back" onClick={p.onBack}>
          <Icon name="back" size={24} />
          <span>Назад к заказу</span>
          <kbd className="pay-step-kbd">Esc</kbd>
        </button>
        {!p.compact && later}
      </header>

      <div className="pay-step-body">
        <section className="pay-step-order" aria-label="Заказ">
          <div className="pay-step-sum">
            <div className="pay-step-due">
              <span>К оплате</span>
              <strong>{money(due)}</strong>
            </div>
            {(p.offer || p.guestCard) && (
              <div className="pay-step-loyalty">
                {p.guestCard && (
                  <p className="pay-step-guest">
                    <Icon name="user" size={18} />
                    <span>{p.guestCard}</span>
                  </p>
                )}
                {p.offer && (
                  <button type="button" className="pay-step-offer" aria-pressed={p.rewardOn} onClick={p.onReward}>
                    <span>{p.rewardOn ? `✓ ${p.offer.done}` : p.offer.ask}</span>
                    <small>{p.rewardOn ? `−${money(p.offer.amount)} · отменить` : `−${money(p.offer.amount)}`}</small>
                  </button>
                )}
              </div>
            )}
            <div className="pay-step-meta">
              <div className="pay-step-seg" role="radiogroup" aria-label="Где пьёт гость">
                {(['HERE', 'TAKEAWAY'] as const).map((s) => (
                  <button key={s} type="button" role="radio" aria-checked={p.service === s} onClick={() => p.onService(s)}>
                    {COUNTER_SERVICE_LABEL[s]}
                  </button>
                ))}
              </div>
              <input
                className="pay-step-name"
                value={p.guestName}
                maxLength={GUEST_NAME_MAX}
                autoComplete="off"
                autoCapitalize="words"
                enterKeyHint="done"
                placeholder="Имя гостя"
                aria-label="Имя гостя (на экране заказов)"
                onChange={(e) => p.onGuestName(e.target.value)}
              />
            </div>
          </div>
          <div className="pay-step-list">
            <p className="pay-step-list-head">
              <span>
                Заказ · {p.count} шт.
              </span>
              {p.rewardOn && p.total !== due && <span>без скидки {money(p.total)}</span>}
            </p>
            <ul className="pay-step-lines">
              {p.lines.map((l) => (
                <li key={l.id}>
                  <span className="pay-step-qty">{l.qty}×</span>
                  <span className="pay-step-line-name">
                    {l.name}
                    {l.detail && <small>{l.detail}</small>}
                    {l.comment && <em>«{l.comment}»</em>}
                  </span>
                  <span className="pay-step-line-sum">{l.sum === null ? '—' : money(l.sum)}</span>
                </li>
              ))}
            </ul>
            {!p.compact && print}
          </div>
        </section>

        <section className="pay-step-money" aria-label="Способ оплаты">
          {!p.online && (
            <p className="pay-step-offline" role="status">
              Нет связи с TS — принять оплату можно, когда связь вернётся. Заказ не потеряется.
            </p>
          )}
          {/* The three ways to pay, huge: one tap each, read from a step away. */}
          <div className="pay-step-methods" role="group" aria-label="Способ оплаты">
            <button type="button" className="pay-step-method" data-method="CASH" disabled={!p.canPay} onClick={() => p.onPay('CASH')}>
              <span className="pay-step-method-name">{METHOD_LABEL.CASH}</span>
              <small>без сдачи</small>
              <kbd className="pay-step-kbd">Enter</kbd>
            </button>
            <button type="button" className="pay-step-method" data-method="CARD" disabled={!p.canPay} onClick={() => p.onPay('CARD')}>
              <span className="pay-step-method-name">{METHOD_LABEL.CARD}</span>
              <kbd className="pay-step-kbd">F2</kbd>
            </button>
            <button type="button" className="pay-step-method" data-method="QR" disabled={!p.canPay} onClick={() => p.onPay('QR')}>
              <span className="pay-step-method-name">{METHOD_LABEL.QR}</span>
              <kbd className="pay-step-kbd">F3</kbd>
            </button>
          </div>

          <div className="pay-step-cash" ref={p.cashRef} role="group" aria-label="Наличные со сдачей">
            <p className="pay-step-cash-title">Наличные со сдачей — гость даёт</p>
            {p.quick.length > 0 && (
              <div className="pay-step-quick" role="group" aria-label="Гость даёт">
                {p.quick.map((q) => (
                  <button key={q} type="button" className="pay-step-quick-btn" disabled={!p.canPay} onClick={() => p.onPay('CASH', { tendered: q })}>
                    <strong>{money(q)}</strong>
                    <small>сдача {money(q - due)}</small>
                  </button>
                ))}
              </div>
            )}
            {p.showPad ? (
              <>
                <div className="pay-step-display" aria-live="polite">
                  <div className="pay-step-given">
                    <span>Гость даёт</span>
                    <strong data-empty={p.tendered === '' || undefined}>{typed !== null ? money(typed) : money(0)}</strong>
                  </div>
                  <div className="pay-step-change" data-short={short > 0 || undefined} data-none={(change === null && short === 0) || undefined}>
                    <span>{short > 0 ? 'Не хватает' : 'Сдача'}</span>
                    <strong>{change !== null ? money(change) : short > 0 ? money(short) : '—'}</strong>
                  </div>
                  {/* Kept in place while empty (just not shown): the sums do not shift when typing starts. */}
                  <button
                    type="button"
                    className="pay-step-clear"
                    aria-label="Стереть сумму"
                    data-off={p.tendered === '' || undefined}
                    onClick={() => p.onTendered('')}
                  >
                    <Icon name="close" size={24} />
                  </button>
                </div>
                <div className="pay-step-keypad" role="group" aria-label="Цифры">
                  {KEYS.map((k) => (
                    <button key={k} type="button" aria-label={k === '⌫' ? 'Стереть цифру' : k} onClick={() => press(k)}>
                      {k}
                    </button>
                  ))}
                </div>
                <div className="pay-step-accept">
                  {change !== null && typed !== null ? (
                    <button type="button" className="pay-step-accept-btn" disabled={!p.canPay} onClick={() => p.onPay('CASH', { tendered: typed })}>
                      <span>Принять {money(typed)}</span>
                      <kbd className="pay-step-kbd">Enter</kbd>
                    </button>
                  ) : short > 0 && typed !== null ? (
                    <div className="pay-step-split" role="group" aria-label="Остаток другим способом">
                      <span>Остаток {money(short)}:</span>
                      <button type="button" data-method="CARD" disabled={!p.canPay} onClick={() => p.onPay('CASH', { tendered: typed, rest: 'CARD' })}>
                        картой
                      </button>
                      <button type="button" data-method="QR" disabled={!p.canPay} onClick={() => p.onPay('CASH', { tendered: typed, rest: 'QR' })}>
                        QR
                      </button>
                    </div>
                  ) : (
                    <p className="pay-step-hint">Наберите, сколько дал гость, — сдача посчитается сама</p>
                  )}
                </div>
              </>
            ) : (
              <button type="button" className="pay-step-other" disabled={!p.canPay} onClick={p.onOpenPad}>
                Другая сумма
              </button>
            )}
          </div>
        </section>

        {p.compact && later}
        {p.compact && print}
      </div>
    </>
  );
}

/** «Заказ 17 · Сдача 450 ₸» over the whole screen; a tap (or Enter, Esc) is «следующий гость». */
function PayDone({
  flash,
  currency,
  ms,
  onDone,
  onRetry,
  onPrint,
}: {
  flash: Flash;
  currency: string;
  ms: number;
  onDone: () => void;
  onRetry: (() => void) | null;
  onPrint: (res: CreateCounterOrderResponse) => void;
}) {
  const money = (a: Minor) => formatMoney(a, currency);

  if (flash.state === 'failed') {
    return (
      <div className="pay-step-done" data-state="failed" role="alert">
        <p className="pay-step-done-title">Заказ не прошёл</p>
        <p className="pay-step-done-error">{flash.error}</p>
        <p className="pay-step-done-sub">Ничего не потерялось: заказ снова в корзине.</p>
        <div className="pay-step-done-actions">
          <button type="button" className="pay-step-btn" onClick={onDone}>
            Назад к заказу
          </button>
          {onRetry && (
            <button type="button" className="pay-step-btn pay-step-btn-primary" onClick={onRetry}>
              Оплатить ещё раз
            </button>
          )}
        </div>
      </div>
    );
  }

  const number = flash.res?.order.number;
  const ok = flash.state === 'ok';
  const cashOnly = flash.method === 'CASH' && !flash.rest;
  const stop = (e: MouseEvent) => e.stopPropagation();
  return (
    <div className="pay-step-done" data-state={flash.state} role="status" aria-live="assertive" onClick={onDone}>
      <div className="pay-step-done-main">
        <div className="pay-step-done-num">
          <span>Заказ</span>
          <strong data-pending={number === undefined || undefined}>{number ?? '···'}</strong>
          <p className="pay-step-done-sent" data-ok={ok || undefined}>
            {ok ? (
              <>
                <Icon name="check" size={22} /> отправлен бариста
              </>
            ) : (
              'отправляем бариста…'
            )}
          </p>
        </div>
        {cashOnly && flash.change > 0 ? (
          <div className="pay-step-done-money" data-kind="change">
            <span>Сдача</span>
            <strong>{money(flash.change)}</strong>
          </div>
        ) : (
          <div className="pay-step-done-money" data-kind={flash.rest ? 'split' : flash.method ? 'paid' : 'later'}>
            <span>{cashOnly ? METHOD_LABEL.CASH : flash.method ? 'Оплачено' : 'Без оплаты'}</span>
            <strong>
              {cashOnly
                ? 'Без сдачи'
                : flash.rest
                  ? `${METHOD_LABEL.CASH} + ${METHOD_LABEL[flash.rest.method]}`
                  : flash.method
                    ? METHOD_LABEL[flash.method]
                    : 'Счёт потом'}
            </strong>
            {flash.rest && (
              <small>
                {money(flash.total - flash.rest.amount)} + {money(flash.rest.amount)}
              </small>
            )}
            {!flash.method && <small>оплатят на кассе, счёт в «Счетах»</small>}
          </div>
        )}
      </div>
      <p className="pay-step-done-sub">
        {COUNTER_SERVICE_LABEL[flash.service]}
        {flash.guestName ? ` · ${flash.guestName}` : ''} · {money(flash.total)}
      </p>
      {flash.loyaltyNote && <p className="pay-step-done-note">{flash.loyaltyNote}</p>}
      <div className="pay-step-done-actions">
        <button
          type="button"
          className="pay-step-btn"
          disabled={!flash.res}
          onClick={(e) => {
            stop(e);
            if (flash.res) onPrint(flash.res);
          }}
        >
          Печать чека
        </button>
        <button type="button" className="pay-step-btn pay-step-btn-primary" onClick={onDone}>
          Следующий гость
        </button>
      </div>
      {ok && <span className="pay-step-done-timer" style={{ animationDuration: `${ms}ms` }} />}
    </div>
  );
}
