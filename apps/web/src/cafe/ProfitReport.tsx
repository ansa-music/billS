import type { Minor, ProfitLine, ProfitReport } from '@bills/domain';
import { formatMoney, formatStock } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { EmptyState, SectionCard, StatTile } from '../components.tsx';
import { plural } from '../format.ts';
import { hrefFor } from '../router.tsx';
import { useHub, useLive } from '../useHub.tsx';
import type { Period } from './ReportPeriod.tsx';

/** GET /api/reports/profit for whole local days (stats.view). */
export function useProfit(period: Period, enabled = true) {
  const { version } = useHub();
  return useLive(
    () => (enabled ? fetchJson<ProfitReport>(`/api/reports/profit?from=${period.from}&to=${period.to}`) : Promise.resolve(null)),
    [period.from, period.to, enabled],
    version,
  );
}

/**
 * «Себестоимость и прибыль» (GET /api/reports/profit): revenue, what the drinks took off the stock
 * by their recipes (with the chosen options, at the price of the day), gross profit and margin —
 * per product too — and losses (write-offs and inventory differences) as their own lines.
 */
export function ProfitSection({ period, label }: { period: Period; label: string }) {
  const { state, can } = useHub();
  const money = (a: Minor) => formatMoney(a, state.club.currency);
  const { data, error } = useProfit(period);
  if (error && !data) return <p className="form-error">{error}</p>;
  if (!data) return <p className="muted">Загрузка…</p>;
  const { losses } = data;

  return (
    <div className="report-section">
      <div className="stat-row">
        <StatTile label="Выручка" value={money(data.revenue)} detail={label} />
        <StatTile label="Себестоимость" value={money(data.cost)} detail="сырьё по составу напитков" />
        <StatTile
          label="Валовая прибыль"
          value={money(data.profit)}
          detail={data.margin === null ? 'продаж не было' : `маржа ${data.margin}%`}
          tone={data.profit < 0 ? 'danger' : 'good'}
        />
        <StatTile
          label="Потери"
          value={money(losses.total)}
          detail={`прибыль после потерь ${money(data.profitAfterLosses)}`}
          tone={losses.total > 0 ? 'warn' : undefined}
        />
      </div>

      {(data.productsWithoutRecipe > 0 || data.costIncomplete) && (
        <div className="report-warn" role="note">
          {data.productsWithoutRecipe > 0 && (
            <p>
              {data.productsWithoutRecipe} {plural(data.productsWithoutRecipe, ['позиция', 'позиции', 'позиций'])} без состава (выручка{' '}
              {money(data.revenueWithoutRecipe)}): их себестоимость не посчитана, прибыль выше настоящей.
              {can('stock.view') && (
                <>
                  {' '}
                  <a href={hrefFor('/stock', { tab: 'recipes' })}>Заполнить состав</a>
                </>
              )}
            </p>
          )}
          {data.costIncomplete && <p>У части сырья не было цены: себестоимость ниже настоящей. Цену даёт поставка.</p>}
        </div>
      )}

      <SectionCard title="По позициям" actions={<span className="hint">{label}</span>}>
        {data.lines.length === 0 ? (
          <EmptyState icon="cup" title="Продаж за этот период нет" />
        ) : (
          <div className="profit-table" role="table" aria-label="Прибыль по позициям">
            <div className="profit-row profit-head" role="row">
              <span role="columnheader">Позиция</span>
              <span role="columnheader">Продано</span>
              <span role="columnheader">Выручка</span>
              <span role="columnheader">Себестоимость</span>
              <span role="columnheader">Прибыль</span>
              <span role="columnheader">Маржа</span>
            </div>
            {data.lines.map((l) => (
              <ProfitRow key={l.productId} line={l} money={money} />
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Потери" actions={<span className="hint">списания и инвентаризация</span>}>
        <dl className="kv cafe-kv">
          <div>
            <dt>Списания</dt>
            <dd>{money(losses.writeOff)}</dd>
          </div>
          <div>
            <dt>Недостача по инвентаризации</dt>
            <dd>{money(losses.shortage)}</dd>
          </div>
          {losses.surplus > 0 && (
            <div>
              <dt>Излишек по инвентаризации</dt>
              <dd>−{money(losses.surplus)}</dd>
            </div>
          )}
          <div className="kv-strong">
            <dt>Итого потерь</dt>
            <dd>{money(losses.total)}</dd>
          </div>
          <div className="kv-strong">
            <dt>Прибыль после потерь</dt>
            <dd>{money(data.profitAfterLosses)}</dd>
          </div>
        </dl>
        {losses.lines.length > 0 && (
          <ul className="profit-losses">
            {losses.lines.map((l) => (
              <li key={`${l.kind}:${l.ingredientId}`}>
                <span>
                  {l.name}
                  <span className="muted">
                    {' · '}
                    {l.kind === 'writeoff' ? 'списано' : l.quantity < 0 ? 'недостача' : 'излишек'} {formatStock(Math.abs(l.quantity), l.unit)}
                  </span>
                </span>
                <span className="money">{l.loss === null ? 'цена не известна' : l.loss < 0 ? `−${money(-l.loss)}` : money(l.loss)}</span>
              </li>
            ))}
          </ul>
        )}
        {losses.unpriced > 0 && <p className="hint">Без цены: {losses.unpriced} — их сумма не посчитана.</p>}
      </SectionCard>
    </div>
  );
}

function ProfitRow({ line: l, money }: { line: ProfitLine; money: (a: Minor) => string }) {
  return (
    <div className="profit-row" role="row" data-no-recipe={l.noRecipe || undefined}>
      <span role="cell" className="profit-name">
        {l.name}
        {l.noRecipe && <span className="tag tag-warn">нет состава</span>}
        {l.partlyWithoutRecipe && <span className="tag tag-muted">часть продаж без состава</span>}
        {l.costIncomplete && <span className="tag tag-muted">не у всего сырья есть цена</span>}
      </span>
      <span role="cell" data-label="Продано">
        {l.qty} шт
      </span>
      <span role="cell" data-label="Выручка">
        {money(l.revenue)}
      </span>
      <span role="cell" data-label="Себестоимость">
        {l.cost === null ? '—' : money(l.cost)}
      </span>
      <span role="cell" data-label="Прибыль" data-negative={l.profit !== null && l.profit < 0 ? '' : undefined}>
        {l.profit === null ? '—' : money(l.profit)}
      </span>
      <span role="cell" data-label="Маржа">
        {l.margin === null ? '—' : `${l.margin}%`}
      </span>
    </div>
  );
}
