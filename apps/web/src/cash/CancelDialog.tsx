import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { CancelSessionRequest, SessionView } from '@bills/domain';
import { assertApprover, assertReason, formatMoney } from '@bills/domain';
import { formatClock, formatMinutes } from '../format.ts';
import type { Desk } from './desk.ts';
import { useAction } from './desk.ts';
import { FormError, Modal, TextField } from './Modal.tsx';

/** Voids an unpaid game: a reason and the approving manager go to the audit. */
export function CancelDialog({ desk, session, onClose }: { desk: Desk; session: SessionView; onClose: () => void }) {
  const { club, tables } = desk.state;
  const tableName = tables.find((t) => t.id === session.tableId)?.name ?? 'Стол';
  const [reason, setReason] = useState('');
  const [approver, setApprover] = useState('');
  const action = useAction();
  const formId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const body: CancelSessionRequest = {
        reason: assertReason(reason, 'причину отмены'),
        approvedBy: assertApprover(approver),
      };
      await desk.send<SessionView>(`/api/sessions/${session.id}/cancel`, body);
      desk.notify(`Игра на столе «${tableName}» отменена`);
      onClose();
    });
  };

  return (
    <Modal
      title="Отмена игры"
      onClose={onClose}
      footer={
        <>
          <FormError error={action.error?.message} />
          <div className="modal-actions">
            <button type="submit" form={formId} className="btn btn-danger" disabled={action.pending}>
              Отменить игру
            </button>
          </div>
        </>
      }
    >
      <form id={formId} className="cash-form" onSubmit={submit}>
        <div className="cash-summary">
          <div>
            <strong>{tableName}</strong>
            <span className="muted money">
              {session.startedAt != null && formatClock(session.startedAt, club.timezone)}–
              {session.stoppedAt != null && formatClock(session.stoppedAt, club.timezone)} ·{' '}
              {formatMinutes(session.playedSeconds ?? 0)}
            </span>
          </div>
          <strong className="money">{formatMoney(session.amount ?? 0, club.currency)}</strong>
        </div>
        <p className="hint">Игра будет снята без оплаты. Отмена попадёт в журнал с причиной и именем управляющего.</p>
        {session.ordersTotal > 0 && (
          <p className="hint hint-warn">
            Заказы бара этой игры ({formatMoney(session.ordersTotal, club.currency)}) не отменяются — они останутся к
            оплате в списке «Заказы без счёта».
          </p>
        )}
        <TextField label="Причина" value={reason} onChange={setReason} autoFocus placeholder="Например: тестовое включение" />
        <TextField label="Подтвердил (управляющий)" value={approver} onChange={setApprover} maxLength={100} />
      </form>
    </Modal>
  );
}
