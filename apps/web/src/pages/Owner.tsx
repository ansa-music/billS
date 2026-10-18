import { useEffect, useRef, useState } from 'react';
import type { Action, OwnerSummary } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useAuth } from '../auth.ts';
import { formatClock } from '../format.ts';
import { Link } from '../router.tsx';
import { Empty, Loading, Page, Section, Toast, formatDateTime, localDate, useToast } from '../ui.tsx';
import { useCommands, useHub, useServerNow } from '../useHub.tsx';
import { OccupancyChart, RevenueChart, TopTablesChart, plural } from './owner/Charts.tsx';
import './owner.css';

/**
 * Owner cabinet: one club today, the multi-club frame of stage 6 already in
 * place. Numbers come from GET /api/reports/summary; alerts from the live state.
 */

const QUICK_LINKS: Array<{ to: string; query?: Record<string, string>; label: string; action: Action }> = [
  { to: '/settings', label: 'Настройки клуба', action: 'settings.view' },
  { to: '/settings', query: { tab: 'tariffs' }, label: 'Тарифы', action: 'tariffs.edit' },
  { to: '/staff', label: 'Сотрудники', action: 'staff.view' },
  { to: '/journal', label: 'Журнал действий', action: 'audit.view' },
  { to: '/bar', label: 'Бар и меню', action: 'catalog.edit' },
];

type ClubKey = 'current' | 'mock-2' | 'mock-3';

export function OwnerPage() {
  const { state, online } = useHub();
  const { can } = useAuth();
  const serverNow = useServerNow(1000);
  const { toast, show, clear } = useToast();
  const { run, isBusy } = useCommands(show);

  const club = state?.club ?? null;
  const tz = club?.timezone ?? null;
  const currency = club?.currency ?? 'KZT';
  const today = tz ? localDate(serverNow, tz) : null;

  const [picked, setPicked] = useState<string | null>(null);
  const date = picked ?? today;
  const [clubKey, setClubKey] = useState<ClubKey>('current');

  const [summary, setSummary] = useState<OwnerSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const request = useRef(0);

  // Cheap refetch triggers: the clock crossing a minute, a game stopped or paid, an alert raised or closed.
  const minute = Math.floor(serverNow / 60_000);
  const unpaidCount = state?.unpaid.length ?? 0;
  const alertCount = state?.alerts.length ?? 0;

  useEffect(() => {
    if (!date) return;
    const id = ++request.current;
    setLoading(true);
    fetchJson<OwnerSummary>(`/api/reports/summary?date=${encodeURIComponent(date)}`)
      .then((s) => {
        if (id !== request.current) return;
        setSummary(s);
        setError(null);
      })
      .catch((e: Error) => {
        if (id !== request.current) return;
        setError(e.message);
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
  }, [date, minute, unpaidCount, alertCount, tick]);

  const isToday = date !== null && date === today;
  const clubs: Array<{ key: ClubKey; label: string; disabled: boolean }> = [
    { key: 'current', label: club?.name ?? 'Клуб', disabled: false },
    { key: 'mock-2', label: 'Клуб 2 (скоро)', disabled: true },
    { key: 'mock-3', label: 'Клуб 3 (скоро)', disabled: true },
  ];

  return (
    <Page
      title="Кабинет владельца"
      wide
      subtitle={
        summary && tz
          ? `${isToday ? 'Сегодня' : 'Данные за ' + formatDay(summary.date)} · обновлено ${formatClock(summary.generatedAt, tz)}`
          : 'Сводка по клубу: выручка, загрузка столов, тревоги.'
      }
      actions={
        <>
          <button type="button" className="btn btn-small" onClick={() => setPicked(null)} disabled={isToday || !today}>
            Сегодня
          </button>
          <button type="button" className="btn btn-small" onClick={() => setTick((t) => t + 1)} disabled={loading || !date}>
            {loading ? 'Обновляем…' : 'Обновить'}
          </button>
        </>
      }
    >
      <Section>
        <div className="owner-toolbar">
          <div className="owner-clubs" role="group" aria-label="Клуб">
            {clubs.map((c) => (
              <button
                key={c.key}
                type="button"
                className="chip"
                aria-pressed={c.key === clubKey}
                disabled={c.disabled}
                title={c.disabled ? 'Подключение филиалов — этап 6' : undefined}
                onClick={() => setClubKey(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <label className="owner-date">
            <span className="muted">Дата</span>
            <input
              type="date"
              value={date ?? ''}
              max={today ?? undefined}
              disabled={!today}
              onChange={(e) => setPicked(e.target.value || null)}
              aria-label="Дата сводки"
            />
          </label>
        </div>
        <p className="owner-note">Сеть клубов: подключение филиалов — этап 6. Сейчас показан один клуб.</p>
      </Section>

      {error && (
        <Section>
          <p className="owner-error" role="alert">
            <span>Не удалось загрузить сводку: {error}</span>
            <button type="button" className="btn btn-small" onClick={() => setTick((t) => t + 1)}>
              Повторить
            </button>
          </p>
        </Section>
      )}

      {!summary && !error && <Loading online={online} />}

      {summary && (
        <>
          <div className="stats" aria-busy={loading || undefined}>
            <Stat label={isToday ? 'Выручка сегодня' : `Выручка за ${formatDay(summary.date)}`} value={formatMoney(summary.revenue.today, currency)} note={`${summary.games.today} ${plural(summary.games.today, ['игра', 'игры', 'игр'])}`} />
            <Stat label="Выручка за неделю" value={formatMoney(summary.revenue.week, currency)} note={`${summary.games.week} ${plural(summary.games.week, ['игра', 'игры', 'игр'])}`} />
            <Stat label="Выручка за месяц" value={formatMoney(summary.revenue.month, currency)} note={`${summary.games.month} ${plural(summary.games.month, ['игра', 'игры', 'игр'])}`} />
            <Stat label={isToday ? 'Игр сегодня' : 'Игр за день'} value={String(summary.games.today)} note="завершённых" />
            <Stat label="Средний чек" value={formatMoney(summary.avgCheck, currency)} note="время + бар" />
            <Stat label="Сейчас играют" value={String(summary.liveGames)} note={`из ${state?.tables.length ?? '—'} столов`} tone={summary.liveGames > 0 ? 'accent' : undefined} />
            <Stat label="Ожидают оплаты" value={String(summary.unpaidGames)} note={formatMoney(summary.unpaidAmount, currency)} tone={summary.unpaidGames > 0 ? 'warn' : undefined} />
            <Stat label="Открытых тревог" value={String(summary.openAlerts)} note={summary.openAlerts > 0 ? 'нужно внимание' : 'всё спокойно'} tone={summary.openAlerts > 0 ? 'danger' : undefined} />
          </div>

          <div className="grid-2">
            <Section title="Загрузка столов по часам" aside={<span className="muted">{formatDay(summary.date)}</span>}>
              <OccupancyChart hours={summary.occupancyByHour} date={summary.date} />
            </Section>
            <Section title="Выручка за 14 дней" aside={<span className="muted">{formatDay(summary.revenueByDay[0]?.date ?? summary.date)} — {formatDay(summary.date)}</span>}>
              <RevenueChart points={summary.revenueByDay} currency={currency} />
            </Section>
          </div>

          <Section title="Топ столов за месяц" aside={<span className="muted">время игры, без бара</span>}>
            {summary.topTables.length === 0 ? (
              <Empty>Активных столов нет.</Empty>
            ) : (
              <TopTablesChart tables={summary.topTables} currency={currency} />
            )}
          </Section>
        </>
      )}

      <div className="grid-2">
        <Section title="Тревоги" aside={state && state.alerts.length > 0 ? <span className="tag tag-danger">{state.alerts.length}</span> : undefined}>
          {!state ? (
            <Loading online={online} />
          ) : state.alerts.length === 0 ? (
            <Empty>Открытых тревог нет.</Empty>
          ) : (
            <ul className="list owner-alerts">
              {state.alerts.map((a) => {
                const table = a.tableId ? state.tables.find((t) => t.id === a.tableId) : undefined;
                return (
                  <li key={a.id}>
                    <span className="alert-time">{tz ? formatDateTime(a.at, tz) : ''}</span>
                    <span className="grow">
                      {table && <span className="alert-table">{table.name}</span>}
                      {a.message}
                    </span>
                    {can('alert.resolve') && (
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={isBusy(`alert:${a.id}`)}
                        onClick={() => void run(`alert:${a.id}`, `/api/alerts/${a.id}/resolve`)}
                      >
                        Принято
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title="Быстрые переходы">
          {QUICK_LINKS.some((l) => can(l.action)) ? (
            <nav className="owner-links" aria-label="Быстрые переходы">
              {QUICK_LINKS.filter((l) => can(l.action)).map((l) => (
                <Link key={l.label} to={l.to} query={l.query}>
                  {l.label}
                </Link>
              ))}
            </nav>
          ) : (
            <Empty>Для вашей роли разделов нет.</Empty>
          )}
        </Section>
      </div>

      <Toast message={toast} onClose={clear} />
    </Page>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'danger' | 'warn' | 'accent';
}) {
  return (
    <div
      className="stat"
      data-danger={tone === 'danger' ? '' : undefined}
      data-warn={tone === 'warn' ? '' : undefined}
      data-accent={tone === 'accent' ? '' : undefined}
    >
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note && <span className="stat-note">{note}</span>}
    </div>
  );
}

/** 12.10.2026 from YYYY-MM-DD. */
function formatDay(date: string): string {
  const [y = '', m = '', d = ''] = date.split('-');
  return `${d}.${m}.${y}`;
}
