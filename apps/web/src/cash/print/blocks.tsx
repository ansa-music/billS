import type { ReactNode } from 'react';
import { formatClock } from '../../format.ts';

/** Label on the left (wraps), amount on the right (never wraps). */
export function Row({
  label,
  value,
  strong,
  big,
  sub,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
  /** «Итого», «К оплате». */
  big?: boolean;
  /** Indented detail under the line above: «Получено», «Сдача». */
  sub?: boolean;
}) {
  const cls = ['pf-row', strong && 'pf-strong', big && 'pf-big', sub && 'pf-sub'].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <span className="pf-label">{label}</span>
      <span className="pf-value">{value}</span>
    </div>
  );
}

/** «Кассир: Иванова» — a text line that wraps as a whole. */
export function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="pf-text">
      {label}: {children}
    </p>
  );
}

export function Sep() {
  return <hr className="pf-sep" />;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** 18.10.2026 18:05 in the club's time zone. */
export function formatStamp(epochMs: number, timeZone: string): string {
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric' });
    dateFormatters.set(timeZone, f);
  }
  return `${f.format(epochMs)} ${formatClock(epochMs, timeZone)}`;
}
