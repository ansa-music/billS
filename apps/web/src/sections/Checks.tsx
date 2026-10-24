import { useMemo, useState } from 'react';
import type { OrderView, SessionStatus, SessionView, ShiftReport } from '@bills/domain';
import { calculateChargeWithPauses, formatMoney, unpaidSpans } from '@bills/domain';
import { amountOf, isLive, playedMsOf } from '../hall.ts';
import { fetchSessions, getJson } from '../api.ts';
import { gameDue, orderSummary, owedTotal, placeName, unbilledOrders } from '../cash/lines.ts';
import { ShiftBanner } from '../cash/ShiftBanner.tsx';
import { ShiftPanel } from '../cash/ShiftPanel.tsx';
import { UnpaidPanel } from '../cash/UnpaidPanel.tsx';
import { EmptyState, SectionCard, StatTile, StatusBadge } from '../components.tsx';
import { DAY_MS, formatClock, formatSpan, plural, workdayStart } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { businessOf } from '../cafe/cafe.ts';

type HistoryFilter = 'all' | 'live' | 'unpaid' | 'paid' | 'cancelled' | 'failed';

const FILTERS: Array<{ value: HistoryFilter; label: string; match: (s: SessionStatus) => boolean }> = [
  { value: 'all', label: 'Все', match: () => true },
  { value: 'live', label: 'Идут', match: (s) => s === 'ACTIVE' || s === 'PAUSED' || s === 'OPENING' },
  { value: 'unpaid', label: 'Ждут оплаты', match: (s) => s === 'AWAITING_PAYMENT' },
  { value: 'paid', label: 'Оплачены', match: (s) => s === 'CLOSED' },
  { value: 'cancelled', label: 'Отменены', match: (s) => s === 'CANCELLED' },
  { value: 'failed', label: 'Свет не включился', match: (s) => s === 'FAILED' },
];

const playedMs = playedMsOf;
const liveAmount = amountOf;

function CheckBreakdown({ s, orders, currency }: { s: SessionView; orders: OrderView[]; currency: string }) {
  if (s.startedAt == null || s.stoppedAt == null) return null;
  const charge = calculateChargeWithPauses(
    s.startedAt,
    s.stoppedAt,
    unpaidSpans(s.pauses, s.tariff, s.stoppedAt),
    s.tariff,
    s.timezone,
  );
  return (
    <div className="breakdown check-details">
      <table>
        <thead>
          <tr>
            <th>Тариф</th>
            <th>Время</th>
            <th className="num">Цена</th>
          </tr>
        </thead>
        <tbody>
          {charge.segments.map((seg) => (
            <tr key={seg.from}>
              <td>{seg.label}</td>
              <td>
                {formatClock(seg.from, s.timezone)}–{formatClock(seg.to, s.timezone)}
                <span className="muted"> · {formatSpan(seg.to - seg.from)}</span>
              </td>
              <td className="num">{formatMoney(seg.pricePerHour, currency)}/ч</td>
            </tr>
          ))}
        </tbody>
      </table>
      {orders.length > 0 && (
        <table className="breakdown-bar">
          <thead>
            <tr>
              <th>Бар</th>
              <th>Кол-во</th>
              <th className="num">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {orders.flatMap((o) =>
              o.items.map((it) => (
                <tr key={it.id}>
                  <td>{it.title}</td>
                  <td>
                    {it.qty} × {formatMoney(it.price, currency)}
                  </td>
                  <td className="num">{formatMoney(it.amount, currency)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      )}
      <p className="hint">
        Сыграно {formatSpan((s.playedSeconds ?? 0) * 1000)}, к оплате {formatSpan((s.billedSeconds ?? 0) * 1000)} · тариф «{s.tariffName}»
        {s.stoppedBy ? ` · остановил ${s.stoppedBy}` : ''}
      </p>
    </div>
  );
}

function UnpaidCard({ s, name, orders, currency }: { s: SessionView; name: string; orders: OrderView[]; currency: string }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="check-card">
      <span className="check-icon" aria-hidden="true">
        <Icon name="checks" />
      </span>
      <div className="row-main">
        <strong>{name}</strong>
        <span className="row-sub">
          {s.startedAt != null && formatClock(s.startedAt, s.timezone)}–{s.stoppedAt != null && formatClock(s.stoppedAt, s.timezone)} ·{' '}
          {formatSpan((s.playedSeconds ?? 0) * 1000)} · {s.tariffName}
        </span>
        {s.ordersTotal > 0 && (
          <span className="row-sub">
            Игра {formatMoney(s.amount ?? 0, currency)} + бар {formatMoney(s.ordersTotal, currency)}
          </span>
        )}
        <button type="button" className="check-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Скрыть расчёт' : 'Как посчитано'}
        </button>
      </div>
      <span className="check-amount">{formatMoney(gameDue(s), currency)}</span>
      {open && <CheckBreakdown s={s} orders={orders} currency={currency} />}
    </article>
  );
}

/** A bar order left after its game (read-only here; the cashier bills it in «Ожидают оплаты»). */
function UnbilledOrderCard({ o, name, timezone, currency }: { o: OrderView; name: string; timezone: string; currency: string }) {
  return (
    <article className="check-card">
      <span className="check-icon" aria-hidden="true">
        <Icon name="orders" />
      </span>
      <div className="row-main">
        <strong>{name} · бар</strong>
        <span className="row-sub">{orderSummary(o)}</span>
        <span className="row-sub">
          Заказ в {formatClock(o.createdAt, timezone)} · игра окончена, заказ без счёта
        </span>
      </div>
      <span className="check-amount">{formatMoney(o.total, currency)}</span>
    </article>
  );
}

export function ChecksSection() {
  const hub = useHub();
  const { state, serverNow } = hub;
  const { timezone, currency } = state.club;
  const dayStart = workdayStart(serverNow, timezone);
  const day = useLive(() => fetchSessions(dayStart, dayStart + DAY_MS), [dayStart], hub.version);
  // Money actually taken (time and bar, after discounts and refunds) comes from the open shift's X report.
  const shiftId = state.shift?.id ?? null;
  const shiftReport = useLive(
    () => (shiftId ? getJson<ShiftReport>(`/api/shifts/${shiftId}/report`) : Promise.resolve(null)),
    [shiftId],
    hub.version,
  );
  const report = shiftReport.data;
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [tableId, setTableId] = useState('');

  const names = useMemo(() => new Map(state.tables.map((t) => [t.id, t.name])), [state.tables]);
  const sessions = day.data ?? [];
  const inDay = sessions.filter((s) => (s.startedAt ?? s.requestedAt) >= dayStart);
  // What is owed: open checks, stopped games not yet on a check (with their bar), bar orders left after their game.
  const unpaidSum = owedTotal(state);
  const unbilled = unbilledOrders(state);
  const ordersOf = (sessionId: string) => state.orders.filter((o) => o.sessionId === sessionId && o.status === 'OPEN');
  const owing = state.unpaid.length + state.checks.length + unbilled.length > 0;
  const owingDetail = [
    state.unpaid.length ? `${state.unpaid.length} ${plural(state.unpaid.length, ['игра', 'игры', 'игр'])}` : '',
    state.checks.length ? `счетов: ${state.checks.length}` : '',
    unbilled.length ? `заказов без счёта: ${unbilled.length}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const cashDesk = hub.can('payment.take') || hub.can('shift.open');
  // A coffee shop has no games: only the shift and what is owed.
  const cafe = businessOf(state.settings) === 'cafe';
  const desk = { state, actor: hub.actor, refresh: hub.refresh, notify: hub.notify };
  const played = inDay.filter((s) => isLive(s) || s.status === 'AWAITING_PAYMENT' || s.status === 'CLOSED');
  const charged = played.reduce((sum, s) => sum + liveAmount(s, serverNow), 0);
  const troubles = inDay.filter((s) => s.status === 'CANCELLED' || s.status === 'FAILED');

  const counts = new Map(FILTERS.map((f) => [f.value, sessions.filter((s) => f.match(s.status)).length]));
  const active = FILTERS.find((f) => f.value === filter) ?? FILTERS[0]!;
  const shown = sessions.filter((s) => active.match(s.status) && (!tableId || s.tableId === tableId));

  return (
    <div className="page">
      <ShiftBanner />
      <div className="stat-row">
        <StatTile
          label="Ждут оплаты"
          value={formatMoney(unpaidSum, currency)}
          detail={owing ? owingDetail : 'всё оплачено'}
          tone={owing ? 'info' : undefined}
        />
        {!cafe && <StatTile label="Начислено за день" value={formatMoney(charged, currency)} detail={`время · ${played.length} ${plural(played.length, ['игра', 'игры', 'игр'])} с 06:00`} />}
        <StatTile
          label="Оплачено за смену"
          value={report ? formatMoney(report.net.total, currency) : '—'}
          detail={
            report
              ? `счетов: ${report.checksPaid}${report.revenue ? ` · бар ${formatMoney(report.revenue.bar, currency)}` : ''}`
              : state.shift
                ? 'считаем…'
                : 'смена закрыта'
          }
        />
        {!cafe && (
          <StatTile
            label="Отмены и сбои света"
            value={troubles.length}
            detail={troubles.length ? 'без оплаты, видно в журнале' : 'не было'}
            tone={troubles.some((s) => s.status === 'FAILED') ? 'danger' : undefined}
          />
        )}
      </div>

      {cashDesk ? (
        <div className="two-col cash-desk">
          <ShiftPanel {...desk} />
          <UnpaidPanel {...desk} />
        </div>
      ) : (
        <SectionCard title="Ждут оплаты" actions={<span className="hint">Оплату принимает кассир</span>}>
          {state.unpaid.length === 0 && unbilled.length === 0 ? (
            <EmptyState icon="check" title="Неоплаченных игр нет">
              Когда игру останавливают, стол сразу освобождается, а сумма появляется здесь.
            </EmptyState>
          ) : (
            <div className="check-list">
              {state.unpaid.map((s) => (
                <UnpaidCard key={s.id} s={s} name={names.get(s.tableId) ?? 'Стол'} orders={ordersOf(s.id)} currency={currency} />
              ))}
              {unbilled.map((o) => (
                <UnbilledOrderCard key={o.id} o={o} name={placeName(names, o.tableId)} timezone={timezone} currency={currency} />
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {!cafe && <div className="two-col">
        {cashDesk && state.unpaid.length > 0 && (
          <SectionCard title="Как посчитаны неоплаченные игры">
            <div className="check-list">
              {state.unpaid.map((s) => (
                <UnpaidCard key={s.id} s={s} name={names.get(s.tableId) ?? 'Стол'} orders={ordersOf(s.id)} currency={currency} />
              ))}
            </div>
          </SectionCard>
        )}

        <SectionCard
          title="Игры за день"
          actions={
            <select className="select" aria-label="Стол" value={tableId} onChange={(e) => setTableId(e.target.value)}>
              <option value="">Все столы</option>
              {state.tables.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          }
        >
          <div className="chips" role="group" aria-label="Статус">
            {FILTERS.filter((f) => f.value === 'all' || (counts.get(f.value) ?? 0) > 0 || f.value === filter).map((f) => (
              <button key={f.value} type="button" className="filter-chip" aria-pressed={f.value === filter} onClick={() => setFilter(f.value)}>
                {f.label}
                <span className="count">{counts.get(f.value) ?? 0}</span>
              </button>
            ))}
          </div>
          {day.data === null ? (
            <p className="hint">{day.error ?? 'Загрузка…'}</p>
          ) : shown.length === 0 ? (
            <EmptyState icon="journal" title="Игр нет">
              {filter === 'all' && !tableId ? 'С начала дня (06:00) столы ещё не открывали.' : 'По этому фильтру ничего нет.'}
            </EmptyState>
          ) : (
            <ul className="rows">
              {shown.map((s) => (
                <li key={s.id} className="row-item">
                  <div className="row-main">
                    <strong>{names.get(s.tableId) ?? 'Стол'}</strong>
                    <span className="row-sub">
                      {formatClock(s.startedAt ?? s.requestedAt, timezone)}
                      {s.stoppedAt != null ? `–${formatClock(s.stoppedAt, timezone)}` : ''} · {s.openedBy}
                    </span>
                  </div>
                  <StatusBadge status={s.status} />
                  <span className="row-sub">{playedMs(s, serverNow) ? formatSpan(playedMs(s, serverNow)) : '—'}</span>
                  <span className="row-amount">{formatMoney(liveAmount(s, serverNow), currency)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>}
    </div>
  );
}
