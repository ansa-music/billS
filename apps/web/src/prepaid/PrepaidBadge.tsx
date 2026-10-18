import './prepaid.css';
import type { PrepaidView } from '@bills/domain';
import { formatMoney, isPrepaidEnding, prepaidRemainingMs } from '@bills/domain';
import { formatClock } from '../format.ts';
import { formatCountdown, formatPrepaidMinutes } from './prepaid.ts';

/**
 * A game opened for N minutes: time left, when it ends (club time) and whether it is
 * already paid. Until the lamp confirms there is no deadline yet — only «на 1 ч».
 * In the last minutes (the lamp blinks) it turns to the warning colour.
 */
export function PrepaidBadge({
  prepaid,
  serverNow,
  timezone,
  currency,
}: {
  prepaid: PrepaidView;
  serverNow: number;
  timezone: string;
  currency: string;
}) {
  const { until, minutes, amount } = prepaid;
  const duration = formatPrepaidMinutes(minutes);
  const ending = until != null && isPrepaidEnding(serverNow, until);
  const over = until != null && serverNow >= until;

  return (
    <div className="prepaid-badge" data-ending={ending || undefined} data-over={over || undefined}>
      <p className="prepaid-countdown" role="timer" aria-label="Предоплаченное время">
        {until == null ? (
          <span className="prepaid-time">на {duration}</span>
        ) : over ? (
          <span className="prepaid-time">время вышло</span>
        ) : (
          <>
            <span className="prepaid-label">осталось</span>{' '}
            <span className="prepaid-time">{formatCountdown(prepaidRemainingMs(serverNow, until))}</span>
          </>
        )}
      </p>
      {until != null && (
        <p className="prepaid-meta">
          <span>
            до {formatClock(until, timezone)} · на {duration}
          </span>
          {ending && <span className="prepaid-soon">скоро конец</span>}
          {over && <span>останавливаем…</span>}
        </p>
      )}
      {amount != null ? (
        <p className="prepaid-paid">Оплачено {formatMoney(amount, currency)}</p>
      ) : (
        <p className="prepaid-meta">оплата после игры</p>
      )}
    </div>
  );
}
