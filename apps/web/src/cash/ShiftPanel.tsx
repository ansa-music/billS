import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  CashMovementKind,
  CashMovementRequest,
  CheckView,
  CloseShiftRequest,
  CloseShiftResponse,
  Minor,
  OpenShiftRequest,
  PaymentMethod,
  ShiftReport,
  ShiftView,
} from '@bills/domain';
import {
  assertCashAmount,
  assertCashAvailable,
  assertReason,
  cashDifference,
  formatMoney,
  netPaidByMethod,
  parseMoney,
  PAYMENT_METHODS,
} from '@bills/domain';
import { getJson } from '../api.ts';
import type { Desk, DeskProps } from './desk.ts';
import { useAction, useDesk, useLoad } from './desk.ts';
import { currencySymbol, describeDifference, formatWhen, METHOD_LABEL } from './format.ts';
import { FormError, Modal, MoneyField, TextField } from './Modal.tsx';
import { PaperSwitch } from './print/PaperSwitch.tsx';
import { printReceipt } from './print/Receipt.tsx';
import { printShiftReport } from './print/ShiftReportForm.tsx';
import { RefundDialog } from './RefundDialog.tsx';
import { ReportDialog } from './ReportDialog.tsx';

type ShiftDialog =
  | { kind: 'cash'; movement: CashMovementKind }
  | { kind: 'x-report'; shiftId: string }
  | { kind: 'checks'; shiftId: string }
  | { kind: 'close'; shift: ShiftView }
  | { kind: 'z-report'; report: ShiftReport };

/** Cash shift: open with a float, deposits and withdrawals, X report, the shift's checks, close with a count. */
export function ShiftPanel(props: DeskProps) {
  const desk = useDesk(props);
  const { shift, club, serverNow } = desk.state;
  const [dialog, setDialog] = useState<ShiftDialog | null>(null);
  const close = () => setDialog(null);
  const xPrint = useAction();

  // Straight to the printer, without opening the report.
  const printX = (shiftId: string) =>
    void xPrint.run(async () => {
      printShiftReport(await getJson<ShiftReport>(`/api/shifts/${shiftId}/report`), club);
    });

  return (
    <>
      {shift ? (
        <section className="panel cash-panel" aria-labelledby="shift-title">
          <header className="panel-head">
            <h2 id="shift-title">Смена №{shift.number}</h2>
            <span className="tag tag-ok">открыта</span>
          </header>
          <p className="hint">
            Открыта {formatWhen(shift.openedAt, club.timezone, serverNow)} · {shift.openedBy}
          </p>
          <div className="shift-cash">
            <span>Наличных в кассе</span>
            <strong className="money">{formatMoney(shift.expectedCash, club.currency)}</strong>
          </div>
          <div className="shift-actions">
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setDialog({ kind: 'cash', movement: 'DEPOSIT' })}
            >
              Внести
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setDialog({ kind: 'cash', movement: 'WITHDRAWAL' })}
            >
              Изъять
            </button>
            <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'x-report', shiftId: shift.id })}>
              X-отчёт
            </button>
            <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'checks', shiftId: shift.id })}>
              Чеки смены
            </button>
          </div>
          <div className="shift-print">
            <PaperSwitch />
            <button
              type="button"
              className="btn btn-small"
              title="Печать X-отчёта"
              disabled={xPrint.pending}
              onClick={() => printX(shift.id)}
            >
              Печать X
            </button>
          </div>
          <FormError error={xPrint.error?.message} />
          <button type="button" className="btn btn-outline-danger" onClick={() => setDialog({ kind: 'close', shift })}>
            Закрыть смену
          </button>
        </section>
      ) : (
        <OpenShiftForm desk={desk} />
      )}

      {dialog?.kind === 'cash' && shift && (
        <CashMovementDialog desk={desk} shift={shift} kind={dialog.movement} onClose={close} />
      )}
      {dialog?.kind === 'x-report' && <XReportDialog desk={desk} shiftId={dialog.shiftId} onClose={close} />}
      {dialog?.kind === 'checks' && <ShiftChecksDialog desk={desk} shiftId={dialog.shiftId} onClose={close} />}
      {dialog?.kind === 'close' && (
        <CloseShiftDialog
          desk={desk}
          shift={shift ?? dialog.shift}
          onClose={close}
          onClosed={(report) => setDialog({ kind: 'z-report', report })}
        />
      )}
      {dialog?.kind === 'z-report' && <ReportDialog kind="Z" report={dialog.report} club={club} onClose={close} />}
    </>
  );
}

function OpenShiftForm({ desk }: { desk: Desk }) {
  const currency = desk.state.club.currency;
  const [float, setFloat] = useState('');
  const action = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const openingFloat = float.trim() === '' ? 0 : parseMoney(float, currency);
      if (openingFloat === null) throw new Error('Проверьте сумму размена');
      const body: OpenShiftRequest = { openingFloat };
      await desk.send<ShiftView>('/api/shifts/open', body);
      setFloat('');
    });
  };

  return (
    <section className="panel cash-panel" aria-labelledby="shift-title">
      <header className="panel-head">
        <h2 id="shift-title">Смена закрыта</h2>
      </header>
      <form className="cash-form" onSubmit={submit}>
        <MoneyField label={`Размен в кассе, ${currencySymbol(currency)}`} value={float} onChange={setFloat} />
        <FormError error={action.error?.message} />
        <button type="submit" className="btn btn-primary" disabled={action.pending}>
          Открыть смену
        </button>
      </form>
    </section>
  );
}

function CashMovementDialog({
  desk,
  shift,
  kind,
  onClose,
}: {
  desk: Desk;
  shift: ShiftView;
  kind: CashMovementKind;
  onClose: () => void;
}) {
  const currency = desk.state.club.currency;
  const deposit = kind === 'DEPOSIT';
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const action = useAction();
  const formId = useId();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      const minor = parseMoney(amount, currency);
      if (minor === null) throw new Error('Проверьте сумму');
      assertCashAmount(minor);
      if (!deposit) assertCashAvailable(shift.expectedCash, minor);
      const body: CashMovementRequest = { kind, amount: minor, reason: assertReason(reason) };
      await desk.send<ShiftView>(`/api/shifts/${shift.id}/cash`, body);
      desk.notify(`${deposit ? 'Внесено' : 'Изъято'} ${formatMoney(minor, currency)}`);
      onClose();
    });
  };

  return (
    <Modal
      title={deposit ? 'Внесение в кассу' : 'Изъятие из кассы'}
      onClose={onClose}
      footer={
        <>
          <FormError error={action.error?.message} />
          <div className="modal-actions">
            <button type="submit" form={formId} className="btn btn-primary" disabled={action.pending}>
              {deposit ? 'Внести' : 'Изъять'}
            </button>
          </div>
        </>
      }
    >
      <form id={formId} className="cash-form" onSubmit={submit}>
        <p className="muted">
          Наличных в кассе: <strong className="money">{formatMoney(shift.expectedCash, currency)}</strong>
        </p>
        <MoneyField label={`Сумма, ${currencySymbol(currency)}`} value={amount} onChange={setAmount} autoFocus />
        <TextField
          label="Причина"
          value={reason}
          onChange={setReason}
          placeholder={deposit ? 'Например: размен из сейфа' : 'Например: инкассация'}
        />
      </form>
    </Modal>
  );
}

function XReportDialog({ desk, shiftId, onClose }: { desk: Desk; shiftId: string; onClose: () => void }) {
  const { data, error } = useLoad<ShiftReport>(`/api/shifts/${shiftId}/report`);
  return <ReportDialog kind="X" report={data} error={error} club={desk.state.club} onClose={onClose} />;
}

function CloseShiftDialog({
  desk,
  shift,
  onClose,
  onClosed,
}: {
  desk: Desk;
  shift: ShiftView;
  onClose: () => void;
  onClosed: (report: ShiftReport) => void;
}) {
  const { currency } = desk.state.club;
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const action = useAction();
  const formId = useId();

  const countedCash = counted.trim() === '' ? null : parseMoney(counted, currency);
  const diff = countedCash === null ? null : describeDifference(cashDifference(countedCash, shift.expectedCash), currency);
  const unpaidLeft = desk.state.unpaid.length > 0 || desk.state.checks.length > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void action.run(async () => {
      if (countedCash === null) throw new Error('Укажите, сколько наличных в кассе');
      const body: CloseShiftRequest = { countedCash, ...(note.trim() ? { note: note.trim() } : {}) };
      const res = await desk.send<CloseShiftResponse>(`/api/shifts/${shift.id}/close`, body);
      onClosed(res.report);
    });
  };

  return (
    <Modal
      title={`Закрытие смены №${shift.number}`}
      onClose={onClose}
      footer={
        <>
          <FormError error={action.error?.message} />
          {action.error?.code === 'UNPAID_CHECKS' && (
            <p className="hint">Примите оплату или отмените игры в панели «Ожидают оплаты».</p>
          )}
          <div className="modal-actions">
            <button type="submit" form={formId} className="btn btn-danger" disabled={action.pending}>
              Закрыть смену
            </button>
          </div>
        </>
      }
    >
      <form id={formId} className="cash-form" onSubmit={submit}>
        <div className="shift-cash">
          <span>Ожидается в кассе</span>
          <strong className="money">{formatMoney(shift.expectedCash, currency)}</strong>
        </div>
        <MoneyField
          label={`Пересчитано наличных, ${currencySymbol(currency)}`}
          value={counted}
          onChange={setCounted}
          autoFocus
        />
        {counted.trim() !== '' && (
          <p className="diff diff-big" data-sign={diff?.sign} aria-live="polite">
            {diff ? diff.text : 'Проверьте сумму'}
          </p>
        )}
        <label className="field">
          <span>Комментарий (необязательно)</span>
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {unpaidLeft && action.error?.code !== 'UNPAID_CHECKS' && (
          <p className="hint hint-warn">Есть неоплаченные игры или счета — смену закрыть не получится.</p>
        )}
      </form>
    </Modal>
  );
}

function sumByMethod(check: CheckView, kind: 'PAYMENT' | 'REFUND'): Record<PaymentMethod, Minor> {
  const sums: Record<PaymentMethod, Minor> = { CASH: 0, CARD: 0, QR: 0 };
  for (const p of check.payments) if (p.kind === kind) sums[p.method] += p.amount;
  return sums;
}

function lastActivity(check: CheckView): number {
  return check.payments.reduce((at, p) => Math.max(at, p.at), check.closedAt ?? check.createdAt);
}

function ShiftChecksDialog({ desk, shiftId, onClose }: { desk: Desk; shiftId: string; onClose: () => void }) {
  const { club, serverNow } = desk.state;
  const { data, error, reload } = useLoad<CheckView[]>(`/api/shifts/${shiftId}/checks`);
  const [refundFor, setRefundFor] = useState<CheckView | null>(null);
  const money = (a: Minor) => formatMoney(a, club.currency);
  const checks = data ? [...data].sort((a, b) => lastActivity(b) - lastActivity(a)) : null;

  return (
    <>
      <Modal title="Чеки смены" onClose={onClose} className="modal-wide">
        {error ? (
          <FormError error={error} />
        ) : !checks ? (
          <p className="muted">Загрузка…</p>
        ) : checks.length === 0 ? (
          <p className="empty">В этой смене оплат ещё не было</p>
        ) : (
          <ul className="shift-checks">
            {checks.map((c) => {
              const paid = sumByMethod(c, 'PAYMENT');
              const net = netPaidByMethod(c.payments);
              const refundable = PAYMENT_METHODS.some((m) => net[m] > 0);
              const methods = PAYMENT_METHODS.filter((m) => paid[m] > 0);
              return (
                <li key={c.id}>
                  <div className="sc-head">
                    <strong>Счёт №{c.number}</strong>
                    <span className="muted money">{formatWhen(lastActivity(c), club.timezone, serverNow)}</span>
                    {c.status === 'OPEN' && <span className="tag tag-warn">частично</span>}
                    <strong className="money sc-total">{money(c.total)}</strong>
                  </div>
                  <span className="muted">{c.items.map((i) => i.title).join(', ')}</span>
                  {methods.length > 0 && (
                    <span className="money-line">
                      {methods.map((m) => `${METHOD_LABEL[m]} ${money(paid[m])}`).join(' · ')}
                    </span>
                  )}
                  {c.refunded > 0 && <span className="sc-refunded">Возвращено {money(c.refunded)}</span>}
                  <div className="row wrap sc-actions">
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label={`Печать счёта №${c.number}`}
                      onClick={() => printReceipt(c, club)}
                    >
                      Печать
                    </button>
                    {refundable && (
                      <button type="button" className="btn btn-small btn-outline-danger" onClick={() => setRefundFor(c)}>
                        Возврат
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Modal>
      {refundFor && (
        <RefundDialog
          desk={desk}
          check={refundFor}
          onClose={() => setRefundFor(null)}
          onDone={() => {
            setRefundFor(null);
            reload();
          }}
        />
      )}
    </>
  );
}
