import type { ReactNode } from 'react';
import type { CloudAlertView, HubStatus, PaymentTotals, PeriodStats } from '@bills/domain';
import { differenceLabel, formatAgo, formatDateTime, formatMinutes, formatSigned, money } from './format.ts';

/** Placeholder text for a page that has nothing loaded yet. */
export function loadingText(error: Error | null, what: string): string {
  if (!error) return 'Загрузка…';
  if ((error as { code?: string }).code === 'OFFLINE') return 'Ждём связи с облаком…';
  return `Не удалось загрузить ${what}: ${error.message}`;
}

/** Shown while the cabinet cannot reach the cloud; the last loaded numbers stay on screen. */
export function OfflineBanner({ online }: { online: boolean }) {
  if (online) return null;
  return (
    <div className="offline" role="status">
      <span className="offline-dot" aria-hidden="true" />
      <p className="offline-text">
        <strong>Нет связи с облаком.</strong> Показаны последние полученные данные — страница обновится, как только
        связь восстановится.
      </p>
    </div>
  );
}

/** "на связи" / "нет связи 12 мин" / "не подключён" plus the "ждёт настройки" badge. */
export function HubBadge({ hub, now }: { hub: HubStatus | null; now: number }) {
  if (!hub) {
    return (
      <span className="hub" data-hub="none">
        HUB не подключён
      </span>
    );
  }
  const title = hub.lastSeenAt ? `Последний раз на связи: ${formatDateTime(hub.lastSeenAt, 'UTC')} UTC` : undefined;
  return (
    <span className="hub-wrap">
      <span className="hub" data-hub={hub.online ? 'online' : 'offline'} title={title}>
        {hub.online
          ? 'HUB на связи'
          : hub.lastSeenAt
            ? `Нет связи с HUB ${formatAgo(now - hub.lastSeenAt)}`
            : 'HUB ещё не выходил на связь'}
      </span>
      {hub.pendingSettings && (
        <span className="tag tag-warn" title="Облако отправило новые настройки, HUB их ещё не забрал">
          ждёт настройки
        </span>
      )}
    </span>
  );
}

/**
 * «нал 12 000 ₸ · карта 8 000 ₸ · QR 1 500 ₸» — money by payment method.
 * Zero methods are dropped (all three are shown when everything is zero); `total` adds «итого».
 */
export function MethodSplit({
  totals,
  currency,
  total = false,
  className,
}: {
  totals: PaymentTotals;
  currency: string;
  total?: boolean;
  className?: string;
}) {
  const parts: Array<{ key: string; label: string; value: number }> = [
    { key: 'cash', label: 'нал', value: totals.cash },
    { key: 'card', label: 'карта', value: totals.card },
    { key: 'qr', label: 'QR', value: totals.qr },
  ];
  const shown = parts.some((p) => p.value !== 0) ? parts.filter((p) => p.value !== 0) : parts;
  return (
    <span className={className ? `split ${className}` : 'split'}>
      {shown.map((p) => (
        <span key={p.key} className="split-item" data-method={p.key}>
          <span className="split-label">{p.label}</span> {money(p.value, currency)}
        </span>
      ))}
      {total && (
        <span className="split-item" data-method="total">
          <span className="split-label">итого</span> {money(totals.total, currency)}
        </span>
      )}
    </span>
  );
}

/** Z report difference: green «сходится», red «излишек +X» / «недостача −X»; «—» while the shift is open. */
export function Difference({
  value,
  currency,
  words = true,
}: {
  value: number | null;
  currency: string;
  words?: boolean;
}) {
  if (value === null) return <span className="muted">—</span>;
  const state = value === 0 ? 'ok' : value > 0 ? 'surplus' : 'shortage';
  return (
    <span className="diff" data-diff={state} title={differenceLabel(value, currency)}>
      {words ? differenceLabel(value, currency) : formatSigned(value, currency)}
    </span>
  );
}

export function checksLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11 ? 'чек' : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? 'чека' : 'чеков';
  return `${n} ${word}`;
}

/**
 * Period tile: revenue by payments (what the till took) on top, billed-on-stop underneath,
 * the cash/card/QR split, refunds when any, average check and the check count.
 * `compact` (club cards) drops the games line and the average check.
 */
export function StatTile({
  label,
  stats,
  currency,
  big = false,
  compact = false,
}: {
  label: string;
  stats: PeriodStats;
  currency: string;
  big?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="stat" data-big={big || undefined} data-compact={compact || undefined}>
      <span className="stat-label">{label}</span>
      <span className="stat-value" title="Оплачено за период минус возвраты">
        {money(stats.revenue, currency)}
      </span>
      <span className="stat-sub" title="Начислено на «Стоп» за период (без отменённых игр)">
        начислено {money(stats.billed, currency)}
      </span>
      <MethodSplit totals={stats.paid} currency={currency} className="stat-split" />
      {stats.refunded > 0 && (
        <span className="stat-sub stat-refund">возвраты {formatSigned(-stats.refunded, currency)}</span>
      )}
      <span className="stat-sub">
        {checksLabel(stats.checksPaid)}
        {!compact && stats.checksPaid > 0 ? ` · средний чек ${money(stats.averageCheck, currency)}` : ''}
        {!compact ? ` · ${gamesLabel(stats.games)} · ${formatMinutes(stats.playedSeconds)}` : ''}
        {stats.cancelledGames > 0 ? ` · отменено ${stats.cancelledGames}` : ''}
      </span>
    </div>
  );
}

export function gamesLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11 ? 'игра' : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? 'игры' : 'игр';
  return `${n} ${word}`;
}

export function AlertList({
  alerts,
  timezone,
  showClub = false,
  emptyText = 'Открытых тревог нет',
}: {
  alerts: CloudAlertView[];
  timezone?: string;
  showClub?: boolean;
  emptyText?: string;
}) {
  if (alerts.length === 0) return <p className="empty">{emptyText}</p>;
  return (
    <ul className="alert-list">
      {alerts.map((a) => (
        <li key={a.id} className="alert" data-resolved={a.resolvedAt ? '' : undefined}>
          <span className="alert-time">{formatDateTime(a.at, timezone ?? 'UTC')}</span>
          <span className="alert-text">
            {showClub && <strong>{a.clubName} · </strong>}
            {a.tableName && <strong>{a.tableName}: </strong>}
            {a.message}
          </span>
          <span className="alert-kind muted">{a.resolvedAt ? `закрыта ${formatDateTime(a.resolvedAt, timezone ?? 'UTC')}` : a.kind}</span>
        </li>
      ))}
    </ul>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}
