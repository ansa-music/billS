import type { Minor, ShiftReport } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { getJson } from '../api.ts';
import { METHOD_LABEL } from '../cash/format.ts';
import { EmptyState, SectionCard, StatTile } from '../components.tsx';
import { formatSpan } from '../format.ts';
import { InsightsPanel } from '../insights/InsightsPanel.tsx';
import { hrefFor } from '../router.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { COUNTER_POLL_MS, fetchCounterOrders, productNameOf, usePolling } from './cafe.ts';
import './cafe.css';

/**
 * #/stats in a coffee shop («Отчёты»): money of the open shift (X report) and
 * how the counter is doing — orders, average time to «Готово», what sells.
 * Day and month revenue across shifts is in «Кабинет управляющего».
 */
export function CafeReports() {
  const hub = useHub();
  const { state } = hub;
  const { currency } = state.club;
  const money = (a: Minor) => formatMoney(a, currency);
  const shiftId = state.shift?.id ?? null;
  const shift = useLive(
    () => (shiftId ? getJson<ShiftReport>(`/api/shifts/${shiftId}/report`) : Promise.resolve(null)),
    [shiftId],
    hub.version,
  );
  const counter = usePolling(fetchCounterOrders, COUNTER_POLL_MS * 4, hub.version);
  const report = shift.data;
  const orders = (counter.data?.orders ?? []).filter((o) => o.status !== 'CANCELLED');
  const waiting = orders.filter((o) => o.stage === 'NEW' || o.stage === 'PREPARING').length;
  const timed = orders.filter((o) => o.readyAt != null).map((o) => o.readyAt! - o.createdAt);
  const avgPrep = timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length : null;

  const top = new Map<string, number>();
  for (const o of orders) for (const it of o.items) top.set(productNameOf(it), (top.get(productNameOf(it)) ?? 0) + it.qty);
  const topList = [...top].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topMax = topList[0]?.[1] ?? 1;

  return (
    <div className="page">
      <div className="stat-row">
        <StatTile
          label="Выручка смены"
          value={report ? money(report.net.total) : '—'}
          detail={report ? `смена №${report.shiftNumber}` : state.shift ? 'считаем…' : 'смена закрыта'}
        />
        <StatTile label="Чеков оплачено" value={report ? report.checksPaid : '—'} detail="за смену" />
        <StatTile
          label="Средний чек"
          value={report && report.checksPaid > 0 ? money(Math.round(report.net.total / report.checksPaid)) : '—'}
        />
        <StatTile
          label="Ждут бариста"
          value={counter.data ? waiting : '—'}
          detail={avgPrep != null ? `в среднем ${formatSpan(avgPrep)} до «Готово»` : 'нет данных о времени'}
          tone={waiting > 5 ? 'warn' : undefined}
        />
      </div>

      <InsightsPanel />

      <div className="two-col">
        <SectionCard title="Оплаты за смену">
          {!report ? (
            <EmptyState icon="checks" title={state.shift ? 'Загрузка…' : 'Смена закрыта'}>
              {state.shift ? null : 'Откройте смену в разделе «Счета», чтобы принимать оплату.'}
            </EmptyState>
          ) : (
            <dl className="kv cafe-kv">
              {(['CASH', 'CARD', 'QR'] as const).map((m) => (
                <div key={m}>
                  <dt>{METHOD_LABEL[m]}</dt>
                  <dd>{money(report.net[m])}</dd>
                </div>
              ))}
              {report.refunds.total > 0 && (
                <div>
                  <dt>Возвраты</dt>
                  <dd>−{money(report.refunds.total)}</dd>
                </div>
              )}
              {report.discounts > 0 && (
                <div>
                  <dt>Скидки</dt>
                  <dd>−{money(report.discounts)}</dd>
                </div>
              )}
              <div className="kv-strong">
                <dt>Итого</dt>
                <dd>{money(report.net.total)}</dd>
              </div>
            </dl>
          )}
          <p className="hint">
            X- и Z-отчёт, внесение и изъятие — в разделе <a href={hrefFor('/checks')}>«Счета»</a>
            {hub.can('reports.view') && (
              <>
                ; выручка за неделю и месяц — в <a href={hrefFor('/owner')}>«Кабинете»</a>
              </>
            )}
            .
          </p>
        </SectionCard>

        <SectionCard title="Что заказывают" actions={<span className="hint">последние заказы</span>}>
          {topList.length === 0 ? (
            <EmptyState icon="cup" title="Заказов пока нет" />
          ) : (
            <ul className="cafe-top">
              {topList.map(([name, qty]) => (
                <li key={name}>
                  <span className="cafe-top-name">{name}</span>
                  <span className="cafe-top-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(6, (qty / topMax) * 100)}%` }} />
                  </span>
                  <span className="cafe-top-qty">{qty}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
