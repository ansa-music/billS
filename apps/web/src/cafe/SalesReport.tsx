import type { Minor, SalesReport, SalesTopLine } from '@bills/domain';
import { formatMoney, PAYMENT_METHODS } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { METHOD_LABEL } from '../cash/format.ts';
import { EmptyState, SectionCard, StatTile } from '../components.tsx';
import { plural } from '../format.ts';
import { useHub, useLive } from '../useHub.tsx';
import type { Period } from './ReportPeriod.tsx';

/** «Что продаётся» (GET /api/reports/sales): what sells, when, the average check, how guests pay. */
export function SalesSection({ period, label }: { period: Period; label: string }) {
  const { state, version } = useHub();
  const money = (a: Minor) => formatMoney(a, state.club.currency);
  const { data, error } = useLive(
    () => fetchJson<SalesReport>(`/api/reports/sales?from=${period.from}&to=${period.to}`),
    [period.from, period.to],
    version,
  );
  if (error && !data) return <p className="form-error">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;

  const paid = PAYMENT_METHODS.reduce((s, m) => s + data.byMethod[m], 0);
  return (
    <div className="report-section">
      <div className="stat-row">
        <StatTile label="Выручка" value={money(data.revenue)} detail={label} />
        <StatTile label="Заказов" value={data.orders} detail={`${data.items} позиций`} />
        <StatTile label="Средний чек" value={data.checks > 0 ? money(data.avgCheck) : '—'} detail="по оплаченным чекам" />
        <StatTile label="Чеков оплачено" value={data.checks} detail={paid > 0 ? `принято ${money(paid)}` : undefined} />
      </div>

      {data.orders === 0 ? (
        <SectionCard>
          <EmptyState icon="cup" title="Продаж за этот период нет">
            Выберите другой период.
          </EmptyState>
        </SectionCard>
      ) : (
        <>
          <div className="two-col">
            <SectionCard title="Больше всего штук">
              <TopList lines={data.topByQty} value={(l) => `${l.qty} шт`} size={(l) => l.qty} />
            </SectionCard>
            <SectionCard title="Больше всего выручки">
              <TopList lines={data.topByRevenue} value={(l) => money(l.revenue)} size={(l) => l.revenue} note={(l) => `${l.share}%`} />
            </SectionCard>
          </div>
          <div className="two-col">
            <SectionCard title="Заказы по часам" actions={<span className="hint">{label}</span>}>
              <HourBars hours={data.byHour} money={money} />
            </SectionCard>
            <SectionCard title="Как платят">
              {paid === 0 ? (
                <p className="muted">Оплат за этот период нет.</p>
              ) : (
                <ul className="cafe-top">
                  {PAYMENT_METHODS.map((m) => (
                    <li key={m}>
                      <span className="cafe-top-name">{METHOD_LABEL[m]}</span>
                      <span className="cafe-top-bar" aria-hidden="true">
                        <span style={{ width: `${Math.max(data.byMethod[m] > 0 ? 6 : 0, (data.byMethod[m] / paid) * 100)}%` }} />
                      </span>
                      <span className="cafe-top-qty">{money(data.byMethod[m])}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  );
}

function TopList({
  lines,
  value,
  size,
  note,
}: {
  lines: SalesTopLine[];
  value: (l: SalesTopLine) => string;
  size: (l: SalesTopLine) => number;
  note?: (l: SalesTopLine) => string;
}) {
  const max = Math.max(1, ...lines.map(size));
  return (
    <ol className={note ? 'cafe-top report-top report-top-wide' : 'cafe-top report-top'}>
      {lines.map((l) => (
        <li key={l.productId}>
          <span className="cafe-top-name">{l.name}</span>
          <span className="cafe-top-bar" aria-hidden="true">
            <span style={{ width: `${Math.max(6, (size(l) / max) * 100)}%` }} />
          </span>
          <span className="cafe-top-qty">
            {value(l)}
            {note && <span className="muted"> · {note(l)}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Vertical bars for the hours that had orders (and the hours between them). */
function HourBars({ hours, money }: { hours: SalesReport['byHour']; money: (a: Minor) => string }) {
  const busy = hours.filter((h) => h.orders > 0);
  if (busy.length === 0) return <p className="muted">Заказов нет.</p>;
  const first = Math.min(...busy.map((h) => h.hour));
  const last = Math.max(...busy.map((h) => h.hour));
  const shown = hours.slice(Math.max(0, Math.min(first, last - 5)), Math.min(24, Math.max(last, first + 5) + 1));
  const max = Math.max(1, ...shown.map((h) => h.orders));
  const orders = (n: number) => `${n} ${plural(n, ['заказ', 'заказа', 'заказов'])}`;
  const peak = busy.reduce((a, b) => (b.orders > a.orders ? b : a));
  return (
    <figure className="report-hours">
      <div className="report-hours-bars" role="img" aria-label={`Больше всего заказов в ${peak.hour}:00 — ${peak.orders}`}>
        {shown.map((h) => (
          <div key={h.hour} className="report-hour" title={`${h.hour}:00–${h.hour + 1}:00 · ${orders(h.orders)} · ${money(h.revenue)}`}>
            <span className="report-hour-n">{h.orders > 0 ? h.orders : ''}</span>
            <span className="report-hour-bar" data-peak={h.hour === peak.hour || undefined} style={{ height: `${(h.orders / max) * 100}%` }} />
            <span className="report-hour-label">{h.hour}</span>
          </div>
        ))}
      </div>
      <figcaption className="hint">
        Пик — {peak.hour}:00–{peak.hour + 1}:00: {orders(peak.orders)} на {money(peak.revenue)}
      </figcaption>
    </figure>
  );
}
