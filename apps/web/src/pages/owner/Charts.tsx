import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { RevenuePoint, TableStat } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { formatMinutes } from '../../format.ts';

/**
 * Plain inline SVG charts for the owner cabinet. Each one measures its box and
 * draws in pixel units (viewBox = box width), so text stays readable on a
 * phone instead of shrinking with the drawing. Colors come from the tokens in
 * owner.css; text uses currentColor.
 */

const FALLBACK_WIDTH = 720;

function useWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

import { plural } from '../../format.ts';

export { plural };

/** Bar with rounded top corners anchored to the baseline. */
function topRoundedBar(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  if (h <= 0) return '';
  return [
    `M${x},${y + h}`,
    `V${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    `H${x + w - rr}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `V${y + h}`,
    'Z',
  ].join(' ');
}

/** dd.MM from YYYY-MM-DD. */
function shortDate(date: string): string {
  const [, m = '', d = ''] = date.split('-');
  return `${d}.${m}`;
}

// ── Occupancy by hour ────────────────────────────────────────────────────────

export function OccupancyChart({ hours, date }: { hours: number[]; date: string }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const H = 220;
  const padL = 40;
  const padR = 8;
  const padT = 10;
  const padB = 28;
  const plotW = Math.max(24, width - padL - padR);
  const plotH = H - padT - padB;
  const slot = plotW / 24;
  const barW = Math.max(3, slot * 0.68);
  const y = (v: number) => padT + (1 - v) * plotH;
  const peak = hours.reduce((m, v, i) => (v > (hours[m] ?? 0) ? i : m), 0);
  const summary = hours.some((v) => v > 0)
    ? `Пик в ${peak}:00 — ${Math.round((hours[peak] ?? 0) * 100)}% столов.`
    : 'Столы в этот день не играли.';

  return (
    <div ref={box} className="chart-box">
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${H}`}
        width={width}
        height={H}
        role="img"
        aria-label={`Загрузка столов по часам за ${shortDate(date)}. ${summary}`}
      >
        <title>{`Загрузка столов по часам, ${shortDate(date)}. ${summary}`}</title>
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line className="grid" x1={padL} x2={padL + plotW} y1={y(v)} y2={y(v)} data-major={v === 0 || v === 0.5 || v === 1 ? '' : undefined} />
            {(v === 0 || v === 0.5 || v === 1) && (
              <text x={padL - 6} y={y(v) + 4} textAnchor="end">
                {Math.round(v * 100)}%
              </text>
            )}
          </g>
        ))}
        {hours.map((v, h) => {
          const share = Math.min(1, Math.max(0, v));
          const x = padL + h * slot + (slot - barW) / 2;
          const top = y(share);
          const label = `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00 — ${Math.round(share * 100)}%`;
          return (
            <g key={h} className="bar-group">
              <title>{label}</title>
              <rect className="hit" x={padL + h * slot} y={padT} width={slot} height={plotH} />
              {share > 0 && (
                <path className="bar" data-low={share < 0.5 ? '' : undefined} d={topRoundedBar(x, top, barW, plotH - (top - padT), 4)} />
              )}
              {h % 3 === 0 && (
                <text x={padL + h * slot + slot / 2} y={H - 8} textAnchor="middle">
                  {h}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Revenue for 14 days ──────────────────────────────────────────────────────

export function RevenueChart({ points, currency, withGames = true }: { points: RevenuePoint[]; currency: string; withGames?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const H = 220;
  const padL = 10;
  const padR = 10;
  const padT = 30;
  const padB = 28;
  const n = points.length;
  const plotW = Math.max(24, width - padL - padR);
  const plotH = H - padT - padB;
  const max = Math.max(1, ...points.map((p) => p.amount));
  const maxIndex = points.reduce((m, p, i) => (p.amount > (points[m]?.amount ?? 0) ? i : m), 0);
  const x = (i: number) => padL + (n > 1 ? (i * plotW) / (n - 1) : plotW / 2);
  const y = (v: number) => padT + (1 - v / max) * plotH;
  const base = padT + plotH;
  const total = points.reduce((s, p) => s + p.amount, 0);
  const summary =
    total > 0
      ? `Всего ${formatMoney(total, currency)}, лучший день ${shortDate(points[maxIndex]?.date ?? '')} — ${formatMoney(points[maxIndex]?.amount ?? 0, currency)}.`
      : 'Выручки за эти дни нет.';

  const coords = points.map((p, i) => [x(i), y(p.amount)] as const);
  const line = coords.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const area = n > 0 ? `${line} L${x(n - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z` : '';
  const slot = n > 1 ? plotW / (n - 1) : plotW;

  const mx = x(maxIndex);
  const maxAnchor = mx < padL + 60 ? 'start' : mx > padL + plotW - 60 ? 'end' : 'middle';

  return (
    <div ref={box} className="chart-box">
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${H}`}
        width={width}
        height={H}
        role="img"
        aria-label={`Выручка за 14 дней. ${summary}`}
      >
        <title>{`Выручка за 14 дней. ${summary}`}</title>
        <line className="grid" data-major="" x1={padL} x2={padL + plotW} y1={base} y2={base} />
        <line className="grid" x1={padL} x2={padL + plotW} y1={y(max / 2)} y2={y(max / 2)} />
        {n > 0 && <path className="area" d={area} />}
        {n > 0 && <path className="line" d={line} />}
        {points.map((p, i) => {
          const [px, py] = coords[i]!;
          const label = `${shortDate(p.date)} — ${formatMoney(p.amount, currency)}${withGames ? `, ${p.games} ${plural(p.games, ['игра', 'игры', 'игр'])}` : ''}`;
          const showLabel = i % 2 === (n - 1) % 2;
          return (
            <g key={p.date} className="point-group">
              <title>{label}</title>
              <rect className="hit" x={px - slot / 2} y={padT} width={slot} height={plotH + padB} />
              <circle className="dot" data-max={i === maxIndex && total > 0 ? '' : undefined} cx={px} cy={py} r={4} />
              {showLabel && (
                <text x={px} y={H - 8} textAnchor="middle">
                  {shortDate(p.date)}
                </text>
              )}
            </g>
          );
        })}
        {total > 0 && (
          <text className="label" x={mx} y={y(points[maxIndex]?.amount ?? 0) - 10} textAnchor={maxAnchor}>
            {formatMoney(points[maxIndex]?.amount ?? 0, currency)}
          </text>
        )}
      </svg>
    </div>
  );
}

// ── Top tables ───────────────────────────────────────────────────────────────

export function TopTablesChart({ tables, currency }: { tables: TableStat[]; currency: string }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const rowH = 50;
  const padX = 4;
  const H = tables.length * rowH + 4;
  const plotW = Math.max(24, width - padX * 2);
  const max = Math.max(1, ...tables.map((t) => t.revenue));
  const best = tables[0];
  const summary = best && best.revenue > 0 ? `Лучший — ${best.name}: ${formatMoney(best.revenue, currency)}.` : 'Игр в этом месяце ещё не было.';

  return (
    <div ref={box} className="chart-box">
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${H}`}
        width={width}
        height={H}
        role="img"
        aria-label={`Топ столов за месяц. ${summary}`}
      >
        <title>{`Топ столов за месяц. ${summary}`}</title>
        {tables.map((t, i) => {
          const top = i * rowH + 4;
          const w = Math.round((t.revenue / max) * plotW);
          const detail = `${formatMoney(t.revenue, currency)} · ${t.games} ${plural(t.games, ['игра', 'игры', 'игр'])} · ${formatMinutes(t.seconds)}`;
          return (
            <g key={t.tableId} className="row-group">
              <title>{`${t.name}: ${detail}`}</title>
              <rect className="hit" x={0} y={top - 2} width={width} height={rowH} />
              <text className="label" x={padX} y={top + 14}>
                {t.name}
              </text>
              <text x={padX + plotW} y={top + 14} textAnchor="end">
                {detail}
              </text>
              <rect className="track" x={padX} y={top + 24} width={plotW} height={12} rx={4} />
              {w > 0 && <rect className="hbar" x={padX} y={top + 24} width={Math.max(w, 4)} height={12} rx={4} />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
