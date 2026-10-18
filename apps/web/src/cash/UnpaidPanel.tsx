import { useRef, useState } from 'react';
import type { CheckView, CreateCheckRequest, Minor, SessionView } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { formatClock, formatMinutes } from '../format.ts';
import { CancelDialog } from './CancelDialog.tsx';
import type { DeskProps } from './desk.ts';
import { toActionError, useDesk } from './desk.ts';
import { PayDialog } from './PayDialog.tsx';

/** Open checks first, then stopped games that are not on a check yet. */
export function UnpaidPanel(props: DeskProps) {
  const desk = useDesk(props);
  const { state } = desk;
  const { currency, timezone } = state.club;
  const money = (a: Minor) => formatMoney(a, currency);
  const names = new Map(state.tables.map((t) => [t.id, t.name]));
  const loose = state.unpaid.filter((s) => s.checkId == null);
  const total = state.checks.reduce((sum, c) => sum + c.due, 0) + loose.reduce((sum, s) => sum + (s.amount ?? 0), 0);
  const canPay = state.shift !== null;

  const [paying, setPaying] = useState<CheckView | null>(null);
  const [cancelling, setCancelling] = useState<SessionView | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const payGame = async (session: SessionView) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(session.id);
    try {
      const body: CreateCheckRequest = { sessionIds: [session.id] };
      setPaying(await desk.send<CheckView>('/api/checks', body));
    } catch (e) {
      desk.notify(toActionError(e).message);
    } finally {
      creatingRef.current = false;
      setCreating(null);
    }
  };

  return (
    <section className="panel cash-panel" aria-labelledby="unpaid-title">
      <header className="panel-head">
        <h2 id="unpaid-title">Ожидают оплаты</h2>
        <span className="panel-total">{money(total)}</span>
      </header>

      {state.checks.length === 0 && loose.length === 0 ? (
        <p className="empty">Неоплаченных игр нет</p>
      ) : (
        <>
          {!canPay && <p className="hint hint-warn">Откройте смену, чтобы принимать оплату</p>}

          {state.checks.length > 0 && (
            <ul className="unpaid" aria-label="Открытые счета">
              {state.checks.map((c) => (
                <li key={c.id}>
                  <div className="due-info">
                    <strong>Счёт №{c.number}</strong>
                    <span className="muted">{c.items.map((i) => i.title).join(', ') || 'Без позиций'}</span>
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
                  </div>
                  <span className="unpaid-amount">{money(s.amount ?? 0)}</span>
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
        </>
      )}

      {paying && <PayDialog key={paying.id} desk={desk} initial={paying} onClose={() => setPaying(null)} />}
      {cancelling && <CancelDialog desk={desk} session={cancelling} onClose={() => setCancelling(null)} />}
    </section>
  );
}
