import type { HubState, Minor, PurchaseLine, PurchaseListView } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { Modal } from '../cash/Modal.tsx';
import { formatStamp, Info, Row, Sep } from '../cash/print/blocks.tsx';
import { printForm } from '../cash/print/printForm.tsx';
import { EmptyState } from '../components.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { plural, qtyLabel } from './stock.ts';
import './stock-reports.css';

/** Lines «Докупить на неделю» hands to the delivery form: what to buy (base units) and roughly for how much. */
export type SupplyDraft = Array<{ ingredientId: string; quantity: number; approx: Minor | null }>;

/**
 * «Докупить на неделю» (GET /api/stock/purchase): for every raw material on the stock, what to buy
 * so a week of sales is covered and the minimum stays — ⌈в день × 7 + минимум − остаток⌉ at the
 * pace of the last two weeks, in кг, л or штуки — with the approximate cost at the average price.
 * Prints on the receipt printer and turns into a delivery in one tap.
 */
export function BuyListModal({ onClose, onStartSupply }: { onClose: () => void; onStartSupply?: ((draft: SupplyDraft) => void) | undefined }) {
  const { state, version, serverNow } = useHub();
  const currency = state.club.currency;
  const { data, error } = useLive(() => fetchJson<PurchaseListView>('/api/stock/purchase'), [], version);
  const lines = data?.lines ?? [];
  const money = (m: Minor) => formatMoney(m, currency);

  return (
    <Modal
      title="Докупить на неделю"
      onClose={onClose}
      className="stock-modal stock-buy-modal"
      footer={
        <div className="stock-buy-foot">
          {data && lines.length > 0 && (
            <div className="stock-total">
              <span>Примерно{data.unpriced > 0 ? ` (без цены: ${data.unpriced})` : ''}</span>
              <strong className="money">{money(data.total)}</strong>
            </div>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-large"
              disabled={!data || lines.length === 0}
              onClick={() => data && printForm(<BuyListForm list={data} club={state.club} at={serverNow} />)}
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
                Создать поставку
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
            Расход — средний за {data.usageDays} {plural(data.usageDays, 'день', 'дня', 'дней')} продаж. Количество — чтобы хватило на {data.days} дней и
            остался минимум.
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

/** The list on the receipt printer (cash/print): a box to tick for every line, then the total. */
function BuyListForm({ list, club, at }: { list: PurchaseListView; club: HubState['club']; at: number }) {
  const money = (m: Minor) => formatMoney(m, club.currency);
  return (
    <div className="pf">
      <header className="pf-head">
        <p className="pf-club">{club.name}</p>
        <p className="pf-title">Докупить на неделю</p>
      </header>
      <Info label="Сформирован">{formatStamp(at, club.timezone)}</Info>
      <Sep />
      {list.lines.map((l) => (
        <div key={l.ingredientId} className="pf-item">
          <Row label={`[ ] ${l.name}`} value={qtyLabel(l.need, l.unit)} strong />
          <Row label={`есть ${qtyLabel(l.quantity, l.unit)}`} value={l.cost === null ? '—' : `≈ ${money(l.cost)}`} sub />
        </div>
      ))}
      <Sep />
      <Row label="Итого примерно" value={money(list.total)} big />
      {list.unpriced > 0 && <p>Без цены: {list.unpriced}</p>}
    </div>
  );
}
