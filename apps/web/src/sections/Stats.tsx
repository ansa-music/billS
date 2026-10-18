import { useMemo, useState } from 'react';
import type { SessionView } from '@bills/domain';
import { calculateCharge, formatMoney } from '@bills/domain';
import { fetchSessions } from '../api.ts';
import { EmptyState, SectionCard, Segmented, StatTile } from '../components.tsx';
import { DAY_MS, DAY_START_HOUR, formatDay, formatSpan, workdayStart } from '../format.ts';
import { useHub, useLive } from '../useHub.ts';

type Period = 'today' | 'yesterday' | 'week';
const HOUR = 60 * 60 * 1000;

interface Range {
  from: number;
  to: number;
  days: number;
}

function ranges(period: Period, today: number): { cur: Range; prev: Range } {
  if (period === 'today') return { cur: { from: today, to: today + DAY_MS, days: 1 }, prev: { from: today - DAY_MS, to: today, days: 1 } };
  if (period === 'yesterday') {
    return { cur: { from: today - DAY_MS, to: today, days: 1 }, prev: { from: today - 2 * DAY_MS, to: today - DAY_MS, days: 1 } };
  }
  return { cur: { from: today - 6 * DAY_MS, to: today + DAY_MS, days: 7 }, prev: { from: today - 13 * DAY_MS, to: today - 6 * DAY_MS, days: 7 } };
}

/** «<1%» rather than «0%» when tables did play a little. */
const percent = (share: number) => (share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`);

const counted = (s: SessionView) => s.status === 'ACTIVE' || s.status === 'AWAITING_PAYMENT' || s.status === 'CLOSED';

function amountOf(s: SessionView, now: number): number {
  if (s.status === 'ACTIVE' && s.startedAt != null) {
    return calculateCharge(s.startedAt, Math.max(now, s.startedAt), s.tariff, s.timezone).amount;
  }
  return s.amount ?? 0;
}

function busyInterval(s: SessionView, now: number): [number, number] | null {
  if (s.startedAt == null || !counted(s)) return null;
  return [s.startedAt, s.status === 'ACTIVE' ? now : (s.stoppedAt ?? now)];
}

function metrics(sessions: SessionView[], r: Range, now: number, tableCount: number) {
  const started = sessions.filter((s) => counted(s) && s.startedAt != null && s.startedAt >= r.from && s.startedAt < r.to);
  const revenue = started.reduce((sum, s) => sum + amountOf(s, now), 0);
  const durations = started.map((s) => (s.status === 'ACTIVE' ? now - (s.startedAt ?? now) : (s.playedSeconds ?? 0) * 1000));
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const end = Math.min(r.to, now);
  let busy = 0;
  for (const s of sessions) {
    const iv = busyInterval(s, now);
    if (!iv) continue;
    busy += Math.max(0, Math.min(iv[1], end) - Math.max(iv[0], r.from));
  }
  const capacity = tableCount * Math.max(0, end - r.from);
  return { games: started.length, revenue, avg, occupancy: capacity > 0 ? busy / capacity : 0 };
}

/** Average number of busy tables in each hour of the working day (06:00 → 06:00). */
function hourly(sessions: SessionView[], r: Range, now: number): number[] {
  const buckets = new Array<number>(24).fill(0);
  const end = Math.min(r.to, now);
  for (const s of sessions) {
    const iv = busyInterval(s, now);
    if (!iv) continue;
    let t = Math.max(iv[0], r.from);
    const stop = Math.min(iv[1], end);
    while (t < stop) {
      const slotStart = r.from + Math.floor((t - r.from) / HOUR) * HOUR;
      const next = Math.min(slotStart + HOUR, stop);
      const index = Math.floor((slotStart - r.from) / HOUR) % 24;
      buckets[index] = (buckets[index] ?? 0) + (next - t) / HOUR;
      t = next;
    }
  }
  return buckets.map((v) => v / r.days);
}

function Delta({ cur, prev, money, currency }: { cur: number; prev: number; money?: boolean; currency: string }) {
  if (prev === 0 && cur === 0) return <span className="stat-detail">как и в прошлый период</span>;
  if (prev === 0) return <span className="stat-detail">в прошлый период — 0</span>;
  const diff = cur - prev;
  const pct = Math.round((diff / prev) * 100);
  return (
    <span className="stat-detail">
      <span className="stat-delta" data-dir={diff > 0 ? 'up' : diff < 0 ? 'down' : undefined}>
        {diff > 0 ? '▲' : diff < 0 ? '▼' : '='} {Math.abs(pct)}%
      </span>{' '}
      к прошлому: {money ? formatMoney(prev, currency) : prev}
    </span>
  );
}

const W = 720;
const H = 200;
const M = { top: 12, right: 8, bottom: 26, left: 34 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** Columns from one baseline; hover shows the value. Single series: no legend, the title says it. */
function ColumnChart({
  values,
  labels,
  current,
  tooltip,
  ariaLabel,
}: {
  values: number[];
  labels: string[];
  current?: number;
  tooltip: (i: number) => { title: string; text: string };
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...values, 0));
  const ticks = [0, max / 2, max];
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const slot = plotW / values.length;
  const barW = Math.min(22, slot * 0.62);
  const y = (v: number) => M.top + plotH - (v / max) * plotH;
  const labelEvery = values.length > 12 ? 3 : 1;
  const tip = hover !== null ? tooltip(hover) : null;

  return (
    <div className="chart" onPointerLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} />
            <text className="chart-tick" x={M.left - 6} y={y(t) + 4} textAnchor="end">
              {t >= 1000 ? `${(t / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}к` : Number.isInteger(t) ? t : t.toFixed(1)}
            </text>
          </g>
        ))}
        <line className="chart-axis" x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} />
        {values.map((v, i) => {
          const x = M.left + i * slot + (slot - barW) / 2;
          const top = y(v);
          const hgt = Math.max(0, y(0) - top);
          const r = Math.min(4, hgt);
          return (
            <g key={i} className="chart-col" onPointerEnter={() => setHover(i)}>
              <rect className="chart-hit" x={M.left + i * slot} y={M.top} width={slot} height={plotH} />
              {hgt > 0 && (
                <path
                  className="chart-bar"
                  data-current={i === current || undefined}
                  data-muted={hover !== null && hover !== i ? true : undefined}
                  d={`M${x} ${y(0)}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + barW - r}Q${x + barW} ${top} ${x + barW} ${top + r}V${y(0)}Z`}
                />
              )}
              {i % labelEvery === 0 && (
                <text className="chart-tick" x={x + barW / 2} y={H - 8} textAnchor="middle">
                  {labels[i]}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {tip && hover !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: `${((M.left + hover * slot + slot / 2) / W) * 100}%`,
            top: `${(y(values[hover] ?? 0) / H) * 100}%`,
          }}
        >
          <strong>{tip.title}</strong>
          {tip.text}
        </div>
      )}
    </div>
  );
}

export function StatsSection() {
  const hub = useHub();
  const { state, serverNow } = hub;
  const { timezone, currency } = state.club;
  const [period, setPeriod] = useState<Period>('today');
  const today = workdayStart(serverNow, timezone);
  const { cur, prev } = ranges(period, today);
  const data = useLive(() => fetchSessions(prev.from, cur.to), [prev.from, cur.to], hub.version);
  const sessions = data.data ?? [];
  const tableCount = state.tables.length;

  const m = metrics(sessions, cur, serverNow, tableCount);
  const p = metrics(sessions, prev, serverNow, tableCount);
  const load = useMemo(() => hourly(sessions, cur, serverNow), [sessions, cur.from, cur.to, serverNow]);
  const currentHour = period === 'today' ? Math.floor((serverNow - today) / HOUR) : undefined;
  const hourLabels = Array.from({ length: 24 }, (_, i) => String((DAY_START_HOUR + i) % 24).padStart(2, '0'));

  const perTable = state.tables.map((t) => {
    let busy = 0;
    let revenue = 0;
    const end = Math.min(cur.to, serverNow);
    for (const s of sessions) {
      if (s.tableId !== t.id) continue;
      const iv = busyInterval(s, serverNow);
      if (iv) busy += Math.max(0, Math.min(iv[1], end) - Math.max(iv[0], cur.from));
      if (counted(s) && s.startedAt != null && s.startedAt >= cur.from && s.startedAt < cur.to) revenue += amountOf(s, serverNow);
    }
    return { table: t, busy, revenue };
  });
  const maxBusy = Math.max(...perTable.map((x) => x.busy), 1);

  const perDay =
    period === 'week'
      ? Array.from({ length: 7 }, (_, i) => {
          const from = cur.from + i * DAY_MS;
          return sessions
            .filter((s) => counted(s) && s.startedAt != null && s.startedAt >= from && s.startedAt < from + DAY_MS)
            .reduce((sum, s) => sum + amountOf(s, serverNow), 0);
        })
      : null;

  return (
    <div className="page">
      <div className="page-head">
        <p className="page-lead">
          Рабочий день клуба — с 0{DAY_START_HOUR}:00 до 0{DAY_START_HOUR}:00 следующего дня. Суммы — начисленные (с идущими играми).
        </p>
        <Segmented
          label="Период"
          value={period}
          onChange={setPeriod}
          options={[
            { value: 'today', label: 'Сегодня' },
            { value: 'yesterday', label: 'Вчера' },
            { value: 'week', label: '7 дней' },
          ]}
        />
      </div>

      <div className="stat-row">
        <StatTile label="Начислено" value={formatMoney(m.revenue, currency)}>
          <Delta cur={m.revenue} prev={p.revenue} money currency={currency} />
        </StatTile>
        <StatTile label="Игр" value={m.games}>
          <Delta cur={m.games} prev={p.games} currency={currency} />
        </StatTile>
        <StatTile label="Средняя игра" value={m.avg ? formatSpan(m.avg) : '—'} detail={p.avg ? `в прошлый период ${formatSpan(p.avg)}` : undefined} />
        <StatTile label="Загрузка столов" value={percent(m.occupancy)} detail={`в прошлый период ${percent(p.occupancy)}`}>
          <span className="meter" aria-hidden="true">
            <span style={{ width: `${Math.min(100, m.occupancy * 100)}%` }} />
          </span>
        </StatTile>
      </div>

      {data.data === null ? (
        <p className="hint">{data.error ?? 'Загрузка…'}</p>
      ) : m.games === 0 && p.games === 0 ? (
        <SectionCard>
          <EmptyState icon="stats" title="Пока нечего показывать">
            Сводка появится, когда в клубе начнут играть: загрузка по часам, выручка по столам и по дням.
          </EmptyState>
        </SectionCard>
      ) : (
        <div className="two-col">
          <SectionCard title={period === 'week' ? 'Загрузка по часам — в среднем за день' : 'Загрузка по часам'}>
            <p className="hint">Сколько столов в среднем занято в каждый час</p>
            <ColumnChart
              values={load}
              labels={hourLabels}
              {...(currentHour !== undefined ? { current: currentHour } : {})}
              ariaLabel="Загрузка столов по часам"
              tooltip={(i) => ({
                title: `${hourLabels[i]}:00–${hourLabels[(i + 1) % 24]}:00`,
                text: `${(load[i] ?? 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} из ${tableCount} столов`,
              })}
            />
          </SectionCard>

          <SectionCard title="По столам">
            <ul className="hbars">
              {perTable.map(({ table, busy, revenue }) => (
                <li key={table.id} className="hbar">
                  <span className="hbar-name">{table.name}</span>
                  <span className="hbar-track" title={`${table.name}: ${formatSpan(busy)}`}>
                    <span className="hbar-fill" style={{ width: `${(busy / maxBusy) * 100}%` }} />
                  </span>
                  <span className="hbar-value">
                    {busy ? formatSpan(busy) : '—'} · {formatMoney(revenue, currency)}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>

          {perDay && (
            <SectionCard title="Начислено по дням">
              <ColumnChart
                values={perDay.map((v) => v / 100)}
                labels={perDay.map((_, i) => formatDay(cur.from + i * DAY_MS + HOUR, timezone))}
                current={6}
                ariaLabel="Начислено по дням"
                tooltip={(i) => ({
                  title: formatDay(cur.from + i * DAY_MS + HOUR, timezone),
                  text: formatMoney(perDay[i] ?? 0, currency),
                })}
              />
            </SectionCard>
          )}
        </div>
      )}
    </div>
  );
}
