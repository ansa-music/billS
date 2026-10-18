import './prepaid.css';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  Minor,
  OpenPrepaidRequest,
  OpenPrepaidResponse,
  PaymentMethod,
  PaymentPart,
  PaymentPlan,
} from '@bills/domain';
import {
  assertPrepaidMinutes,
  formatMoney,
  nextPriceChange,
  parseMoney,
  PAYMENT_METHODS,
  planPayment,
  PREPAID_MAX_MINUTES,
  PREPAID_MIN_MINUTES,
  PREPAID_QUOTE_TTL_MS,
  prepaidPrice,
  priceAt,
} from '@bills/domain';
import type { DeskProps } from '../cash/desk.ts';
import { toActionError, useAction, useDesk } from '../cash/desk.ts';
import { METHOD_LABEL, toMoneyInput } from '../cash/format.ts';
import { FormError, Modal } from '../cash/Modal.tsx';
import { formatClock } from '../format.ts';
import { tablePhase } from '../hall.ts';
import { formatPrepaidMinutes, NO_SHIFT_HINT, PRESET_MINUTES } from './prepaid.ts';

type Amounts = Record<PaymentMethod, string>;
const NO_AMOUNTS: Amounts = { CASH: '', CARD: '', QR: '' };

const ALL_BY: Record<PaymentMethod, string> = {
  CASH: 'Всё наличными',
  CARD: 'Всё картой',
  QR: 'Всё QR',
};

/** With «Без лимита» on the card the dialog starts from an hour. */
const DEFAULT_MINUTES = 60;
/** Keep a quote a little shorter than the HUB honours it (PREPAID_QUOTE_TTL_MS), for the round trip. */
const QUOTE_FRESH_MS = PREPAID_QUOTE_TTL_MS - 10_000;

export interface PrepaidTarget {
  tableId: string;
  /** The tariff picked on the card. */
  tariffId: string;
  /** The time picked on the card; null is «Без лимита». */
  minutes: number | null;
}

interface Props extends DeskProps {
  target: PrepaidTarget;
  /** HUB clock (the hall's offset-corrected now): the HUB checks the price at its own now. */
  serverNow: number;
  onClose: () => void;
}

function parseMinutes(text: string): { minutes: number | null; problem: string | null } {
  const clean = text.trim();
  if (!clean) return { minutes: null, problem: 'Укажите время в минутах' };
  const n = /^\d{1,4}$/.test(clean) ? Number(clean) : NaN;
  try {
    assertPrepaidMinutes(n);
    return { minutes: n, problem: null };
  } catch (e) {
    return { minutes: null, problem: toActionError(e).message };
  }
}

interface Preview {
  parts: PaymentPart[];
  plan: PaymentPlan | null;
  /** Why the payment cannot be taken as typed. Null with no plan: nothing typed yet. */
  problem: string | null;
}

/** What the guest hands over → what is applied and the change. Same rules as the HUB (planPayment). */
function previewPayment(price: Minor, amounts: Amounts, currency: string): Preview {
  const parts: PaymentPart[] = [];
  for (const method of PAYMENT_METHODS) {
    const text = amounts[method].trim();
    if (!text) continue;
    const amount = parseMoney(text, currency);
    if (amount === null) return { parts, plan: null, problem: `Проверьте сумму: ${METHOD_LABEL[method]}` };
    if (amount > 0) parts.push({ method, amount });
  }
  if (price > 0 && parts.length === 0) return { parts, plan: null, problem: null };
  try {
    return { parts, plan: planPayment(price, parts), problem: null };
  } catch (e) {
    return { parts, plan: null, problem: toActionError(e).message };
  }
}

/**
 * Open a free table for N minutes and take the whole payment at once. The price is
 * prepaidPrice at the HUB's now; the HUB recomputes it and refuses (PREPAID_PRICE_CHANGED)
 * if it no longer matches — then the new price is shown and the cashier sends again.
 */
export function PrepaidDialog({ target, serverNow, onClose, ...deskProps }: Props) {
  const desk = useDesk(deskProps);
  const { state } = desk;
  const { currency, timezone } = state.club;
  const money = (a: Minor) => formatMoney(a, currency);

  const [tariffId, setTariffId] = useState(target.tariffId);
  const [minutesText, setMinutesText] = useState(String(target.minutes ?? DEFAULT_MINUTES));
  const [amounts, setAmounts] = useState<Amounts>(NO_AMOUNTS);
  /** The price the typed amounts were meant for: if the live price moves away, the cashier is told. */
  const [basis, setBasis] = useState<{ price: Minor; at: number } | null>(null);
  const [done, setDone] = useState<{ res: OpenPrepaidResponse; minutes: number } | null>(null);
  const action = useAction();
  const formId = useId();
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const table = state.tables.find((t) => t.id === target.tableId);
  const tableName = table?.name ?? 'Стол';
  const title = `Предоплата · ${tableName}`;

  if (done) {
    const { res } = done;
    return (
      <Modal
        title={title}
        onClose={onClose}
        footer={
          <button ref={doneRef} type="button" className="btn btn-primary" onClick={onClose}>
            Готово
          </button>
        }
      >
        <div className="pay-done" role="status">
          <p className="pay-done-title">
            {tableName} · на {formatPrepaidMinutes(done.minutes)}
          </p>
          <p className="hint">
            Оплачено {money(res.applied)} · счёт №{res.check.number}
          </p>
          <p className="pay-change" data-zero={res.change === 0 || undefined}>
            Сдача: {money(res.change)}
          </p>
          <p className="hint">Время пойдёт, когда лампа подтвердит включение</p>
        </div>
      </Modal>
    );
  }

  const tariff =
    state.tariffs.find((t) => t.id === tariffId) ?? state.tariffs.find((t) => t.id === table?.defaultTariffId);
  const { minutes, problem: minutesProblem } = parseMinutes(minutesText);

  let livePrice: Minor | null = null;
  let priceProblem: string | null = tariff ? null : 'Тариф не найден';
  if (tariff && minutes != null) {
    try {
      livePrice = prepaidPrice(serverNow, minutes, tariff.config, timezone);
    } catch (e) {
      priceProblem = toActionError(e).message;
    }
  }
  const rate = tariff ? priceAt(serverNow, tariff.config, timezone) : null;
  const next = tariff && minutes != null ? nextPriceChange(serverNow, tariff.config, timezone, minutes * 60_000) : null;

  const hubChanged = action.error?.code === 'PREPAID_PRICE_CHANGED';
  // The HUB honours a price quoted less than a minute ago: while the typed amounts are fresh,
  // their price stands even if the live price ticks (a game across a rate change).
  const quote = !hubChanged && basis != null && serverNow - basis.at < QUOTE_FRESH_MS ? basis : null;
  const price = quote?.price ?? livePrice;
  const priceMoved = basis != null && quote == null && livePrice != null && livePrice !== basis.price;

  const free = table != null && tablePhase(table) === 'free';
  const noShift = state.shift === null;
  const preview = price == null ? null : previewPayment(price, amounts, currency);
  const plan = preview?.plan ?? null;
  const paidInFull = plan != null && plan.remaining === 0;
  const canSubmit = free && !noShift && price != null && paidInFull && !action.pending;

  // A different time or tariff is a new quote: the old price and its errors no longer apply.
  const pickMinutes = (text: string) => {
    setMinutesText(text);
    setBasis(null);
    action.setError(null);
  };
  const pickTariff = (id: string) => {
    setTariffId(id);
    setBasis(null);
    action.setError(null);
  };
  const typeAmount = (method: PaymentMethod, value: string) => {
    setAmounts((a) => ({ ...a, [method]: value }));
    if (basis == null && price != null) setBasis({ price, at: serverNow });
  };
  const fillAll = (method: PaymentMethod) => {
    if (price == null) return;
    setAmounts({ ...NO_AMOUNTS, [method]: toMoneyInput(price, currency) });
    setBasis(quote ?? { price, at: serverNow });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || price == null || minutes == null || !tariff || !preview) return;
    const sent = quote ?? { price, at: serverNow };
    const body: OpenPrepaidRequest = {
      tariffId: tariff.id,
      minutes,
      amount: sent.price,
      quotedAt: sent.at,
      parts: preview.parts,
    };
    // The amounts are now confirmed for this price; if the HUB disagrees, the gap is shown.
    setBasis(sent);
    void action.run(async () => {
      const res = await desk.send<OpenPrepaidResponse>(`/api/tables/${target.tableId}/open-prepaid`, body);
      setDone({ res, minutes });
    });
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      className="modal-prepaid"
      footer={
        <>
          <div className="pay-preview" aria-live="polite">
            {preview?.problem ? (
              <p className="form-error">{preview.problem}</p>
            ) : plan ? (
              plan.remaining > 0 ? (
                <p className="pay-remaining">Не хватает {money(plan.remaining)} — предоплата только полной суммой</p>
              ) : plan.change > 0 ? (
                <p className="pay-change">Сдача: {money(plan.change)}</p>
              ) : (
                <p className="hint">Без сдачи</p>
              )
            ) : price != null ? (
              <p className="hint">Введите сумму или нажмите «Всё наличными»</p>
            ) : null}
          </div>
          {(hubChanged || priceMoved) && price != null && (
            <div className="prepaid-changed" role="alert">
              {hubChanged && <p>{action.error?.message}</p>}
              <p>
                Новая цена: <strong className="money">{money(price)}</strong>
                {priceMoved && basis != null && <span className="money"> (было {money(basis.price)})</span>}
                {hubChanged ? ' — проверьте оплату и нажмите ещё раз' : ' — проверьте оплату'}
              </p>
            </div>
          )}
          {!free && <p className="hint hint-warn">Стол уже занят — открыть его с предоплатой нельзя</p>}
          {noShift && <p className="hint hint-warn">{NO_SHIFT_HINT}</p>}
          {!hubChanged && <FormError error={action.error?.message} />}
          <button type="submit" form={formId} className="btn btn-primary" disabled={!canSubmit}>
            {action.pending
              ? 'Открываем…'
              : price != null
                ? `Открыть и оплатить · ${money(price)}`
                : 'Открыть и оплатить'}
          </button>
        </>
      }
    >
      {state.tariffs.length > 1 && (
        <section className="prepaid-section">
          <h3 className="cash-sub" id={`${formId}-tariff`}>
            Тариф
          </h3>
          <div className="chips" role="group" aria-labelledby={`${formId}-tariff`}>
            {state.tariffs.map((t) => (
              <button
                key={t.id}
                type="button"
                className="chip"
                aria-pressed={t.id === tariff?.id}
                onClick={() => pickTariff(t.id)}
              >
                {t.name}
                {t.id === table?.defaultTariffId && <span className="chip-note"> · обычный</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="prepaid-section">
        <h3 className="cash-sub" id={`${formId}-time`}>
          Время
        </h3>
        <div className="chips" role="group" aria-labelledby={`${formId}-time`}>
          {PRESET_MINUTES.map((m) => (
            <button
              key={m}
              type="button"
              className="chip"
              aria-pressed={minutes === m}
              onClick={() => pickMinutes(String(m))}
            >
              {formatPrepaidMinutes(m)}
            </button>
          ))}
        </div>
        <label className="field prepaid-minutes">
          <span>
            Или минут ({PREPAID_MIN_MINUTES}–{PREPAID_MAX_MINUTES})
          </span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={minutesText}
            aria-invalid={minutesProblem != null || undefined}
            onChange={(e) => pickMinutes(e.target.value)}
          />
        </label>
        <FormError error={minutesProblem} />
      </section>

      <section className="prepaid-quote" aria-labelledby={`${formId}-price`}>
        <h3 className="cash-sub" id={`${formId}-price`}>
          {minutes != null ? `К оплате за ${formatPrepaidMinutes(minutes)}` : 'К оплате'}
        </h3>
        <p className="prepaid-price money" aria-live="polite">
          {price != null ? money(price) : '—'}
        </p>
        {priceProblem && <FormError error={priceProblem} />}
        {tariff && rate && (
          <p className="hint">
            {tariff.name} · {rate.label} {money(rate.pricePerHour)}/ч
          </p>
        )}
        {next && (
          <p className="price-next">
            с {formatClock(next.at, timezone)} — {next.label} {money(next.pricePerHour)}/ч, цена может измениться
          </p>
        )}
        {minutes != null && (
          <p className="hint">
            ≈ до {formatClock(serverNow + minutes * 60_000, timezone)} · время пойдёт, когда загорится свет
          </p>
        )}
      </section>

      <form id={formId} className="pay-form" onSubmit={submit}>
        <h3 className="cash-sub" id={`${formId}-pay`}>
          Оплата
        </h3>
        <div className="pay-parts" role="group" aria-labelledby={`${formId}-pay`}>
          {PAYMENT_METHODS.map((m, i) => (
            <label key={m} className="pay-part">
              <span>{METHOD_LABEL[m]}</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0"
                value={amounts[m]}
                onChange={(e) => typeAmount(m, e.target.value)}
                data-autofocus={i === 0 ? '' : undefined}
              />
            </label>
          ))}
        </div>
        <div className="row wrap pay-quick">
          {PAYMENT_METHODS.map((m) => (
            <button key={m} type="button" className="btn btn-small" disabled={price == null} onClick={() => fillAll(m)}>
              {ALL_BY[m]}
            </button>
          ))}
        </div>
      </form>
    </Modal>
  );
}
