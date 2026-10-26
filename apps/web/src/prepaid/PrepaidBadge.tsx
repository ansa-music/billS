import './prepaid.css';
import type { PrepaidView } from '@bills/domain';
import { formatMoney, isPrepaidEnding, prepaidRemainingMs } from '@bills/domain';
import { formatClock } from '../format.ts';
import { useHub } from '../useHub.tsx';
import { formatCountdown, formatPrepaidMinutes } from './prepaid.ts';

/**
 * A game opened for N minutes: time left, when it ends (club time) and whether it is
 * already paid. Until the lamp confirms there is no deadline yet — only «на 1 ч».
 * In the last minutes (the lamp blinks) it turns to the warning colour.
 */
export function PrepaidBadge({
  prepaid,
  serverNow,
  pausedAt = null,
  timezone,
  currency,
}: {
  prepaid: PrepaidView;
  serverNow: number;
  /** The game is paused since then: the time left is frozen, the deadline moves when play resumes. */
  pausedAt?: number | null;
  timezone: string;
  currency: string;
}) {
  const { until, minutes, amount } = prepaid;
  const extensionDue = useExtensionDue(prepaid);
  const duration = formatPrepaidMinutes(minutes);
  const clock = pausedAt ?? serverNow;
  const ending = until != null && isPrepaidEnding(clock, until);
  const over = until != null && clock >= until;

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
            <span className="prepaid-time">{formatCountdown(prepaidRemainingMs(clock, until))}</span>
          </>
        )}
      </p>
      {until != null && (
        <p className="prepaid-meta">
          <span>
            {pausedAt != null ? 'на паузе · ' : ''}до {formatClock(until, timezone)} · на {duration}
          </span>
          {ending && <span className="prepaid-soon">скоро конец</span>}
          {over && <span>останавливаем…</span>}
        </p>
      )}
      {amount != null ? (
        <>
          <p className="prepaid-paid">Оплачено {formatMoney(amount - extensionDue, currency)}</p>
          {extensionDue > 0 && <p className="prepaid-meta prepaid-due">продление {formatMoney(extensionDue, currency)} — к оплате на кассе</p>}
        </>
      ) : (
        <p className="prepaid-meta">оплата после игры</p>
      )}
    </div>
  );
}

/**
 * A game paid upfront whose extension («Продление») still waits on an open check: how much.
 * `prepaid.amount` is the price of all the prepaid time, extensions included.
 */
function useExtensionDue(prepaid: PrepaidView): number {
  const { state } = useHub();
  if (prepaid.checkId == null) return 0;
  const sessionId = state.tables.find((t) => t.session?.prepaid?.checkId === prepaid.checkId)?.session?.id;
  if (!sessionId) return 0;
  let due = 0;
  for (const c of state.checks) {
    for (const i of c.items) if (i.kind === 'EXTENSION' && i.sessionId === sessionId) due += i.amount;
  }
  return due;
}
