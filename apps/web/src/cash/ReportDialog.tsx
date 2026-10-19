import type { HubState, Minor, PaymentMethod, ShiftReport } from '@bills/domain';
import { formatMoney, PAYMENT_METHODS } from '@bills/domain';
import { formatClock } from '../format.ts';
import { describeDifference, formatDateTime, METHOD_LABEL } from './format.ts';
import { FormError, Modal } from './Modal.tsx';
import { printShiftReport } from './print/ShiftReportForm.tsx';

const ROWS: Array<[label: string, key: PaymentMethod | 'total']> = [
  ...PAYMENT_METHODS.map((m): [string, PaymentMethod] => [METHOD_LABEL[m], m]),
  ['Итого', 'total'],
];

/** X or Z report. While `report` is null it is still loading (or failed with `error`). */
export function ReportDialog({
  kind,
  report,
  error,
  club,
  onClose,
}: {
  kind: 'X' | 'Z';
  report: ShiftReport | null;
  error?: string | null;
  club: HubState['club'];
  onClose: () => void;
}) {
  const title = (report?.kind ?? kind) === 'Z' ? 'Z-отчёт' : 'X-отчёт';
  return (
    <Modal
      title={title}
      onClose={onClose}
      className="modal-wide"
      footer={
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Закрыть
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!report}
            onClick={() => report && printShiftReport(report, club)}
          >
            Печать
          </button>
        </div>
      }
    >
      {report ? (
        <ReportBody report={report} club={club} />
      ) : error ? (
        <FormError error={error} />
      ) : (
        <p className="muted">Загрузка…</p>
      )}
    </Modal>
  );
}

function ReportBody({ report, club }: { report: ShiftReport; club: HubState['club'] }) {
  const money = (a: Minor) => formatMoney(a, club.currency);
  const tz = club.timezone;
  const diff = report.difference != null ? describeDifference(report.difference, club.currency, formatMoney(0, club.currency)) : null;
  return (
    <div className="report">
      <div>
        <p className="report-title">
          Смена №{report.shiftNumber} · {club.name}
        </p>
        <dl className="kv">
          <div>
            <dt>Открыта</dt>
            <dd>
              {formatDateTime(report.openedAt, tz)} · {report.openedBy}
            </dd>
          </div>
          {report.closedAt != null && (
            <div>
              <dt>Закрыта</dt>
              <dd>
                {formatDateTime(report.closedAt, tz)} · {report.closedBy ?? '—'}
              </dd>
            </div>
          )}
          {report.kind === 'X' && (
            <div>
              <dt>Сформирован</dt>
              <dd>{formatDateTime(report.generatedAt, tz)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="report-split">
        <div className="table-scroll">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Способ оплаты</span>
                </th>
                <th scope="col">Продажи</th>
                <th scope="col">Возвраты</th>
                <th scope="col">Итого</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map(([label, key]) => (
                <tr key={key} className={key === 'total' ? 'report-total' : undefined}>
                  <th scope="row">{label}</th>
                  <td>{money(report.sales[key])}</td>
                  <td>{money(report.refunds[key])}</td>
                  <td>{money(report.net[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Absent in Z reports saved before the bar was billed on checks. */}
        {report.revenue && (
          <section className="report-revenue" aria-labelledby="report-revenue-title">
            <h3 className="cash-sub" id="report-revenue-title">
              Выручка
            </h3>
            <dl className="kv">
              <div>
                <dt>Время</dt>
                <dd>{money(report.revenue.time)}</dd>
              </div>
              <div>
                <dt>Бар</dt>
                <dd>{money(report.revenue.bar)}</dd>
              </div>
              <div className="kv-strong">
                <dt>Итого</dt>
                <dd>{money(report.revenue.time + report.revenue.bar)}</dd>
              </div>
            </dl>
            <p className="hint">По счетам, оплаченным в смену; скидка распределена между временем и баром.</p>
          </section>
        )}
      </div>

      <dl className="kv">
        <div>
          <dt>Размен</dt>
          <dd>{money(report.openingFloat)}</dd>
        </div>
        <div>
          <dt>Внесения</dt>
          <dd>{money(report.deposits)}</dd>
        </div>
        <div>
          <dt>Изъятия</dt>
          <dd>{money(report.withdrawals)}</dd>
        </div>
        <div className="kv-strong">
          <dt>Ожидается в кассе</dt>
          <dd>{money(report.expectedCash)}</dd>
        </div>
        {report.kind === 'Z' && report.countedCash != null && (
          <div>
            <dt>Пересчитано</dt>
            <dd>{money(report.countedCash)}</dd>
          </div>
        )}
        {report.kind === 'Z' && diff && (
          <div className="kv-strong">
            <dt>Расхождение</dt>
            <dd className="diff" data-sign={diff.sign}>
              {diff.text}
            </dd>
          </div>
        )}
        {report.note && (
          <div>
            <dt>Примечание</dt>
            <dd>{report.note}</dd>
          </div>
        )}
      </dl>

      <dl className="kv">
        <div>
          <dt>Счетов оплачено</dt>
          <dd>{report.checksPaid}</dd>
        </div>
        <div>
          <dt>Операций оплаты</dt>
          <dd>{report.paymentsCount}</dd>
        </div>
        <div>
          <dt>Возвратов</dt>
          <dd>{report.refundsCount}</dd>
        </div>
        <div>
          <dt>Скидки</dt>
          <dd>{money(report.discounts)}</dd>
        </div>
        <div>
          <dt>Отменённых игр</dt>
          <dd>{report.cancelledGames}</dd>
        </div>
      </dl>

      <section>
        <h3 className="cash-sub">Внесения и изъятия</h3>
        {report.movements.length === 0 ? (
          <p className="muted">Не было</p>
        ) : (
          <ul className="movements">
            {report.movements.map((m) => (
              <li key={m.id}>
                <span className="muted money">{formatClock(m.at, tz)}</span>
                <span className="movement-reason">
                  {m.kind === 'DEPOSIT' ? 'Внесение' : 'Изъятие'} · {m.reason}
                  <span className="muted"> · {m.actor}</span>
                </span>
                <span className="money">
                  {m.kind === 'DEPOSIT' ? '+' : '−'}
                  {money(m.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
