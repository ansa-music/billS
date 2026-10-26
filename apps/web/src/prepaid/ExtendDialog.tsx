import './prepaid.css';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ExtendGuestRequestBody,
  ExtendPrepaidRequest,
  ExtendPrepaidResponse,
  Minor,
  PaymentMethod,
  PaymentPart,
  PaymentPlan,
  SessionView,
} from '@bills/domain';
import {
  assertPrepaidExtension,
  formatMoney,
  parseMoney,
  PAYMENT_METHODS,
  planPayment,
  PREPAID_EXTEND_MINUTES,
  prepaidExtensionPrice,
} from '@bills/domain';
import { command } from '../api.ts';
import { toActionError, useAction } from '../cash/desk.ts';
import { METHOD_LABEL, toMoneyInput } from '../cash/format.ts';
import { FormError, Modal } from '../cash/Modal.tsx';
import { formatClock } from '../format.ts';
import { useHub } from '../useHub.tsx';
import { formatPrepaidMinutes, NO_SHIFT_HINT } from './prepaid.ts';

type Amounts = Record<PaymentMethod, string>;
const NO_AMOUNTS: Amounts = { CASH: '', CARD: '', QR: '' };
const ALL_BY: Record<PaymentMethod, string> = { CASH: 'Всё наличными', CARD: 'Всё картой', QR: 'Всё QR' };

export interface ExtendTarget {
  sessionId: string;
  /** Preselected minutes (the guest's request, or 30). */
  minutes?: number;
  /** Accepting a guest's «Продлить»: the request is resolved together with the extension. */
  requestId?: string;
  /** «Стол 1» for the title and the notice. */
  tableName: string;
}

/** The live game of the target, wherever it is on the hall. */
function findSession(tables: ReadonlyArray<{ session: SessionView | null }>, id: string): SessionView | null {
  return tables.find((t) => t.session?.id === id)?.session ?? null;
}

function previewPayment(price: Minor, amounts: Amounts, currency: string) {
  const parts: PaymentPart[] = [];
  for (const method of PAYMENT_METHODS) {
    const text = amounts[method].trim();
    if (!text) continue;
    const amount = parseMoney(text, currency);
    if (amount === null) return { parts, plan: null as PaymentPlan | null, problem: `Проверьте сумму: ${METHOD_LABEL[method]}` };
    if (amount > 0) parts.push({ method, amount });
  }
  if (parts.length === 0) return { parts, plan: null as PaymentPlan | null, problem: null };
  try {
    return { parts, plan: planPayment(price, parts), problem: null };
  } catch (e) {
    return { parts, plan: null as PaymentPlan | null, problem: toActionError(e).message };
  }
}

/**
 * «Продлить предоплаченную игру»: N more minutes for a game opened for a fixed time. The
 * price is what the HUB will charge (prepaidExtensionPrice: the game's tariff after the
 * current deadline). A game paid upfront is paid now (needs an open shift) or later — the
 * line «Продление» waits on a check for the cashier; a game paid after the stop just plays
 * longer and is billed by played time.
 */
export function ExtendDialog({ target, onClose }: { target: ExtendTarget; onClose: () => void }) {
  const hub = useHub();
  const { state, serverNow } = hub;
  const { currency, timezone } = state.club;
  const money = (a: Minor) => formatMoney(a, currency);
  const formId = useId();
  const action = useAction();
  const doneRef = useRef<HTMLButtonElement>(null);

  const [minutesText, setMinutesText] = useState(String(target.minutes ?? PREPAID_EXTEND_MINUTES[0]));
  const [amounts, setAmounts] = useState<Amounts>(NO_AMOUNTS);
  const noShift = state.shift === null;
  const [payNow, setPayNow] = useState(!noShift);
  const [done, setDone] = useState<ExtendPrepaidResponse | null>(null);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const session = findSession(state.tables, target.sessionId);
  const prepaid = session?.prepaid ?? null;
  const title = `Продлить · ${target.tableName}`;

  if (done) {
    const until = done.session.prepaid?.until;
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
            Продлено на {formatPrepaidMinutes(done.minutes)}
            {until != null ? ` · до ${formatClock(until, timezone)}` : ''}
          </p>
          {done.check == null ? (
            <p className="hint">Оплата после игры: продление войдёт в её счёт</p>
          ) : done.check.status === 'PAID' ? (
            <>
              <p className="hint">
                Оплачено {money(done.applied)} · счёт №{done.check.number}
              </p>
              <p className="pay-change" data-zero={done.change === 0 || undefined}>
                Сдача: {money(done.change)}
              </p>
            </>
          ) : (
            <p className="hint">
              {money(done.price)} — в счёте №{done.check.number}, примите оплату на кассе
            </p>
          )}
        </div>
      </Modal>
    );
  }

  if (!session || !prepaid) {
    return (
      <Modal
        title={title}
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Понятно
          </button>
        }
      >
        <p className="hint">
          {session ? 'Игра без лимита времени — продлевать нечего, она идёт, пока её не остановят.' : 'Игра уже закончилась.'}
        </p>
      </Modal>
    );
  }

  const paidUpfront = prepaid.checkId !== null;
  const clean = minutesText.trim();
  const minutes = /^\d{1,4}$/.test(clean) ? Number(clean) : null;
  let minutesProblem: string | null = minutes === null ? 'Укажите минуты' : null;
  if (minutes !== null) {
    try {
      assertPrepaidExtension(minutes, prepaid.minutes);
    } catch (e) {
      minutesProblem = toActionError(e).message;
    }
  }
  const started = prepaid.until != null;
  const price = started && minutes !== null && minutesProblem === null
    ? prepaidExtensionPrice(prepaid.until!, prepaid.minutes, minutes, session.tariff, session.timezone)
    : null;
  const newUntil = started && minutes !== null ? prepaid.until! + minutes * 60_000 : null;
  const paying = paidUpfront && payNow;
  const preview = paying && price !== null ? previewPayment(price, amounts, currency) : null;
  const plan = preview?.plan ?? null;
  const canSubmit =
    started &&
    price !== null &&
    !action.pending &&
    hub.online &&
    (!paying || (!noShift && plan !== null && plan.remaining === 0));

  const pick = (text: string) => {
    setMinutesText(text);
    setAmounts(NO_AMOUNTS);
    action.setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit || price === null || minutes === null) return;
    const payBody = paying && preview ? { amount: price, parts: preview.parts } : { amount: price };
    void action.run(async () => {
      try {
        const res = target.requestId
          ? (
              await command<{ extension: ExtendPrepaidResponse }>(
                `/api/guest-requests/${target.requestId}/extend`,
                hub.actor,
                payBody satisfies ExtendGuestRequestBody,
              )
            ).extension
          : await command<ExtendPrepaidResponse>(`/api/sessions/${target.sessionId}/extend`, hub.actor, {
              minutes,
              ...payBody,
            } satisfies ExtendPrepaidRequest);
        setDone(res);
        hub.notify(`${target.tableName}: продлено на ${formatPrepaidMinutes(res.minutes)}`);
      } finally {
        void hub.refresh();
      }
    });
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      className="modal-prepaid"
      footer={
        <>
          {paying && (
            <div className="pay-preview" aria-live="polite">
              {preview?.problem ? (
                <p className="form-error">{preview.problem}</p>
              ) : plan ? (
                plan.remaining > 0 ? (
                  <p className="pay-remaining">Не хватает {money(plan.remaining)} — продление оплачивается полностью</p>
                ) : plan.change > 0 ? (
                  <p className="pay-change">Сдача: {money(plan.change)}</p>
                ) : (
                  <p className="hint">Без сдачи</p>
                )
              ) : price !== null ? (
                <p className="hint">Введите сумму или нажмите «Всё наличными»</p>
              ) : null}
            </div>
          )}
          {paying && noShift && <p className="hint hint-warn">{NO_SHIFT_HINT}</p>}
          {!started && <p className="hint hint-warn">Свет ещё не включился — продлить можно, когда игра начнётся</p>}
          <FormError error={action.error?.message} />
          <button type="submit" form={formId} className="btn btn-primary" disabled={!canSubmit}>
            {action.pending
              ? 'Продлеваем…'
              : price === null
                ? 'Продлить'
                : paying
                  ? `Продлить и оплатить · ${money(price)}`
                  : `Продлить · ${money(price)}`}
          </button>
        </>
      }
    >
      <section className="prepaid-section">
        <h3 className="cash-sub" id={`${formId}-time`}>
          На сколько
        </h3>
        <div className="chips" role="group" aria-labelledby={`${formId}-time`}>
          {PREPAID_EXTEND_MINUTES.map((m) => (
            <button key={m} type="button" className="chip" aria-pressed={minutes === m} onClick={() => pick(String(m))}>
              +{formatPrepaidMinutes(m)}
            </button>
          ))}
        </div>
        <label className="field prepaid-minutes">
          <span>Или минут</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            value={minutesText}
            aria-invalid={minutesProblem != null || undefined}
            onChange={(e) => pick(e.target.value)}
          />
        </label>
        <FormError error={minutesProblem} />
      </section>

      <section className="prepaid-quote" aria-labelledby={`${formId}-price`}>
        <h3 className="cash-sub" id={`${formId}-price`}>
          {minutes !== null ? `Стоимость ${formatPrepaidMinutes(minutes)}` : 'Стоимость'}
        </h3>
        <p className="prepaid-price money" aria-live="polite">
          {price !== null ? money(price) : '—'}
        </p>
        <p className="hint">
          Сейчас до {prepaid.until != null ? formatClock(prepaid.until, timezone) : '—'} · на {formatPrepaidMinutes(prepaid.minutes)}
          {newUntil != null && minutesProblem === null ? ` → до ${formatClock(newUntil, timezone)}` : ''}
          {session.pausedAt != null ? ' · на паузе, время пойдёт после неё' : ''}
        </p>
        <p className="hint">По тарифу «{session.tariffName}», по ценам после текущего конца игры</p>
      </section>

      {paidUpfront ? (
        <form id={formId} className="pay-form" onSubmit={submit}>
          <h3 className="cash-sub" id={`${formId}-pay`}>
            Оплата
          </h3>
          <div className="chips" role="group" aria-labelledby={`${formId}-pay`}>
            <button type="button" className="chip" aria-pressed={payNow} onClick={() => setPayNow(true)}>
              Оплатить сейчас
            </button>
            <button type="button" className="chip" aria-pressed={!payNow} onClick={() => setPayNow(false)}>
              Оплатить позже, в счёт
            </button>
          </div>
          {payNow ? (
            <>
              <div className="pay-parts" role="group" aria-label="Сумма по способам оплаты">
                {PAYMENT_METHODS.map((m, i) => (
                  <label key={m} className="pay-part">
                    <span>{METHOD_LABEL[m]}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0"
                      value={amounts[m]}
                      onChange={(e) => setAmounts((a) => ({ ...a, [m]: e.target.value }))}
                      data-autofocus={i === 0 ? '' : undefined}
                    />
                  </label>
                ))}
              </div>
              <div className="row wrap pay-quick">
                {PAYMENT_METHODS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="btn btn-small"
                    disabled={price === null}
                    onClick={() => price !== null && setAmounts({ ...NO_AMOUNTS, [m]: toMoneyInput(price, currency) })}
                  >
                    {ALL_BY[m]}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="hint">Игра оплачена заранее: продление ляжет отдельной строкой «Продление» в счёт — его оплатят на кассе.</p>
          )}
        </form>
      ) : (
        <form id={formId} className="pay-form" onSubmit={submit}>
          <p className="hint">Игра оплачивается после остановки: продление войдёт в её счёт по времени игры.</p>
        </form>
      )}
    </Modal>
  );
}
