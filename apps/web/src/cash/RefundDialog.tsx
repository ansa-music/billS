import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { CheckView, PaymentMethod, RefundRequest } from '@bills/domain';
import {
  assertApprover,
  assertReason,
  assertRefundable,
  formatMoney,
  netPaidByMethod,
  parseMoney,
  PAYMENT_METHODS,
} from '@bills/domain';
import type { Desk } from './desk.ts';
import { useAction } from './desk.ts';
import { currencySymbol, METHOD_LABEL, toMoneyInput } from './format.ts';
import { FormError, Modal, MoneyField, TextField } from './Modal.tsx';

/** Refund on a paid (or partly paid) check, limited to what was taken by each method. */
export function RefundDialog({
  desk,
  check,
  onClose,
  onDone,
}: {
  desk: Desk;
  check: CheckView;
  onClose: () => void;
  onDone: (check: CheckView) => void;
}) {
  const currency = desk.state.club.currency;
  const net = netPaidByMethod(check.payments);
  const methods = PAYMENT_METHODS.filter((m) => net[m] > 0);
  const first = methods[0] ?? 'CASH';
  const [method, setMethod] = useState<PaymentMethod>(first);
  const [amount, setAmount] = useState(() => toMoneyInput(net[first], currency));
  const [reason, setReason] = useState('');
  const [approver, setApprover] = useState('');
  const action = useAction();
  const formId = useId();

  const pick = (m: PaymentMethod) => {
    setMethod(m);
    setAmount(toMoneyInput(net[m], currency));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const minor = parseMoney(amount, currency);
      if (minor === null) throw new Error('Проверьте сумму возврата');
      assertRefundable(check.payments, method, minor);
      const body: RefundRequest = {
        method,
        amount: minor,
        reason: assertReason(reason, 'причину возврата'),
        approvedBy: assertApprover(approver),
      };
      const updated = await desk.send<CheckView>(`/api/checks/${check.id}/refund`, body);
      desk.notify(`Возврат ${formatMoney(minor, currency)} по счёту №${check.number} оформлен`);
      onDone(updated);
    });
  };

  return (
    <Modal
      title={`Возврат по счёту №${check.number}`}
      onClose={onClose}
      footer={
        <>
          <FormError error={action.error?.message} />
          <div className="modal-actions">
            <button
              type="submit"
              form={formId}
              className="btn btn-danger"
              disabled={action.pending || methods.length === 0}
            >
              Оформить возврат
            </button>
          </div>
        </>
      }
    >
      {methods.length === 0 ? (
        <p className="muted">По этому счёту возвращать нечего.</p>
      ) : (
        <form id={formId} className="cash-form" onSubmit={submit}>
          <dl className="kv">
            <div>
              <dt>Итого по счёту</dt>
              <dd>{formatMoney(check.total, currency)}</dd>
            </div>
            {methods.map((m) => (
              <div key={m}>
                <dt>Можно вернуть: {METHOD_LABEL[m]}</dt>
                <dd>{formatMoney(net[m], currency)}</dd>
              </div>
            ))}
          </dl>
          <label className="field">
            <span>Способ возврата</span>
            <select value={method} onChange={(e) => pick(e.target.value as PaymentMethod)}>
              {methods.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]} — до {formatMoney(net[m], currency)}
                </option>
              ))}
            </select>
          </label>
          <MoneyField label={`Сумма, ${currencySymbol(currency)}`} value={amount} onChange={setAmount} autoFocus />
          <TextField label="Причина" value={reason} onChange={setReason} placeholder="Например: гость ушёл раньше" />
          <TextField label="Подтвердил (управляющий)" value={approver} onChange={setApprover} maxLength={100} />
          {method === 'CASH' && <p className="hint">Наличные выдаются из кассы смены.</p>}
        </form>
      )}
    </Modal>
  );
}
