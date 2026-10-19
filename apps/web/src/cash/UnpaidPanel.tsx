import { Fragment, useRef, useState } from 'react';
import type { CheckView, CreateCheckRequest, Minor, SessionView } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { formatClock, formatMinutes } from '../format.ts';
import { CancelDialog } from './CancelDialog.tsx';
import type { DeskProps } from './desk.ts';
import { toActionError, useDesk } from './desk.ts';
import { checkSummary, gameDue, orderSummary, ordersByTable, owedTotal, unbilledOrders } from './lines.ts';
import { PayDialog } from './PayDialog.tsx';

/** Open checks first, then stopped games that are not on a check yet, then bar orders left after their game. */
export function UnpaidPanel(props: DeskProps) {
  const desk = useDesk(props);
  const { state } = desk;
  const { currency, timezone } = state.club;
  const money = (a: Minor) => formatMoney(a, currency);
  const names = new Map(state.tables.map((t) => [t.id, t.name]));
  const loose = state.unpaid.filter((s) => s.checkId == null);
  const unbilled = unbilledOrders(state);
  const total = owedTotal(state);
  const canPay = state.shift !== null;

  const [paying, setPaying] = useState<CheckView | null>(null);
  const [cancelling, setCancelling] = useState<SessionView | null>(null);
  /** What a check is being opened for: a game id, an order id or `table:<id>` for all orders of a table. */
  const [creating, setCreating] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const openCheck = async (key: string, body: CreateCheckRequest) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(key);
    try {
      setPaying(await desk.send<CheckView>('/api/checks', body));
    } catch (e) {
      desk.notify(toActionError(e).message);
    } finally {
      creatingRef.current = false;
      setCreating(null);
    }
  };

  // The game's open bar orders join its check on the HUB.
  const payGame = (session: SessionView) => openCheck(session.id, { sessionIds: [session.id] });
  // Orders whose game is over go on a check of their own.
  const payOrders = (key: string, orderIds: string[]) => openCheck(key, { sessionIds: [], orderIds });

  return (
    <section className="panel cash-panel" aria-labelledby="unpaid-title">
      <header className="panel-head">
        <h2 id="unpaid-title">Ожидают оплаты</h2>
        <span className="panel-total">{money(total)}</span>
      </header>

      {state.checks.length === 0 && loose.length === 0 && unbilled.length === 0 ? (
        <p className="empty">Неоплаченных игр и заказов нет</p>
      ) : (
        <>
          {!canPay && <p className="hint hint-warn">Откройте смену, чтобы принимать оплату</p>}

          {state.checks.length > 0 && (
            <ul className="unpaid" aria-label="Открытые счета">
              {state.checks.map((c) => (
                <li key={c.id}>
                  <div className="due-info">
                    <strong>Счёт №{c.number}</strong>
                    <span className="muted">{checkSummary(c, names, money)}</span>
                    <span className="muted">
                      Оплачено {money(c.paid - c.refunded)} · к оплате {money(c.due)}
                    </span>
                  </div>
                  <span className="unpaid-amount">{money(c.due)}</span>
                  <div className="due-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={!canPay}
                      onClick={() => setPaying(c)}
                    >
                      Оплатить
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {loose.length > 0 && (
            <ul className="unpaid" aria-label="Игры без счёта">
              {loose.map((s) => (
                <li key={s.id}>
                  <div className="due-info">
                    <strong>{names.get(s.tableId) ?? 'Стол'}</strong>
                    <span className="muted">
                      {s.startedAt != null && formatClock(s.startedAt, timezone)}–
                      {s.stoppedAt != null && formatClock(s.stoppedAt, timezone)} ·{' '}
                      {formatMinutes(s.playedSeconds ?? 0)}
                    </span>
                    {s.ordersTotal > 0 && (
                      <span className="muted">
                        Игра {money(s.amount ?? 0)} + бар {money(s.ordersTotal)}
                      </span>
                    )}
                  </div>
                  <span className="unpaid-amount">{money(gameDue(s))}</span>
                  <div className="due-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={!canPay || creating !== null}
                      onClick={() => void payGame(s)}
                    >
                      {creating === s.id ? 'Открываем…' : 'Оплатить'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-small btn-ghost"
                      disabled={creating === s.id}
                      onClick={() => setCancelling(s)}
                    >
                      Отменить
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {unbilled.length > 0 && (
            <div className="unpaid-orders">
              <h3 className="cash-sub" id="unbilled-title">
                Заказы без счёта
              </h3>
              <p className="hint">Игра уже окончена, а заказы бара ещё не оплачены.</p>
              <ul className="unpaid" aria-labelledby="unbilled-title">
                {ordersByTable(unbilled).map(({ tableId, orders }) => {
                  const tableName = names.get(tableId) ?? 'Стол';
                  const allKey = `table:${tableId}`;
                  return (
                    <Fragment key={tableId}>
                      {orders.map((o) => (
                        <li key={o.id}>
                          <div className="due-info">
                            <strong>{tableName} · бар</strong>
                            <span className="muted">{orderSummary(o)}</span>
                            <span className="muted">
                              Заказ в {formatClock(o.createdAt, timezone)} · {o.createdBy}
                            </span>
                          </div>
                          <span className="unpaid-amount">{money(o.total)}</span>
                          <div className="due-actions">
                            <button
                              type="button"
                              className="btn btn-small btn-primary"
                              disabled={!canPay || creating !== null}
                              onClick={() => void payOrders(o.id, [o.id])}
                            >
                              {creating === o.id ? 'Открываем…' : 'Оплатить'}
                            </button>
                          </div>
                        </li>
                      ))}
                      {orders.length > 1 && (
                        <li className="unpaid-all">
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={!canPay || creating !== null}
                            onClick={() =>
                              void payOrders(
                                allKey,
                                orders.map((o) => o.id),
                              )
                            }
                          >
                            {creating === allKey
                              ? 'Открываем…'
                              : `Оплатить все заказы стола (${orders.length}) · ${money(orders.reduce((sum, o) => sum + o.total, 0))}`}
                          </button>
                        </li>
                      )}
                    </Fragment>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}

      {paying && <PayDialog key={paying.id} desk={desk} initial={paying} onClose={() => setPaying(null)} />}
      {cancelling && <CancelDialog desk={desk} session={cancelling} onClose={() => setCancelling(null)} />}
    </section>
  );
}
