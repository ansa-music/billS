import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { CounterCancelRequest, Minor } from '@bills/domain';
import { CANCEL_REASON_MIN, formatMoney } from '@bills/domain';
import { command } from '../api.ts';
import { useAction } from '../cash/desk.ts';
import { FormError, Modal, TextField } from '../cash/Modal.tsx';

/** What the dialog needs of a counter order: from the barista's queue or a check of the day. */
export interface CancelTarget {
  orderId: string;
  number: number | null;
  total: Minor | null;
  /** «Капучино ×2, Круассан». */
  summary?: string;
}

/**
 * Cancels («удаляет») a counter order: the manager's and the administrator's right
 * (`counter.cancel`). Nothing is erased — the order stays in «Счета» → «Архив» with who
 * cancelled it and why. A paid order needs the refund first (the HUB says so).
 */
export function CounterCancelDialog({
  target,
  actor,
  currency,
  onClose,
  onDone,
}: {
  target: CancelTarget;
  actor: string;
  currency: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const action = useAction();
  const formId = useId();
  const name = target.number !== null ? `Заказ №${target.number}` : 'Заказ';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const text = reason.trim();
      if (text.length < CANCEL_REASON_MIN) throw new Error('Напишите причину отмены');
      const body: CounterCancelRequest = { reason: text };
      await command(`/api/counter/orders/${target.orderId}/cancel`, actor, body);
      onDone(`${name} отменён — он в «Архиве»`);
    });
  };

  return (
    <Modal
      title={`Отменить ${name.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <FormError error={action.error?.message} />
          {action.error?.code === 'ORDER_PAID' && (
            <p className="hint">Сначала верните деньги: «Счета» → «Чеки смены» → «Возврат».</p>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Не отменять
            </button>
            <button type="submit" form={formId} className="btn btn-danger" disabled={action.pending}>
              Отменить заказ
            </button>
          </div>
        </>
      }
    >
      <form id={formId} className="cash-form" onSubmit={submit}>
        <div className="cash-summary">
          <div>
            <strong>{name}</strong>
            {target.summary && <span className="muted">{target.summary}</span>}
          </div>
          {target.total !== null && <strong className="money">{formatMoney(target.total, currency)}</strong>}
        </div>
        <p className="hint">Чек не стирается: заказ попадёт в «Архив» с вашим именем и причиной.</p>
        <TextField label="Причина" value={reason} onChange={setReason} autoFocus maxLength={300} placeholder="Например: гость передумал" />
      </form>
    </Modal>
  );
}
