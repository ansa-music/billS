import { Fragment, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  AddCheckItemRequest,
  CheckView,
  DiscountKind,
  Minor,
  PaymentMethod,
  PaymentPart,
  PaymentPlan,
  PayRequest,
  PayResponse,
  SetDiscountRequest,
} from '@bills/domain';
import { assertReason, discountAmount, formatMoney, parseMoney, PAYMENT_METHODS, planPayment } from '@bills/domain';
import { formatClock, formatMinutes } from '../format.ts';
import type { Desk } from './desk.ts';
import { toActionError, useAction } from './desk.ts';
import { currencySymbol, METHOD_LABEL, toMoneyInput } from './format.ts';
import { groupLines } from './lines.ts';
import { FormError, Modal } from './Modal.tsx';
import { printReceipt } from './print/Receipt.tsx';

type Amounts = Record<PaymentMethod, string>;
const NO_AMOUNTS: Amounts = { CASH: '', CARD: '', QR: '' };

const ALL_BY: Record<PaymentMethod, string> = {
  CASH: 'Всё наличными',
  CARD: 'Всё картой',
  QR: 'Всё QR',
};

interface Preview {
  parts: PaymentPart[];
  plan: PaymentPlan | null;
  /** Why the payment cannot be taken as typed. Null with no plan: nothing typed yet. */
  problem: string | null;
}

/** What the guest hands over → what is applied, the change and what stays due. */
function previewPayment(due: Minor, amounts: Amounts, currency: string): Preview {
  const parts: PaymentPart[] = [];
  for (const method of PAYMENT_METHODS) {
    const text = amounts[method].trim();
    if (!text) continue;
    const amount = parseMoney(text, currency);
    if (amount === null) return { parts, plan: null, problem: `Проверьте сумму: ${METHOD_LABEL[method]}` };
    if (amount > 0) parts.push({ method, amount });
  }
  if (due > 0 && parts.length === 0) return { parts, plan: null, problem: null };
  try {
    return { parts, plan: planPayment(due, parts), problem: null };
  } catch (e) {
    return { parts, plan: null, problem: toActionError(e).message };
  }
}

/** Shown after a partial payment until the cashier types the next one. */
interface LastPayment {
  applied: Minor;
  change: Minor;
}

export function PayDialog({ desk, initial, onClose }: { desk: Desk; initial: CheckView; onClose: () => void }) {
  const { state } = desk;
  const { currency, timezone } = state.club;
  const money = (a: Minor) => formatMoney(a, currency);

  // The check from our latest response vs. the copy in the hall state (SSE): the newer one
  // wins. A paid or voided check leaves the hall state, so the response copy stays.
  const [snap, update] = useState(initial);
  const live = state.checks.find((c) => c.id === initial.id);
  const check = live && live.updatedAt >= snap.updatedAt ? live : snap;

  const [amounts, setAmounts] = useState<Amounts>(NO_AMOUNTS);
  const [last, setLast] = useState<LastPayment | null>(null);
  const [done, setDone] = useState<{ check: CheckView; change: Minor } | null>(null);
  const action = useAction();
  const formId = useId();
  const doneRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);

  const open = check.status === 'OPEN';
  const noShift = state.shift === null;
  const editable = open && check.paid - check.refunded === 0;
  const onCheck = new Set(check.items.map((i) => i.sessionId));
  const others = state.unpaid.filter((s) => s.checkId == null && !onCheck.has(s.id));
  const names = new Map(state.tables.map((t) => [t.id, t.name]));
  const preview = previewPayment(check.due, check.due > 0 ? amounts : NO_AMOUNTS, currency);
  const typed = PAYMENT_METHODS.some((m) => amounts[m].trim() !== '');

  const send = (path: string, body?: object) =>
    action.run(async () => {
      const next = await desk.send<CheckView>(path, body);
      update(next);
      return next;
    });

  const setDiscount = (discount: SetDiscountRequest['discount']) => {
    const body: SetDiscountRequest = { discount };
    return send(`/api/checks/${check.id}/discount`, body);
  };

  const fillAll = (method: PaymentMethod) => setAmounts({ ...NO_AMOUNTS, [method]: toMoneyInput(check.due, currency) });

  const pay = (e: FormEvent) => {
    e.preventDefault();
    const { plan, parts } = preview;
    if (!plan || noShift) return;
    void action.run(async () => {
      const body: PayRequest = { parts };
      const res = await desk.send<PayResponse>(`/api/checks/${check.id}/pay`, body);
      update(res.check);
      setAmounts(NO_AMOUNTS);
      if (res.check.status !== 'OPEN' || res.remaining === 0) setDone({ check: res.check, change: res.change });
      else setLast({ applied: res.applied, change: res.change });
    });
  };

  if (done) {
    return (
      <Modal
        title={`Счёт №${done.check.number}`}
        onClose={onClose}
        footer={
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => printReceipt(done.check, state.club, names)}>
              Печать чека
            </button>
            <button ref={doneRef} type="button" className="btn btn-primary" onClick={onClose}>
              Готово
            </button>
          </div>
        }
      >
        <div className="pay-done" role="status">
          <p className="pay-done-title">Счёт №{done.check.number} оплачен</p>
          <p className="pay-change" data-zero={done.change === 0 || undefined}>
            Сдача: {money(done.change)}
          </p>
        </div>
      </Modal>
    );
  }

  if (check.status === 'VOID') {
    return (
      <Modal
        title={`Счёт №${check.number}`}
        onClose={onClose}
        footer={
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Готово
          </button>
        }
      >
        <p>В счёте не осталось позиций — он аннулирован. Игры и заказы бара снова в списке «Ожидают оплаты».</p>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Счёт №${check.number}`}
      onClose={onClose}
      className="modal-pay"
      footer={
        <>
          <div className="pay-preview" aria-live="polite">
            {preview.problem ? (
              <p className="form-error">{preview.problem}</p>
            ) : preview.plan ? (
              <>
                {preview.plan.change > 0 && <p className="pay-change">Сдача: {money(preview.plan.change)}</p>}
                {preview.plan.remaining > 0 && (
                  <p className="pay-remaining">Останется к оплате: {money(preview.plan.remaining)}</p>
                )}
                {preview.plan.change === 0 && preview.plan.remaining === 0 && check.due > 0 && (
                  <p className="hint">Без сдачи</p>
                )}
              </>
            ) : last && !typed ? (
              <>
                <p className="pay-remaining">Принято {money(last.applied)} · осталось {money(check.due)}</p>
                {last.change > 0 && <p className="pay-change">Сдача: {money(last.change)}</p>}
              </>
            ) : (
              <p className="hint">Введите сумму или нажмите «Всё наличными»</p>
            )}
          </div>
          {noShift && <p className="hint hint-warn">Откройте смену, чтобы принимать оплату</p>}
          <FormError error={action.error?.message} />
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-narrow"
              title={open ? 'Напечатать счёт как есть, до оплаты' : undefined}
              onClick={() => printReceipt(check, state.club, names)}
            >
              {open ? 'Предчек' : 'Печать чека'}
            </button>
            <button
              type="submit"
              form={formId}
              className="btn btn-primary"
              disabled={!preview.plan || !open || noShift || action.pending}
            >
              {check.due === 0 ? 'Закрыть счёт' : 'Принять оплату'}
            </button>
          </div>
        </>
      }
    >
      <ul className="pay-items" aria-label="Позиции счёта">
        {groupLines(check.items).map(({ key, game, orders, tableId }) => (
          <Fragment key={key}>
            {game && (
              <li>
                <div className="pay-item-info">
                  <strong>{game.title}</strong>
                  {game.startedAt != null && game.stoppedAt != null && (
                    <span className="muted money">
                      {formatClock(game.startedAt, timezone)}–{formatClock(game.stoppedAt, timezone)} ·{' '}
                      {formatMinutes(game.playedSeconds ?? 0)}
                    </span>
                  )}
                </div>
                <span className="money">{money(game.amount)}</span>
                {/* Bar lines are not removed here: the order is cancelled on the orders page. */}
                {editable && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Убрать «${game.title}» из счёта${orders.length ? ' вместе с заказами бара' : ''}`}
                    title={orders.length ? 'Убрать из счёта вместе с заказами бара' : 'Убрать из счёта'}
                    disabled={action.pending}
                    onClick={() => void send(`/api/checks/${check.id}/items/${game.id}/remove`)}
                  >
                    ×
                  </button>
                )}
              </li>
            )}
            {orders.length > 0 && (
              <li className="pay-bar">
                <span className="pay-bar-head">
                  {game ? 'Бар' : `Бар · ${(tableId != null && names.get(tableId)) || 'без игры'}`}
                </span>
                <ul className="pay-bar-lines">
                  {orders.map((item) => (
                    <li key={item.id}>
                      <span className="pay-bar-title">
                        {item.title}
                        {item.qty != null && item.unitPrice != null && (
                          <span className="muted money">
                            {' '}
                            · {item.qty} × {money(item.unitPrice)}
                          </span>
                        )}
                      </span>
                      <span className="money">{money(item.amount)}</span>
                    </li>
                  ))}
                </ul>
              </li>
            )}
          </Fragment>
        ))}
      </ul>

      {open && others.length > 0 && (
        <div className="pay-add">
          <span className="hint">Добавить в счёт</span>
          <div className="chips">
            {others.map((s) => (
              <button
                key={s.id}
                type="button"
                className="chip"
                disabled={action.pending}
                onClick={() => {
                  const body: AddCheckItemRequest = { sessionId: s.id };
                  void send(`/api/checks/${check.id}/items`, body);
                }}
              >
                + {names.get(s.tableId) ?? 'Стол'} · {money(s.amount ?? 0)}
                {s.ordersTotal > 0 && ` + бар ${money(s.ordersTotal)}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {open && <DiscountForm check={check} currency={currency} pending={action.pending} onApply={setDiscount} />}

      <dl className="kv">
        <div>
          <dt>Сумма</dt>
          <dd>{money(check.subtotal)}</dd>
        </div>
        {(check.discount || check.discountAmount > 0) && (
          <div>
            <dt>
              Скидка
              {check.discount && (
                <span className="muted">
                  {' '}
                  · {check.discount.kind === 'PERCENT' ? `${check.discount.value}%` : money(check.discount.value)} ·{' '}
                  {check.discount.reason}
                </span>
              )}
            </dt>
            <dd>−{money(check.discountAmount)}</dd>
          </div>
        )}
        <div className="kv-strong">
          <dt>Итого</dt>
          <dd>{money(check.total)}</dd>
        </div>
        <div>
          <dt>Оплачено</dt>
          <dd>{money(check.paid)}</dd>
        </div>
        {check.refunded > 0 && (
          <div>
            <dt>Возвращено</dt>
            <dd>{money(check.refunded)}</dd>
          </div>
        )}
        <div className="kv-due">
          <dt>К оплате</dt>
          <dd>{money(check.due)}</dd>
        </div>
      </dl>

      {check.payments.length > 0 && (
        <section>
          <h3 className="cash-sub">Оплаты по счёту</h3>
          <ul className="pay-history">
            {check.payments.map((p) => (
              <li key={p.id}>
                <span className="muted money">{formatClock(p.at, timezone)}</span>
                <span>
                  {p.kind === 'REFUND' ? `Возврат · ${METHOD_LABEL[p.method]}` : METHOD_LABEL[p.method]}
                  {p.tendered != null && (p.change ?? 0) > 0 && (
                    <span className="muted">
                      {' '}
                      · получено {money(p.tendered)}, сдача {money(p.change ?? 0)}
                    </span>
                  )}
                  {p.reason && <span className="muted"> · {p.reason}</span>}
                </span>
                <span className="money">
                  {p.kind === 'REFUND' ? '−' : ''}
                  {money(p.amount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form id={formId} className="pay-form" onSubmit={pay}>
        {check.due > 0 ? (
          <>
            <h3 className="cash-sub" id={`${formId}-title`}>
              Оплата
            </h3>
            <div className="pay-parts" role="group" aria-labelledby={`${formId}-title`}>
              {PAYMENT_METHODS.map((m, i) => (
                <label key={m} className="pay-part">
                  <span>{METHOD_LABEL[m]}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0"
                    value={amounts[m]}
                    disabled={!open}
                    onChange={(e) => setAmounts((a) => ({ ...a, [m]: e.target.value }))}
                    data-autofocus={i === 0 ? '' : undefined}
                  />
                </label>
              ))}
            </div>
            <div className="row wrap pay-quick">
              {PAYMENT_METHODS.map((m) => (
                <button key={m} type="button" className="btn btn-small" disabled={!open} onClick={() => fillAll(m)}>
                  {ALL_BY[m]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="hint">Оплачивать нечего — закройте счёт.</p>
        )}
      </form>
    </Modal>
  );
}

function DiscountForm({
  check,
  currency,
  pending,
  onApply,
}: {
  check: CheckView;
  currency: string;
  pending: boolean;
  onApply: (discount: SetDiscountRequest['discount']) => Promise<CheckView | undefined>;
}) {
  const [kind, setKind] = useState<DiscountKind>(check.discount?.kind ?? 'PERCENT');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const apply = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    try {
      const text = value.trim();
      const v = kind === 'PERCENT' ? (/^\d{1,3}$/.test(text) ? Number(text) : NaN) : (parseMoney(text, currency) ?? NaN);
      // Same checks and wording as the HUB.
      discountAmount(check.subtotal, { kind, value: v });
      const why = assertReason(reason, 'причину скидки');
      void onApply({ kind, value: v, reason: why }).then((next) => {
        if (next) {
          setValue('');
          setReason('');
        }
      });
    } catch (err) {
      setProblem(toActionError(err).message);
    }
  };

  return (
    <details className="pay-discount" open={check.discount != null || undefined}>
      <summary>
        Скидка
        {check.discount && (
          <span className="muted">
            {check.discount.kind === 'PERCENT'
              ? `${check.discount.value}%`
              : formatMoney(check.discount.value, currency)}{' '}
            · {check.discount.by}
          </span>
        )}
      </summary>
      <form className="discount-form" onSubmit={apply}>
        <select aria-label="Вид скидки" value={kind} onChange={(e) => setKind(e.target.value as DiscountKind)}>
          <option value="PERCENT">%</option>
          <option value="AMOUNT">{currencySymbol(currency)}</option>
        </select>
        <input
          aria-label={kind === 'PERCENT' ? 'Скидка, %' : 'Скидка, сумма'}
          type="text"
          inputMode={kind === 'PERCENT' ? 'numeric' : 'decimal'}
          autoComplete="off"
          placeholder={kind === 'PERCENT' ? '10' : '500'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <input
          className="discount-reason"
          aria-label="Причина скидки"
          type="text"
          autoComplete="off"
          maxLength={500}
          placeholder="Причина скидки"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="row wrap discount-actions">
          <button type="submit" className="btn btn-small" disabled={pending}>
            Применить
          </button>
          {check.discount && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={pending}
              onClick={() => {
                setProblem(null);
                void onApply(null);
              }}
            >
              Убрать скидку
            </button>
          )}
        </div>
        <FormError error={problem} />
      </form>
    </details>
  );
}
