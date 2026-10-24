import { useCallback, useEffect, useState } from 'react';
import type { ClubSummary, CloudSessionView, DayStats, HourLoad, PowerOutageView, TableStats } from '@bills/domain';
import { isLive } from '@bills/domain';
import { fetchClub, fetchSessions } from './api.ts';
import {
  KIND_LABEL,
  STATUS_LABEL,
  formatClock,
  formatDateTime,
  formatDayLabel,
  formatDuration,
  formatHours,
  formatMinutes,
  localDay,
  money,
  pauseLabel,
} from './format.ts';
import type { ClubTab } from './hooks.ts';
import { clubHref, usePoll } from './hooks.ts';
import { BusinessTypeLine } from './BusinessType.tsx';
import { currencyName, zoneLabel } from './cities.ts';
import { AlertList, HubBadge, Section, StatTile, gamesLabel, loadingText } from './shared.tsx';

/** Club name, HUB status and the tabs — shared by the club page, the shifts page and the tariff editor. */
export function ClubHeader({ club, now, tab }: { club: ClubSummary; now: number; tab: ClubTab }) {
  return (
    <header className="club-page-head">
      <div>
        <a className="back" href="#/">
          ← Обзор
        </a>
        <h2>{club.name}</h2>
        <p className="muted">
          {zoneLabel(club.timezone)} · {currencyName(club.currency)}
          {club.tablesCount > 0 ? ` · столов: ${club.tablesCount}` : ''}
        </p>
        {tab === 'overview' && <BusinessTypeLine club={club} />}
      </div>
      <div className="club-page-right">
        <HubBadge hub={club.hub} now={now} />
        <nav className="tabs" aria-label="Разделы клуба">
          <a href={clubHref(club.id)} aria-current={tab === 'overview' ? 'page' : undefined}>
            Обзор
          </a>
          <a href={clubHref(club.id, 'shifts')} aria-current={tab === 'shifts' ? 'page' : undefined}>
            Смены
          </a>
          <a href={clubHref(club.id, 'tariffs')} aria-current={tab === 'tariffs' ? 'page' : undefined}>
            Тарифы
          </a>
          <a href={clubHref(club.id, 'staff')} aria-current={tab === 'staff' ? 'page' : undefined}>
            Сотрудники
          </a>
        </nav>
      </div>
    </header>
  );
}

const CHART_W = 720;
const CHART_H = 200;
const PAD_TOP = 28;
const PAD_BOTTOM = 24;

/**
 * Revenue per local day, 30 bars (paid minus refunded); the last bar is today.
 * A thin line with markers shows what was billed on «Стоп» the same day — the two differ
 * when a game is paid the next day or refunded.
 */
function RevenueChart({ days, currency }: { days: DayStats[]; currency: string }) {
  if (days.length === 0) return <p className="empty">Пока нет данных по дням</p>;
  const max = Math.max(1, ...days.map((d) => Math.max(d.revenue, d.billed)));
  const slot = CHART_W / days.length;
  const barW = Math.max(4, slot * 0.68);
  const plotH = CHART_H - PAD_TOP - PAD_BOTTOM;
  const baseY = CHART_H - PAD_BOTTOM;
  const total = days.reduce((s, d) => s + d.revenue, 0);
  const billedTotal = days.reduce((s, d) => s + d.billed, 0);
  const yOf = (v: number) => baseY - (v / max) * plotH;
  const cxOf = (i: number) => i * slot + slot / 2;
  const linePoints = days.map((d, i) => `${cxOf(i).toFixed(1)},${yOf(d.billed).toFixed(1)}`).join(' ');
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label="Выручка по дням за 30 дней: столбики — оплачено, линия — начислено">
        <line className="chart-axis" x1={0} x2={CHART_W} y1={baseY} y2={baseY} />
        <text className="chart-max" x={0} y={PAD_TOP - 10}>
          макс. {money(max, currency)}
        </text>
        {days.map((d, i) => {
          const h = (d.revenue / max) * plotH;
          const x = i * slot + (slot - barW) / 2;
          const y = baseY - h;
          const last = i === days.length - 1;
          const showLabel = last || i % 5 === 0;
          return (
            <g key={d.day} className="chart-bar" data-today={last || undefined}>
              <title>
                {formatDayLabel(d.day)}: оплачено {money(d.revenue, currency)}, начислено {money(d.billed, currency)}
                {d.refunded > 0 ? `, возвраты ${money(d.refunded, currency)}` : ''}, {d.checksPaid} чеков, {d.games} игр,{' '}
                {formatMinutes(d.playedSeconds)}
                {d.cancelledGames > 0 ? `, отменено: ${d.cancelledGames}` : ''}
                {d.alerts > 0 ? `, тревог: ${d.alerts}` : ''}
              </title>
              <rect x={x} y={y} width={barW} height={Math.max(h, d.revenue > 0 ? 2 : 0)} rx={2} />
              {d.alerts > 0 && <circle className="chart-dot" cx={x + barW / 2} cy={Math.min(y, yOf(d.billed)) - 6} r={2.5} />}
              {showLabel && (
                <text className="chart-label" x={x + barW / 2} y={CHART_H - 8} textAnchor="middle">
                  {formatDayLabel(d.day, !last && i % 10 !== 0)}
                </text>
              )}
            </g>
          );
        })}
        <polyline className="chart-line" points={linePoints} fill="none" />
        {days.map((d, i) => (
          <circle key={d.day} className="chart-mark" cx={cxOf(i)} cy={yOf(d.billed)} r={2} />
        ))}
      </svg>
      <figcaption className="muted">
        <span className="legend">
          <span className="legend-item" data-kind="bar">
            оплачено {money(total, currency)}
          </span>
          <span className="legend-item" data-kind="line">
            начислено {money(billedTotal, currency)}
          </span>
          <span className="legend-item" data-kind="dot">
            были тревоги
          </span>
        </span>
        {' · '}
        {gamesLabel(days.reduce((s, d) => s + d.games, 0))} за 30 дней
      </figcaption>
    </figure>
  );
}

/** Busy seconds per local hour over the last 7 days; the busiest hours are lit. */
function HoursChart({ hours, tablesCount }: { hours: HourLoad[]; tablesCount: number }) {
  const byHour = Array.from({ length: 24 }, (_, h) => hours.find((x) => x.hour === h) ?? { hour: h, busySeconds: 0, games: 0 });
  const max = Math.max(...byHour.map((h) => h.busySeconds));
  if (max === 0) return <p className="empty">За последние 7 дней игр не было</p>;
  const capacity = tablesCount > 0 ? tablesCount * 7 * 3600 : 0;
  const peak = byHour.filter((h) => h.busySeconds >= max * 0.8).map((h) => h.hour);
  return (
    <figure className="chart">
      <div className="hours" role="img" aria-label="Загрузка столов по часам за 7 дней">
        {byHour.map((h) => {
          const pct = capacity > 0 ? Math.round((h.busySeconds / capacity) * 100) : null;
          const title = `${String(h.hour).padStart(2, '0')}:00–${String((h.hour + 1) % 24).padStart(2, '0')}:00 · ${formatHours(h.busySeconds)} · ${h.games} игр${pct !== null ? ` · занятость ${pct} %` : ''}`;
          return (
            <div key={h.hour} className="hour" data-peak={peak.includes(h.hour) || undefined} title={title}>
              <div className="hour-track">
                <div className="hour-bar" style={{ height: `${(h.busySeconds / max) * 100}%` }} />
              </div>
              <span className="hour-label">{h.hour % 3 === 0 ? h.hour : ''}</span>
            </div>
          );
        })}
      </div>
      <figcaption className="muted">
        Пиковые часы: {peak.map((h) => `${String(h).padStart(2, '0')}:00`).join(', ')}
        {capacity > 0 ? ' · занятость считается от всех столов клуба' : ''}
      </figcaption>
    </figure>
  );
}

function TablesTable({ tables, currency }: { tables: TableStats[]; currency: string }) {
  if (tables.length === 0) return <p className="empty">Столов пока нет</p>;
  const period = 30 * 24 * 3600;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Стол</th>
          <th>Вид</th>
          <th className="num">Игры</th>
          <th className="num" title="Начислено на «Стоп» по играм стола">
            Начислено
          </th>
          <th className="num">Наиграно</th>
          <th className="num">Занятость</th>
        </tr>
      </thead>
      <tbody>
        {tables.map((t) => {
          const busy = t.byHour.reduce((s, x) => s + x, 0) || t.playedSeconds;
          const pct = Math.min(100, Math.round((busy / period) * 100));
          return (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td className="muted">{KIND_LABEL[t.kind] ?? t.kind}</td>
              <td className="num">{t.games}</td>
              <td className="num">{money(t.revenue, currency)}</td>
              <td className="num">{formatMinutes(t.playedSeconds)}</td>
              <td className="num">
                <span className="meter" title={`${pct} % времени за 30 дней`}>
                  <span className="meter-fill" style={{ width: `${pct}%` }} />
                </span>
                {pct} %
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function sessionDuration(s: CloudSessionView, now: number): string {
  if (s.billedSeconds !== null) return formatDuration(s.billedSeconds);
  if (s.startedAt === null) return '—';
  if (s.stoppedAt !== null) return formatDuration((s.stoppedAt - s.startedAt) / 1000);
  // Only a running game is still accumulating time; a cancelled one without stoppedAt has nothing to show.
  return isLive(s.status) ? formatDuration((now - s.startedAt) / 1000) : '—';
}

const PAUSE_REASON: Record<string, string> = {
  pause: 'пауза',
  transfer: 'перенос на другой стол',
  power: 'отключение света',
};

/** Why the game is cancelled / failed, or who approved the void — for the status chip's tooltip. */
function statusTitle(s: CloudSessionView): string | undefined {
  const parts: string[] = [];
  if (s.cancelReason) parts.push(`Причина: ${s.cancelReason}`);
  if (s.cancelApprovedBy) parts.push(`Подтвердил: ${s.cancelApprovedBy}`);
  if (s.status === 'PAUSED' && s.pauseReason) parts.push(PAUSE_REASON[s.pauseReason] ?? s.pauseReason);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** «на 60 мин» / «пауза 12 мин» / «на паузе с 18:05 (перенос)» — small notes next to the status. */
function SessionNotes({ s, timezone }: { s: CloudSessionView; timezone: string }) {
  const notes: string[] = [];
  if (s.prepaidMinutes !== null && s.prepaidMinutes > 0) notes.push(`на ${s.prepaidMinutes} мин`);
  if (s.pausedSeconds !== null && s.pausedSeconds > 0) notes.push(pauseLabel(s.pausedSeconds));
  if (s.status === 'PAUSED' && s.pausedAt !== null) {
    const why = s.pauseReason && s.pauseReason !== 'pause' ? ` (${PAUSE_REASON[s.pauseReason] ?? s.pauseReason})` : '';
    notes.push(`с ${formatClock(s.pausedAt, timezone)}${why}`);
  }
  if (notes.length === 0) return null;
  return <span className="cell-sub">{notes.join(' · ')}</span>;
}

function SessionsTable({
  sessions,
  timezone,
  currency,
  now,
}: {
  sessions: CloudSessionView[];
  timezone: string;
  currency: string;
  now: number;
}) {
  if (sessions.length === 0) return <p className="empty">Игр нет</p>;
  return (
    <div className="grid-wrap">
      <table className="grid">
        <thead>
          <tr>
            <th>Стол</th>
            <th>Начало</th>
            <th className="num">Длительность</th>
            <th className="num">Сумма</th>
            <th>Тариф</th>
            <th>Открыл / остановил</th>
            <th className="num">Счёт №</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} data-status={s.status}>
              <td>{s.tableName ?? s.tableId}</td>
              <td className="num">{formatDateTime(s.startedAt ?? s.requestedAt, timezone)}</td>
              <td className="num">{sessionDuration(s, now)}</td>
              <td className="num">{s.amount !== null ? money(s.amount, currency) : '—'}</td>
              <td className="muted">{s.tariffName ?? '—'}</td>
              <td>
                {s.stoppedBy && s.stoppedBy !== s.openedBy ? (
                  <span className="cell-stack">
                    <span>{s.openedBy}</span>
                    <span className="cell-sub">остановил {s.stoppedBy}</span>
                  </span>
                ) : (
                  s.openedBy
                )}
              </td>
              <td className="num">
                {s.checkNumber !== null ? (
                  <span className="cell-stack">
                    <span>№ {s.checkNumber}</span>
                    {s.paidAt !== null && <span className="cell-sub">оплачен {formatClock(s.paidAt, timezone)}</span>}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <span className="cell-stack">
                  <span className="status-chip" data-status={s.status} title={statusTitle(s)}>
                    {STATUS_LABEL[s.status] ?? s.status}
                  </span>
                  <SessionNotes s={s} timezone={timezone} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Last games, or the games of a chosen local day loaded on demand. */
function SessionsPanel({
  clubId,
  recent,
  timezone,
  currency,
  now,
}: {
  clubId: string;
  recent: CloudSessionView[];
  timezone: string;
  currency: string;
  now: number;
}) {
  const [day, setDay] = useState('');
  const [byDay, setByDay] = useState<{ day: string; sessions: CloudSessionView[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!day) {
      setByDay(null);
      return;
    }
    let cancelled = false;
    setError(null);
    fetchSessions(clubId, day)
      .then((sessions) => {
        if (!cancelled) setByDay({ day, sessions });
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [clubId, day]);

  const shown = day && byDay?.day === day ? byDay.sessions : recent;
  return (
    <Section
      title={day ? `Игры за ${formatDayLabel(day)}` : 'Последние игры'}
      aside={
        <label className="day-pick">
          <span className="muted">За день</span>
          <input type="date" value={day} max={localDay(now, timezone)} onChange={(e) => setDay(e.target.value)} />
          {day && (
            <button type="button" className="link" onClick={() => setDay('')}>
              последние
            </button>
          )}
        </label>
      }
    >
      {error && <p className="form-error">{error}</p>}
      {day && byDay?.day !== day && !error ? (
        <p className="muted">Загрузка…</p>
      ) : (
        <SessionsTable sessions={shown} timezone={timezone} currency={currency} now={now} />
      )}
    </Section>
  );
}

/** Power outages of the last 30 days: when, how long (or still going), battery critical, games auto-paused. */
function OutagesTable({ outages, timezone, now }: { outages: PowerOutageView[]; timezone: string; now: number }) {
  if (outages.length === 0) return <p className="empty">За 30 дней свет не отключали</p>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Начало</th>
          <th className="num">Длительность</th>
          <th>Батарея</th>
          <th className="num">Автопауза</th>
        </tr>
      </thead>
      <tbody>
        {outages.map((o) => (
          <tr key={o.id} data-ongoing={o.endedAt === null || undefined} data-critical={o.critical || undefined}>
            <td className="num">{formatDateTime(o.startedAt, timezone)}</td>
            <td className="num">
              {o.endedAt === null ? (
                <span className="tag tag-danger">идёт {formatMinutes((now - o.startedAt) / 1000)}</span>
              ) : (
                formatMinutes((o.endedAt - o.startedAt) / 1000)
              )}
            </td>
            <td>
              {o.critical ? (
                <span className="tag tag-danger" title="Заряд ИБП доходил до критического">
                  критично
                </span>
              ) : (
                <span className="muted">в норме</span>
              )}
            </td>
            <td className="num">{o.pausedGames > 0 ? `${gamesLabel(o.pausedGames)}` : <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ClubPage({ id }: { id: string }) {
  const load = useCallback(() => fetchClub(id), [id]);
  const { data, error } = usePoll(load, 30_000);

  if (!data) {
    return <p className="boot-inline">{loadingText(error, 'клуб')}</p>;
  }

  const { club } = data;
  // The overview's serverNow is not part of ClubDetails; the browser clock is close enough for "N мин назад".
  const now = Date.now();
  const openAlerts = data.alerts.filter((a) => a.resolvedAt === null);
  const resolved = data.alerts.filter((a) => a.resolvedAt !== null);
  const ongoingOutages = data.outages.filter((o) => o.endedAt === null).length;

  return (
    <>
      <ClubHeader club={club} now={now} tab="overview" />

      <div className="stats stats-big">
        <StatTile label="Сегодня" stats={club.today} currency={club.currency} big />
        <StatTile label="Последние 7 дней" stats={club.week} currency={club.currency} big />
        <StatTile label="С начала месяца" stats={club.month} currency={club.currency} big />
      </div>

      <div className="two-col">
        <Section title="Выручка по дням · 30 дней">
          <RevenueChart days={data.days} currency={club.currency} />
        </Section>
        <Section title="Загрузка по часам · 7 дней">
          <HoursChart hours={data.hours} tablesCount={club.tablesCount} />
        </Section>
      </div>

      <div className="two-col">
        <Section title="Столы · 30 дней">
          <TablesTable tables={data.tables} currency={club.currency} />
        </Section>
        <Section title="Тревоги" aside={openAlerts.length > 0 ? <span className="tag tag-danger">открытых: {openAlerts.length}</span> : undefined}>
          <AlertList alerts={[...openAlerts, ...resolved]} timezone={club.timezone} emptyText="Тревог не было" />
        </Section>
      </div>

      <SessionsPanel clubId={id} recent={data.recentSessions} timezone={club.timezone} currency={club.currency} now={now} />

      <Section
        title="Отключения света · 30 дней"
        aside={ongoingOutages > 0 ? <span className="tag tag-danger">сейчас нет света</span> : undefined}
      >
        <OutagesTable outages={data.outages} timezone={club.timezone} now={now} />
      </Section>
    </>
  );
}
