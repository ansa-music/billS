import { useEffect, useRef, useState } from 'react';
import type { Action, OwnerSummary } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { useAuth } from '../auth.ts';
import { formatClock } from '../format.ts';
import { Link } from '../router.tsx';
import { Empty, Loading, Page, Section, Toast, formatDateTime, localDate, useToast } from '../ui.tsx';
import { useCommands, useHub, useServerNow } from '../useHub.tsx';
import { businessOf } from '../cafe/cafe.ts';
import { InsightsPanel } from '../insights/InsightsPanel.tsx';
import { OccupancyChart, RevenueChart, TopTablesChart, plural } from './owner/Charts.tsx';
import { CABINET_URL } from './settings/LicenseSection.tsx';
import './owner.css';

/**
 * Manager's summary of this branch: revenue, table load, alerts. Numbers come
 * from GET /api/reports/summary; alerts from the live state. Other branches
 * are in the TS cabinet. In a coffee shop: revenue only, in cafe words.
 */

type QuickLink = { to: string; query?: Record<string, string>; label: string; action: Action; cafe?: boolean; billiards?: boolean };

const QUICK_LINKS: QuickLink[] = [
  { to: '/settings', label: 'Настройки', action: 'settings.view' },
  { to: '/settings', query: { tab: 'tariffs' }, label: 'Тарифы', action: 'tariffs.edit', billiards: true },
  { to: '/staff', label: 'Сотрудники', action: 'staff.view' },
  { to: '/journal', label: 'Журнал действий', action: 'audit.view' },
  { to: '/bar', label: 'Бар и меню', action: 'catalog.edit', billiards: true },
  { to: '/bar', label: 'Меню', action: 'catalog.edit', cafe: true },
  { to: '/stats', label: 'Отчёты за смену', action: 'reports.view', cafe: true },
  { to: '/apps', label: 'Приложение на телефон и кассу', action: 'reports.view' },
];

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
  const cafe = businessOf(state?.settings) === 'cafe';
  const links = QUICK_LINKS.filter((l) => can(l.action) && !(cafe ? l.billiards : l.cafe));

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
  const count = (n: number) => (cafe ? undefined : `${n} ${plural(n, ['игра', 'игры', 'игр'])}`);

  return (
    <Page
      title={cafe ? 'Выручка' : 'Кабинет управляющего'}
      wide
      subtitle={
        summary && tz
          ? `${isToday ? 'Сегодня' : 'Данные за ' + formatDay(summary.date)} · обновлено ${formatClock(summary.generatedAt, tz)}`
          : cafe
            ? 'Выручка кофейни по дням.'
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
          <strong className="owner-club-name">{club?.name ?? ''}</strong>
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
        <p className="owner-note">
          Здесь — это заведение. Все филиалы вместе — в{' '}
          <a href={CABINET_URL} target="_blank" rel="noreferrer">
            кабинете TS
          </a>
          .
        </p>
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
            <Stat label={isToday ? 'Выручка сегодня' : `Выручка за ${formatDay(summary.date)}`} value={formatMoney(summary.revenue.today, currency)} note={count(summary.games.today)} />
            <Stat label="Выручка за неделю" value={formatMoney(summary.revenue.week, currency)} note={count(summary.games.week)} />
            <Stat label="Выручка за месяц" value={formatMoney(summary.revenue.month, currency)} note={count(summary.games.month)} />
            {!cafe && (
              <>
                <Stat label={isToday ? 'Игр сегодня' : 'Игр за день'} value={String(summary.games.today)} note="завершённых" />
                <Stat label="Средний чек" value={formatMoney(summary.avgCheck, currency)} note="время + бар" />
                <Stat label="Сейчас играют" value={String(summary.liveGames)} note={`из ${state?.tables.length ?? '—'} столов`} tone={summary.liveGames > 0 ? 'accent' : undefined} />
                <Stat label="Ожидают оплаты" value={String(summary.unpaidGames)} note={formatMoney(summary.unpaidAmount, currency)} tone={summary.unpaidGames > 0 ? 'warn' : undefined} />
              </>
            )}
            <Stat label="Открытых тревог" value={String(summary.openAlerts)} note={summary.openAlerts > 0 ? 'нужно внимание' : 'всё спокойно'} tone={summary.openAlerts > 0 ? 'danger' : undefined} />
          </div>

          {cafe ? (
            <Section title="Выручка за 14 дней" aside={<span className="muted">{formatDay(summary.revenueByDay[0]?.date ?? summary.date)} — {formatDay(summary.date)}</span>}>
              <RevenueChart points={summary.revenueByDay} currency={currency} withGames={false} />
            </Section>
          ) : (
          <>
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
        </>
      )}

      <InsightsPanel frame="panel" />

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
          {links.length > 0 ? (
            <nav className="owner-links" aria-label="Быстрые переходы">
              {links.map((l) => (
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
