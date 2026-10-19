import { useCallback } from 'react';
import type { CloudShiftView } from '@bills/domain';
import { fetchClub } from './api.ts';
import { formatDateTime, formatMinutes, formatSigned, money } from './format.ts';
import { usePoll } from './hooks.ts';
import { ClubHeader } from './ClubPage.tsx';
import { Difference, MethodSplit, Section, checksLabel, loadingText } from './shared.tsx';

/** Time zone of a shift's club: the club page knows one, the overview looks it up per club. */
export type ZoneOf = (shift: CloudShiftView) => string;

function shiftDuration(s: CloudShiftView, now: number): string {
  const end = s.closedAt ?? now;
  return formatMinutes(Math.max(0, end - s.openedAt) / 1000);
}

/** "12.03, 18:05 → 13.03, 02:10" in one cell; an open shift shows only the start. */
function ShiftSpan({ s, timezone, now }: { s: CloudShiftView; timezone: string; now: number }) {
  return (
    <span className="cell-stack">
      <span className="tnum">
        {formatDateTime(s.openedAt, timezone)}
        {s.closedAt !== null ? ` → ${formatDateTime(s.closedAt, timezone)}` : ''}
      </span>
      <span className="cell-sub">
        {s.status === 'OPEN' ? <span className="tag tag-live">открыта</span> : null}
        {s.status === 'OPEN' ? ' ' : ''}
        {shiftDuration(s, now)}
      </span>
    </span>
  );
}

function Cashier({ s }: { s: CloudShiftView }) {
  if (s.closedBy && s.closedBy !== s.openedBy) {
    return (
      <span className="cell-stack">
        <span>{s.openedBy}</span>
        <span className="cell-sub">закрыл {s.closedBy}</span>
      </span>
    );
  }
  return <span>{s.openedBy}</span>;
}

/** Cash left in the drawer after the Z report: expected / counted. */
function CashCells({ s, currency }: { s: CloudShiftView; currency: string }) {
  return (
    <>
      <td className="num">{s.expectedCash !== null ? money(s.expectedCash, currency) : <span className="muted">—</span>}</td>
      <td className="num">{s.countedCash !== null ? money(s.countedCash, currency) : <span className="muted">—</span>}</td>
      <td className="num">
        <Difference value={s.difference} currency={currency} words={false} />
      </td>
    </>
  );
}

function sum(shifts: CloudShiftView[], pick: (s: CloudShiftView) => number | null): number {
  return shifts.reduce((acc, s) => acc + (pick(s) ?? 0), 0);
}

/**
 * Shifts of one club with the full Z report columns and a totals row for the period.
 * `brief` (the overview) drops the float, deposits and refunds and adds the club column.
 */
export function ShiftsTable({
  shifts,
  currency,
  zoneOf,
  now,
  brief = false,
  withTotals = false,
}: {
  shifts: CloudShiftView[];
  currency: string;
  zoneOf: ZoneOf;
  now: number;
  brief?: boolean;
  withTotals?: boolean;
}) {
  if (shifts.length === 0) return <p className="empty">{brief ? 'За 7 дней смены не закрывались' : 'За 30 дней смен не было'}</p>;
  const closed = shifts.filter((s) => s.status === 'CLOSED');
  const totals = {
    sales: {
      cash: sum(shifts, (s) => s.sales.cash),
      card: sum(shifts, (s) => s.sales.card),
      qr: sum(shifts, (s) => s.sales.qr),
      total: sum(shifts, (s) => s.sales.total),
    },
    net: {
      cash: sum(shifts, (s) => s.net.cash),
      card: sum(shifts, (s) => s.net.card),
      qr: sum(shifts, (s) => s.net.qr),
      total: sum(shifts, (s) => s.net.total),
    },
    refunds: sum(shifts, (s) => s.refunds.total),
    deposits: sum(shifts, (s) => s.deposits),
    withdrawals: sum(shifts, (s) => s.withdrawals),
    float: sum(shifts, (s) => s.openingFloat),
    expected: sum(closed, (s) => s.expectedCash),
    counted: sum(closed, (s) => s.countedCash),
    difference: sum(closed, (s) => s.difference),
    checks: sum(shifts, (s) => s.checksPaid),
  };
  return (
    <div className="grid-wrap">
      <table className="grid shifts-grid">
        <thead>
          <tr>
            {brief && <th>Клуб</th>}
            <th className="num">№</th>
            <th>Открыта → закрыта</th>
            <th>Кассир</th>
            <th className="num">Итог</th>
            <th>Нал / карта / QR</th>
            {!brief && <th className="num">Возвраты</th>}
            {!brief && <th className="num">Внесения / изъятия</th>}
            {!brief && <th className="num">Размен</th>}
            <th className="num">Ожидалось</th>
            <th className="num">Посчитано</th>
            <th className="num">Расхождение</th>
            {!brief && <th className="num">Чеков</th>}
            <th>Заметка</th>
          </tr>
        </thead>
        <tbody>
          {shifts.map((s) => {
            const tz = zoneOf(s);
            return (
              <tr key={s.id} data-open={s.status === 'OPEN' || undefined} data-mismatch={(s.difference ?? 0) !== 0 || undefined}>
                {brief && <td>{s.clubName}</td>}
                <td className="num">{s.number}</td>
                <td>
                  <ShiftSpan s={s} timezone={tz} now={now} />
                </td>
                <td>
                  <Cashier s={s} />
                </td>
                <td className="num" title={`Продажи ${money(s.sales.total, currency)} − возвраты ${money(s.refunds.total, currency)}`}>
                  {money(s.net.total, currency)}
                </td>
                <td>
                  <MethodSplit totals={brief ? s.net : s.sales} currency={currency} />
                </td>
                {!brief && (
                  <td className="num">
                    {s.refunds.total > 0 ? (
                      <span className="cell-stack">
                        <span className="refund">{formatSigned(-s.refunds.total, currency)}</span>
                        <span className="cell-sub">{s.refundsCount} шт.</span>
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                )}
                {!brief && (
                  <td className="num">
                    {s.deposits === 0 && s.withdrawals === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className="cell-stack">
                        {s.deposits > 0 && <span>{formatSigned(s.deposits, currency)}</span>}
                        {s.withdrawals > 0 && <span>{formatSigned(-s.withdrawals, currency)}</span>}
                      </span>
                    )}
                  </td>
                )}
                {!brief && <td className="num">{money(s.openingFloat, currency)}</td>}
                <CashCells s={s} currency={currency} />
                {!brief && <td className="num">{s.checksPaid}</td>}
                <td className="note" title={s.note ?? undefined}>
                  {s.note ?? <span className="muted">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
        {withTotals && (
          <tfoot>
            <tr className="total-row">
              {brief && <td />}
              <td className="num muted">{shifts.length}</td>
              <td>Итого за период</td>
              <td />
              <td className="num">{money(totals.net.total, currency)}</td>
              <td>
                <MethodSplit totals={brief ? totals.net : totals.sales} currency={currency} />
              </td>
              {!brief && (
                <td className="num">
                  {totals.refunds > 0 ? <span className="refund">{formatSigned(-totals.refunds, currency)}</span> : <span className="muted">—</span>}
                </td>
              )}
              {!brief && (
                <td className="num">
                  {totals.deposits === 0 && totals.withdrawals === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    <span className="cell-stack">
                      {totals.deposits > 0 && <span>{formatSigned(totals.deposits, currency)}</span>}
                      {totals.withdrawals > 0 && <span>{formatSigned(-totals.withdrawals, currency)}</span>}
                    </span>
                  )}
                </td>
              )}
              {!brief && <td className="num">{money(totals.float, currency)}</td>}
              <td className="num">{closed.length > 0 ? money(totals.expected, currency) : <span className="muted">—</span>}</td>
              <td className="num">{closed.length > 0 ? money(totals.counted, currency) : <span className="muted">—</span>}</td>
              <td className="num">
                <Difference value={closed.length > 0 ? totals.difference : null} currency={currency} words={false} />
              </td>
              {!brief && <td className="num">{totals.checks}</td>}
              <td className="muted">{brief ? checksLabel(totals.checks) : ''}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** #/clubs/:id/shifts — cash shifts of the club for the last 30 days, the open one on top. */
export function Shifts({ id }: { id: string }) {
  const load = useCallback(() => fetchClub(id), [id]);
  const { data, error } = usePoll(load, 30_000);

  if (!data) {
    return <p className="boot-inline">{loadingText(error, 'смены')}</p>;
  }

  const { club } = data;
  const now = Date.now();
  // The open shift goes first regardless of how the cloud sorted the list.
  const shifts = [...data.shifts].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'OPEN' ? -1 : 1;
    return (b.closedAt ?? b.openedAt) - (a.closedAt ?? a.openedAt);
  });
  const closed = shifts.filter((s) => s.status === 'CLOSED');
  const mismatched = closed.filter((s) => (s.difference ?? 0) !== 0).length;

  return (
    <>
      <ClubHeader club={club} now={now} tab="shifts" />

      <Section
        title="Смены · 30 дней"
        aside={
          <span className="panel-aside">
            {club.openShift ? (
              <span className="tag tag-live">смена №{club.openShift.number} открыта</span>
            ) : (
              <span className="muted">смена закрыта</span>
            )}
            {mismatched > 0 && (
              <span className="tag tag-danger" title="Смены, где посчитанная наличность не сошлась с ожидаемой">
                расхождений: {mismatched}
              </span>
            )}
          </span>
        }
      >
        <ShiftsTable shifts={shifts} currency={club.currency} zoneOf={() => club.timezone} now={now} withTotals />
        <p className="hint">
          Итог — продажи минус возвраты по оплатам смены. «Ожидалось» — размен + наличные продажи − наличные возвраты +
          внесения − изъятия; «посчитано» — что кассир насчитал в ящике при закрытии. Время по часам клуба (
          {club.timezone}). Обновляется каждые 30 секунд.
        </p>
      </Section>
    </>
  );
}
