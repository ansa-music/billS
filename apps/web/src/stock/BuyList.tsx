import type { PurchaseLine, PurchaseListView } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { Modal } from '../cash/Modal.tsx';
import { EmptyState } from '../components.tsx';
import { formatDate } from '../ui.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { printSheet } from './printSheet.tsx';
import type { SupplyDraft } from './stock.ts';
import { plural, qtyLabel } from './stock.ts';

/**
 * «Докупить на неделю» (GET /api/stock/purchase): for every raw material, what to buy so a week
 * of sales is covered and the minimum stays — ⌈в день × 7 + минимум − остаток⌉ at the pace of
 * the last two weeks — with the approximate cost at the average price. Prints on A4 and turns
 * into a delivery in one tap.
 */
export function BuyListModal({ onClose, onStartSupply }: { onClose: () => void; onStartSupply?: (draft: SupplyDraft) => void }) {
  const { state, version, serverNow } = useHub();
  const currency = state.club.currency;
  const { data, error } = useLive(() => fetchJson<PurchaseListView>('/api/stock/purchase'), [], version);
  const lines = data?.lines ?? [];
  const money = (m: number) => formatMoney(m, currency);

  return (
    <Modal
      title="Докупить на неделю"
      onClose={onClose}
      className="stock-modal stock-buy-modal"
      footer={
        <div className="stock-buy-foot">
          {data && lines.length > 0 && (
            <div className="stock-total">
              <span>Примерно{data.unpriced > 0 ? ` (без ${data.unpriced} без цены)` : ''}</span>
              <strong className="money">{money(data.total)}</strong>
            </div>
          )}
          <div className="row wrap">
            <button
              type="button"
              className="btn btn-large"
              disabled={!data || lines.length === 0}
              onClick={() => data && printSheet(<BuyListSheet list={data} venue={state.club.name} date={formatDate(serverNow, state.club.timezone)} money={money} />)}
            >
              Печать
            </button>
            {onStartSupply && (
              <button
                type="button"
                className="btn btn-primary btn-large"
                disabled={!data || lines.length === 0}
                onClick={() => onStartSupply(lines.map((l) => ({ ingredientId: l.ingredientId, quantity: l.need, approx: l.cost })))}
              >
                Создать поставку из списка
              </button>
            )}
          </div>
        </div>
      }
    >
      {error && <p className="form-error">{error}</p>}
      {!data ? (
        <p className="muted">Считаем…</p>
      ) : (
        <>
          <p className="muted stock-buy-note">
            Расход — средний за {data.usageDays} {plural(data.usageDays, 'день', 'дня', 'дней')} продаж. Количество — чтобы хватило на{' '}
            {data.days} дней и остался минимум.
          </p>
          {lines.length === 0 ? (
            <EmptyState icon="check" title="Докупать ничего не нужно">
              Сырья хватит на неделю вперёд.
            </EmptyState>
          ) : (
            <ul className="stock-buy-list">
              {lines.map((l) => (
                <li key={l.ingredientId} className="stock-buy-item">
                  <div className="stock-buy-main">
                    <span className="stock-item-name">{l.name}</span>
                    <span className="muted">{detail(l)}</span>
                  </div>
                  <div className="stock-buy-qty">
                    <strong>{qtyLabel(l.need, l.unit)}</strong>
                    <span className="muted">{l.cost === null ? 'цена не известна' : `≈ ${money(l.cost)}`}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}

function detail(l: PurchaseLine): string {
  const parts = [`есть ${qtyLabel(l.quantity, l.unit)}`];
  parts.push(l.perDay > 0 ? `в день ~${qtyLabel(l.perDay, l.unit)}` : 'продаж не было');
  if (l.minLevel !== null) parts.push(`минимум ${qtyLabel(l.minLevel, l.unit)}`);
  return parts.join(' · ');
}

/** The printed list: plain black on white, a box to tick for every line. */
function BuyListSheet({ list, venue, date, money }: { list: PurchaseListView; venue: string; date: string; money: (m: number) => string }) {
  return (
    <div className="buy-sheet">
      <h1>Докупить на неделю</h1>
      <p>
        {venue} · {date}
      </p>
      <table>
        <thead>
          <tr>
            <th aria-label="Куплено" />
            <th>Сырьё</th>
            <th>Купить</th>
            <th>Есть</th>
            <th>Примерно</th>
          </tr>
        </thead>
        <tbody>
          {list.lines.map((l) => (
            <tr key={l.ingredientId}>
              <td className="buy-sheet-box">☐</td>
              <td>{l.name}</td>
              <td>
                <strong>{qtyLabel(l.need, l.unit)}</strong>
              </td>
              <td>{qtyLabel(l.quantity, l.unit)}</td>
              <td>{l.cost === null ? '—' : money(l.cost)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td colSpan={3}>Итого примерно</td>
            <td>
              <strong>{money(list.total)}</strong>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
