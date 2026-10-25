import type { HubState, StockForecastItem } from '@bills/domain';
import { purchaseList, STOCK_BUY_DAYS } from '@bills/domain';
import { formatStamp, Row, Sep } from '../cash/print/blocks.tsx';
import { printForm } from '../cash/print/printForm.tsx';
import { formatClock } from '../format.ts';
import { Modal } from '../ui.tsx';
import { roundRunOut } from './useInsights.ts';
import './insights.css';

/** «Список закупки»: what to buy so a week of sales is covered, from the stock forecast. */
export function PurchaseListModal({
  stock,
  club,
  now,
  onClose,
}: {
  stock: StockForecastItem[];
  club: HubState['club'];
  now: number;
  onClose: () => void;
}) {
  const list = purchaseList(stock);
  const today = stock.filter((s) => s.runsOutAt !== null);
  return (
    <Modal open title="Список закупки" onClose={onClose}>
      <div className="purchase">
        <p className="hint">
          На {STOCK_BUY_DAYS} дней вперёд: сколько продаётся в день за последние 2 недели × {STOCK_BUY_DAYS} минус то, что
          уже есть. Только товары с учётом остатка.
        </p>
        {list.length === 0 ? (
          <p className="purchase-empty">
            {stock.length === 0
              ? 'Ни у одного товара не включён учёт остатка. Включите его в карточке товара — и TS посчитает, что докупить.'
              : 'Всего хватает на неделю — докупать пока нечего.'}
          </p>
        ) : (
          <table className="purchase-table">
            <thead>
              <tr>
                <th>Товар</th>
                <th className="num">Есть</th>
                <th className="num">В день</th>
                <th className="num">Купить</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.productId}>
                  <td>{s.name}</td>
                  <td className="num">{s.stock}</td>
                  <td className="num">{s.perDay !== null ? `≈${s.perDay.toLocaleString('ru-RU')}` : '—'}</td>
                  <td className="num purchase-buy">{s.buyForWeek} шт.</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {today.length > 0 && (
          <p className="purchase-today">
            Сегодня закончится: {today.map((s) => `${s.name} — к ${formatClock(roundRunOut(s.runsOutAt!), club.timezone)}`).join(', ')}.
          </p>
        )}
        <div className="row wrap modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Закрыть
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={list.length === 0}
            onClick={() => printForm(<PurchaseForm list={list} club={club} now={now} />)}
          >
            Печать
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The paper version for the receipt printer (same form styles as checks and X/Z reports). */
function PurchaseForm({ list, club, now }: { list: StockForecastItem[]; club: HubState['club']; now: number }) {
  return (
    <div className="pf">
      <header className="pf-head">
        <p className="pf-club">{club.name}</p>
        <p className="pf-title">Закупить на неделю</p>
        <p className="pf-center">{formatStamp(now, club.timezone)}</p>
      </header>
      <Sep />
      {list.map((s) => (
        <Row key={s.productId} label={s.name} value={`${s.buyForWeek} шт.`} />
      ))}
      <Sep />
      <p className="pf-center pf-notice">По продажам за 2 недели</p>
    </div>
  );
}
