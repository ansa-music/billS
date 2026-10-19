import { Fragment } from 'react';
import type { CheckView, HubState, Minor } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { formatClock, formatMinutes } from '../../format.ts';
import { METHOD_LABEL } from '../format.ts';
import { groupLines } from '../lines.ts';
import { formatStamp, Info, Row, Sep } from './blocks.tsx';
import { printForm } from './printForm.tsx';

type Club = HubState['club'];

/**
 * Prints the guest check; an OPEN check comes out as «Предчек» with what is still due.
 * `names` (table id → name) titles bar lines whose game is not on the check.
 */
export function printReceipt(
  check: CheckView,
  club: Club,
  names?: ReadonlyMap<string, string>,
  now: number = Date.now(),
): void {
  printForm(<Receipt check={check} club={club} names={names} now={now} />);
}

/** A settled check is dated by its last payment; anything else by the moment it is printed. */
function receiptTime(check: CheckView, now: number): number {
  if (check.status !== 'PAID') return now;
  const paidAt = check.payments.reduce((at, p) => (p.kind === 'PAYMENT' ? Math.max(at, p.at) : at), 0);
  return paidAt || check.closedAt || now;
}

/** Who took the money; before any payment, who opened the check. */
function cashiers(check: CheckView): string {
  const names = new Set(check.payments.filter((p) => p.kind === 'PAYMENT').map((p) => p.actor));
  return names.size > 0 ? [...names].join(', ') : check.createdBy;
}

export function Receipt({
  check,
  club,
  names,
  now,
}: {
  check: CheckView;
  club: Club;
  names?: ReadonlyMap<string, string> | undefined;
  now: number;
}) {
  const money = (a: Minor) => formatMoney(a, club.currency);
  const tz = club.timezone;
  const pre = check.status === 'OPEN';
  const payments = check.payments.filter((p) => p.kind === 'PAYMENT');
  const refunds = check.payments.filter((p) => p.kind === 'REFUND');
  // Paid in several goes: the time tells the payments apart.
  const timed = new Set(payments.map((p) => p.operationId)).size > 1;
  const discounted = check.discount != null || check.discountAmount > 0;

  return (
    <div className="pf">
      <header className="pf-head">
        <p className="pf-club">{club.name}</p>
        {pre && <p className="pf-title">Предчек</p>}
        <p className={pre ? 'pf-strong' : 'pf-title'}>Счёт №{check.number}</p>
        {check.status === 'VOID' && <p className="pf-strong">Аннулирован</p>}
        <p>{formatStamp(receiptTime(check, now), tz)}</p>
      </header>
      <Info label="Кассир">{cashiers(check)}</Info>

      <Sep />
      {groupLines(check.items).map(({ key, game, orders, tableId }) => (
        <Fragment key={key}>
          {game ? (
            <div className="pf-item">
              <Row label={game.title} value={money(game.amount)} />
              {game.startedAt != null && game.stoppedAt != null && (
                <p className="pf-sub">
                  {formatClock(game.startedAt, tz)}–{formatClock(game.stoppedAt, tz)} · {formatMinutes(game.playedSeconds ?? 0)}
                </p>
              )}
            </div>
          ) : (
            <p className="pf-item pf-strong">Бар{tableId != null && names?.get(tableId) ? ` · ${names.get(tableId)}` : ''}</p>
          )}
          {/* Bar line: the product on its own line, «2 × 600 ₸ … 1 200 ₸» under it. */}
          {orders.map((item) => (
            <div key={item.id} className="pf-item">
              <p>{item.title}</p>
              <Row
                sub
                label={item.qty != null && item.unitPrice != null ? `${item.qty} × ${money(item.unitPrice)}` : ''}
                value={money(item.amount)}
              />
            </div>
          ))}
        </Fragment>
      ))}

      <Sep />
      {discounted && <Row label="Сумма" value={money(check.subtotal)} />}
      {discounted && (
        <>
          <Row
            label={check.discount?.kind === 'PERCENT' ? `Скидка ${check.discount.value}%` : 'Скидка'}
            value={`−${money(check.discountAmount)}`}
          />
          {check.discount?.reason && <p className="pf-sub">{check.discount.reason}</p>}
        </>
      )}
      <Row label="Итого" value={money(check.total)} big />

      {(payments.length > 0 || refunds.length > 0) && (
        <>
          <Sep />
          {payments.map((p) => (
            <div key={p.id} className="pf-item">
              <Row
                label={timed ? `${METHOD_LABEL[p.method]} · ${formatClock(p.at, tz)}` : METHOD_LABEL[p.method]}
                value={money(p.amount)}
              />
              {p.tendered != null && (
                <>
                  <Row sub label="Получено" value={money(p.tendered)} />
                  <Row sub label="Сдача" value={money(p.change ?? 0)} />
                </>
              )}
            </div>
          ))}
          {refunds.map((p) => (
            <div key={p.id} className="pf-item">
              <Row label={`Возврат · ${METHOD_LABEL[p.method]}`} value={`−${money(p.amount)}`} />
              {p.reason && <p className="pf-sub">{p.reason}</p>}
            </div>
          ))}
        </>
      )}

      {(check.status === 'PAID' || check.paid > 0 || pre) && <Sep />}
      {(check.status === 'PAID' || check.paid > 0) && <Row label="Оплачено" value={money(check.paid)} strong />}
      {check.refunded > 0 && <Row label="Возвращено" value={money(check.refunded)} strong />}
      {pre && <Row label="К оплате" value={money(check.due)} big />}

      <Sep />
      <p className="pf-center pf-strong">Спасибо за игру!</p>
      <p className="pf-center pf-notice">Не является фискальным чеком</p>
    </div>
  );
}
