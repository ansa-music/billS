import { useMemo, useState } from 'react';
import type { TariffConfig } from '@bills/domain';
import { calculateCharge, formatMoney, priceAt, zonedParts } from '@bills/domain';
import { SectionCard } from '../components.tsx';
import { formatClock, formatSpan } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useHub } from '../useHub.ts';

const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const SEQ = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];
const MIN = 60_000;

/** Monday 00:00 of the current week in the club's time zone. */
function weekStart(now: number, tz: string): number {
  const p = zonedParts(now, tz);
  return now - ((p.weekday - 1) * 1440 + p.minuteOfDay) * MIN - p.second * 1000 - p.millisecond;
}

/** Club wall clock ↔ epoch, assuming the offset of "now" (clubs here have no DST). */
function clubOffsetMs(now: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!);
  return wall - Math.floor(now / MIN) * MIN;
}

function toInputValue(epoch: number, offset: number): string {
  return new Date(epoch + offset).toISOString().slice(0, 16);
}

function fromInputValue(value: string, offset: number): number | null {
  const ms = Date.parse(`${value}:00Z`);
  return Number.isFinite(ms) ? ms - offset : null;
}

function WeekMap({
  tariff,
  levels,
  now,
  tz,
  currency,
}: {
  tariff: TariffConfig;
  levels: number[];
  now: number;
  tz: string;
  currency: string;
}) {
  const start = weekStart(now, tz);
  const p = zonedParts(now, tz);
  const nowCell = { day: p.weekday - 1, slot: Math.floor(p.minuteOfDay / 30) };
  const color = (price: number) => {
    const i = levels.indexOf(price);
    if (levels.length <= 1) return SEQ[2];
    return SEQ[Math.round((i / (levels.length - 1)) * (SEQ.length - 1))];
  };
  const rows = DAYS.map((_, d) =>
    Array.from({ length: 48 }, (_, s) => {
      const t = start + (d * 1440 + s * 30 + 1) * MIN;
      return { s, ...priceAt(t, tariff, tz) };
    }),
  );
  const legend = [
    ...new Map(rows.flat().map((c) => [`${c.label}|${c.pricePerHour}`, { label: c.label, pricePerHour: c.pricePerHour }])).values(),
  ].sort((a, b) => a.pricePerHour - b.pricePerHour);

  return (
    <div className="week-wrap">
      <div className="week" role="img" aria-label="Цена по дням недели и часам">
        {rows.map((cells, d) => (
          <div key={d} className="week-row" style={{ display: 'contents' }}>
            <span className="week-day" data-today={d === nowCell.day || undefined}>
              {DAYS[d]}
            </span>
            <div className="week-cells">
              {cells.map((c) => {
                const h = String(Math.floor(c.s / 2)).padStart(2, '0');
                const m = c.s % 2 ? '30' : '00';
                return (
                  <span
                    key={c.s}
                    className="week-cell"
                    data-now={(d === nowCell.day && c.s === nowCell.slot) || undefined}
                    style={{ background: color(c.pricePerHour) }}
                    title={`${DAYS[d]} ${h}:${m} — ${c.label}, ${formatMoney(c.pricePerHour, currency)}/ч`}
                  />
                );
              })}
            </div>
          </div>
        ))}
        <div className="week-hours" aria-hidden="true">
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <span key={h}>{String(h).padStart(2, '0')}</span>
          ))}
        </div>
      </div>
      <ul className="legend">
        {legend.map((l) => (
          <li key={`${l.label}${l.pricePerHour}`}>
            <span className="swatch" style={{ background: color(l.pricePerHour) }} />
            {l.label} — {formatMoney(l.pricePerHour, currency)}/ч
          </li>
        ))}
      </ul>
    </div>
  );
}

function Calculator({ now }: { now: number }) {
  const { state } = useHub();
  const { timezone, currency } = state.club;
  const offset = useMemo(() => clubOffsetMs(now, timezone), [Math.floor(now / 3_600_000), timezone]);
  const [tariffId, setTariffId] = useState(state.tariffs[0]?.id ?? '');
  const [start, setStart] = useState(() => toInputValue(Math.floor(now / (5 * MIN)) * 5 * MIN, offset));
  const [minutes, setMinutes] = useState(60);
  const tariff = state.tariffs.find((t) => t.id === tariffId);
  const from = fromInputValue(start, offset);
  const charge = tariff && from !== null ? calculateCharge(from, from + minutes * MIN, tariff.config, timezone) : null;
  const change = (d: number) => setMinutes((m) => Math.min(24 * 60, Math.max(5, m + d)));

  return (
    <SectionCard
      title={
        <>
          <Icon name="calc" size={18} /> Калькулятор игры
        </>
      }
    >
      <p className="hint">Посчитать заранее, сколько будет стоить игра — например, когда гости спрашивают по телефону.</p>
      <div className="calc">
        <div className="calc-fields">
          <label className="field">
            Тариф
            <select className="select" value={tariffId} onChange={(e) => setTariffId(e.target.value)}>
              {state.tariffs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Начало (время клуба)
            <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <div className="field">
            Длительность
            <div className="stepper">
              <button type="button" className="icon-btn" aria-label="Минус 15 минут" onClick={() => change(-15)}>
                <Icon name="minus" size={18} />
              </button>
              <input
                aria-label="Минуты"
                type="number"
                min={5}
                max={1440}
                step={5}
                value={minutes}
                onChange={(e) => setMinutes(Math.min(1440, Math.max(1, Number(e.target.value) || 0)))}
              />
              <button type="button" className="icon-btn" aria-label="Плюс 15 минут" onClick={() => change(15)}>
                <Icon name="plus" size={18} />
              </button>
            </div>
          </div>
        </div>
        {charge && from !== null && (
          <>
            <div className="calc-result">
              <span className="calc-total">{formatMoney(charge.amount, currency)}</span>
              <span className="muted">
                {formatClock(from, timezone)}–{formatClock(from + minutes * MIN, timezone)} · к оплате {formatSpan(charge.billedSeconds * 1000)}
              </span>
            </div>
            {charge.segments.length > 0 && (
              <div className="breakdown">
                <table>
                  <tbody>
                    {charge.segments.map((s) => (
                      <tr key={s.from}>
                        <td>{s.label}</td>
                        <td>
                          {formatClock(s.from, timezone)}–{formatClock(s.to, timezone)} <span className="muted">· {formatSpan(s.to - s.from)}</span>
                        </td>
                        <td className="num">{formatMoney(s.pricePerHour, currency)}/ч</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}

function rules(t: TariffConfig, currency: string): string[] {
  const out = [`базовая ${formatMoney(t.basePricePerHour, currency)}/ч`];
  out.push(t.stepMinutes === 1 ? 'поминутно' : `шаг ${t.stepMinutes} мин`);
  if (t.minimumMinutes) out.push(`минимум ${t.minimumMinutes} мин`);
  if (t.freeMinutes) out.push(`первые ${t.freeMinutes} мин бесплатно`);
  if (t.roundingMinor > 1) out.push(`сумма до ${formatMoney(t.roundingMinor, currency)}`);
  return out;
}

export function TariffsSection() {
  const { state, serverNow } = useHub();
  const { timezone, currency } = state.club;
  const minute = Math.floor(serverNow / MIN);
  // One price scale for every tariff, so the same colour means the same price.
  const levels = useMemo(
    () =>
      [
        ...new Set(
          state.tariffs.flatMap((t) => [t.config.basePricePerHour, ...t.config.windows.map((w) => w.pricePerHour)]),
        ),
      ].sort((a, b) => a - b),
    [state.tariffs],
  );
  const usedBy = (id: string) => state.tables.filter((t) => t.defaultTariffId === id).map((t) => t.name);

  return (
    <div className="page">
      <p className="page-lead">
        Цена зависит от дня и часа. Игра, которая переходит границу (например, с дневного тарифа на вечерний), считается по
        частям. Тариф фиксируется при открытии стола — изменения не касаются уже идущих игр.
      </p>
      <div className="two-col">
        <div className="page">
          {state.tariffs.map((t) => {
            const now = priceAt(minute * MIN, t.config, timezone);
            const tables = usedBy(t.id);
            return (
              <SectionCard
                key={t.id}
                title={t.name}
                actions={
                  <span className="tariff-now">
                    сейчас «{now.label}» · <strong>{formatMoney(now.pricePerHour, currency)}/ч</strong>
                  </span>
                }
              >
                <div className="rule-chips">
                  {rules(t.config, currency).map((r) => (
                    <span key={r} className="rule-chip">
                      {r}
                    </span>
                  ))}
                </div>
                <WeekMap tariff={t.config} levels={levels} now={minute * MIN} tz={timezone} currency={currency} />
                <p className="hint">{tables.length ? `Обычный для: ${tables.join(', ')}` : 'Не назначен столам по умолчанию'}</p>
              </SectionCard>
            );
          })}
        </div>
        <Calculator now={serverNow} />
      </div>
    </div>
  );
}
