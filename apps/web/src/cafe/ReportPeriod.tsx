import { useState } from 'react';
import { localDate } from '../ui.tsx';
import { useHub } from '../useHub.tsx';

/**
 * The period of a cafe report: today, the last 7 or 30 days (today included) or any dates.
 * Dates are the club's local calendar days, YYYY-MM-DD, `to` inclusive — what
 * GET /api/reports/profit and /sales take.
 */

export type PeriodPreset = 'today' | '7' | '30' | 'custom';

export interface Period {
  from: string;
  to: string;
}

/** Calendar arithmetic on YYYY-MM-DD, no time zone involved. */
export function shiftDate(date: string, days: number): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function periodOf(preset: Exclude<PeriodPreset, 'custom'>, today: string): Period {
  if (preset === 'today') return { from: today, to: today };
  return { from: shiftDate(today, -(Number(preset) - 1)), to: today };
}

/** 12.10 or 12.10.2026 when the year is not this one. */
export function dayLabel(date: string, today: string): string {
  const [y = '', m = '', d = ''] = date.split('-');
  return y === today.slice(0, 4) ? `${d}.${m}` : `${d}.${m}.${y}`;
}

export function periodLabel(p: Period, today: string): string {
  if (p.from === p.to) return p.to === today ? 'сегодня' : dayLabel(p.to, today);
  return `${dayLabel(p.from, today)} — ${dayLabel(p.to, today)}`;
}

const PRESETS: Array<{ id: PeriodPreset; label: string }> = [
  { id: 'today', label: 'Сегодня' },
  { id: '7', label: '7 дней' },
  { id: '30', label: '30 дней' },
  { id: 'custom', label: 'Период' },
];

/** The picker and the period it stands for; the same period for every tab of «Отчёты». */
export function usePeriod(): { today: string; preset: PeriodPreset; period: Period; setPreset: (p: PeriodPreset) => void; setCustom: (p: Period) => void } {
  const { state, serverNow } = useHub();
  const today = localDate(serverNow, state.club.timezone);
  const [preset, setPreset] = useState<PeriodPreset>('today');
  const [custom, setCustom] = useState<Period>(() => ({ from: shiftDate(today, -6), to: today }));
  const period = preset === 'custom' ? custom : periodOf(preset, today);
  return { today, preset, period, setPreset, setCustom };
}

export function PeriodPicker({
  today,
  preset,
  period,
  setPreset,
  setCustom,
}: ReturnType<typeof usePeriod>) {
  return (
    <div className="report-period">
      <div className="report-period-presets" role="radiogroup" aria-label="Период">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" role="radio" className="chip" aria-checked={p.id === preset} aria-pressed={p.id === preset} onClick={() => setPreset(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="report-period-dates">
          <label className="field">
            <span>С</span>
            <input
              type="date"
              value={period.from}
              max={period.to}
              onChange={(e) => e.target.value && setCustom({ from: e.target.value, to: period.to < e.target.value ? e.target.value : period.to })}
            />
          </label>
          <label className="field">
            <span>По</span>
            <input
              type="date"
              value={period.to}
              min={period.from}
              max={today}
              onChange={(e) => e.target.value && setCustom({ from: period.from > e.target.value ? e.target.value : period.from, to: e.target.value })}
            />
          </label>
        </div>
      )}
    </div>
  );
}
