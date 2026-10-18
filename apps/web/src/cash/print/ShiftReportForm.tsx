import type { HubState, Minor, ShiftReport } from '@bills/domain';
import { formatMoney, PAYMENT_METHODS } from '@bills/domain';
import { formatWhen, METHOD_LABEL } from '../format.ts';
import { formatStamp, Info, Row, Sep } from './blocks.tsx';
import { printForm } from './printForm.tsx';

type Club = HubState['club'];
type Totals = ShiftReport['sales'];

export function printShiftReport(report: ShiftReport, club: Club): void {
  printForm(<ShiftReportForm report={report} club={club} />);
}

function MethodTotals({ title, totals, money }: { title: string; totals: Totals; money: (a: Minor) => string }) {
  return (
    <>
      <p className="pf-h">{title}</p>
      {PAYMENT_METHODS.map((m) => (
        <Row key={m} label={METHOD_LABEL[m]} value={money(totals[m])} />
      ))}
      <Row label="Итого" value={money(totals.total)} strong />
    </>
  );
}

/** X (interim) or Z (at close) report on the receipt printer. */
export function ShiftReportForm({ report, club }: { report: ShiftReport; club: Club }) {
  const money = (a: Minor) => formatMoney(a, club.currency);
  const tz = club.timezone;
  const z = report.kind === 'Z';
  const diff = report.difference;

  return (
    <div className="pf">
      <header className="pf-head">
        <p className="pf-club">{club.name}</p>
        <p className="pf-title">{z ? 'Z-отчёт' : 'X-отчёт'}</p>
        <p className="pf-strong">Смена №{report.shiftNumber}</p>
      </header>
      <Info label="Открыта">
        {formatStamp(report.openedAt, tz)}, {report.openedBy}
      </Info>
      {report.closedAt != null && (
        <Info label="Закрыта">
          {formatStamp(report.closedAt, tz)}, {report.closedBy ?? '—'}
        </Info>
      )}
      {!z && <Info label="Сформирован">{formatStamp(report.generatedAt, tz)}</Info>}

      <Sep />
      <MethodTotals title="Продажи" totals={report.sales} money={money} />
      <MethodTotals title="Возвраты" totals={report.refunds} money={money} />
      <MethodTotals title="За вычетом возвратов" totals={report.net} money={money} />

      <Sep />
      <p className="pf-h">Касса</p>
      <Row label="Размен" value={money(report.openingFloat)} />
      <Row label="Внесения" value={money(report.deposits)} />
      <Row label="Изъятия" value={money(report.withdrawals)} />
      <Row label="Ожидается в кассе" value={money(report.expectedCash)} strong />
      {z && report.countedCash != null && <Row label="Пересчитано" value={money(report.countedCash)} />}
      {z && diff != null && (
        <Row
          label={diff < 0 ? 'Недостача' : diff > 0 ? 'Излишек' : 'Расхождение'}
          value={money(Math.abs(diff))}
          big
        />
      )}
      {report.note && <Info label="Примечание">{report.note}</Info>}

      <Sep />
      <Row label="Счетов оплачено" value={report.checksPaid} />
      <Row label="Операций оплаты" value={report.paymentsCount} />
      <Row label="Возвратов" value={report.refundsCount} />
      <Row label="Скидки" value={money(report.discounts)} />
      <Row label="Отменённых игр" value={report.cancelledGames} />

      <Sep />
      <p className="pf-h">Внесения и изъятия</p>
      {report.movements.length === 0 ? (
        <p>Не было</p>
      ) : (
        report.movements.map((m) => (
          <div key={m.id} className="pf-item">
            <Row
              label={`${formatWhen(m.at, tz, report.openedAt)} ${m.kind === 'DEPOSIT' ? 'Внесение' : 'Изъятие'}`}
              value={`${m.kind === 'DEPOSIT' ? '+' : '−'}${money(m.amount)}`}
            />
            <p className="pf-sub">
              {m.reason} · {m.actor}
            </p>
          </div>
        ))
      )}

      <Sep />
      <p className="pf-center pf-notice">Не является фискальным документом</p>
    </div>
  );
}
