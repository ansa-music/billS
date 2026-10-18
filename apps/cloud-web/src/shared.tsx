import type { ReactNode } from 'react';
import type { CloudAlertView, HubStatus, PeriodStats } from '@bills/domain';
import { formatAgo, formatDateTime, formatMinutes, money } from './format.ts';

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

export function StatTile({
  label,
  stats,
  currency,
  big = false,
}: {
  label: string;
  stats: PeriodStats;
  currency: string;
  big?: boolean;
}) {
  return (
    <div className="stat" data-big={big || undefined}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{money(stats.revenue, currency)}</span>
      <span className="stat-sub">
        {gamesLabel(stats.games)} · {formatMinutes(stats.playedSeconds)}
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
