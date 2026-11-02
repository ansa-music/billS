import { useState } from 'react';
import type { ArchiveEntry, ArchiveView, CheckView, DayChecksView, Minor } from '@bills/domain';
import { ARCHIVE_KIND_LABEL, formatMoney, PAYMENT_METHOD_LABEL } from '@bills/domain';
import { getJson } from '../api.ts';
import type { CancelTarget } from '../cafe/CounterCancelDialog.tsx';
import { CounterCancelDialog } from '../cafe/CounterCancelDialog.tsx';
import { EmptyState, SectionCard } from '../components.tsx';
import { formatClock } from '../format.ts';
import { useHub, useLive } from '../useHub.tsx';
import { checkSummary } from './lines.ts';
import { ReceiptDialog } from './ReceiptDialog.tsx';

const dayQuery = (date: string) => (date ? `?date=${encodeURIComponent(date)}` : '');

function DayPicker({ value, onChange, label }: { value: string; onChange: (date: string) => void; label: string }) {
  return (
    <input
      type="date"
      className="input day-picker"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function checkStatus(c: CheckView): { text: string; tone: string } {
  if (c.status === 'VOID') return { text: 'аннулирован', tone: 'muted' };
  if (c.refunded > 0 && c.refunded >= c.paid) return { text: 'возврат', tone: 'danger' };
  if (c.status === 'PAID') return { text: c.refunded > 0 ? 'оплачен, частичный возврат' : 'оплачен', tone: 'ok' };
  return { text: c.paid > 0 ? 'оплачен частично' : 'ждёт оплаты', tone: 'warn' };
}

/** «Наличные 2 000 ₸, сдача 300 ₸ · Карта 1 600 ₸» — how the check was paid. */
function paymentsSummary(c: CheckView, money: (a: Minor) => string): string {
  return c.payments
    .filter((p) => p.kind === 'PAYMENT')
    .map((p) => {
      const change = p.change != null && p.change > 0 ? `, сдача ${money(p.change)}` : '';
      return `${PAYMENT_METHOD_LABEL[p.method]} ${money(p.amount)}${change}`;
    })
    .join(' · ');
}

/** «Капучино (L · Овсяное) ×2, Круассан» — the lines of a counter check. */
function linesSummary(c: CheckView): string {
  return c.items
    .filter((i) => i.kind === 'ORDER')
    .map((i) => (i.qty && i.qty > 1 ? `${i.title} ×${i.qty}` : i.title))
    .join(', ');
}

/**
 * «Чеки за день»: every check of the working day one by one — number, time, what, sum, status.
 * No day totals (revenue is `stats.view`), so the barista sees it too. The manager and the
 * administrator (`counter.cancel`) cancel a counter order here; a paid one after its refund.
 */
export function DayChecksPanel() {
  const hub = useHub();
  const { state } = hub;
  const { timezone, currency } = state.club;
  const money = (a: Minor) => formatMoney(a, currency);
  const [date, setDate] = useState('');
  const day = useLive(() => getJson<DayChecksView>(`/api/checks/day${dayQuery(date)}`), [date], hub.version);
  const canCancel = hub.canNow('counter.cancel');
  const [cancelling, setCancelling] = useState<CancelTarget | null>(null);
  const [receipt, setReceipt] = useState<CheckView | null>(null);
  const names = new Map(state.tables.map((t) => [t.id, t.name]));
  const rows = day.data?.checks ?? [];

  return (
    <SectionCard
      title="Чеки за день"
      className="day-checks"
      actions={<DayPicker label="День" value={day.data?.date ?? date} onChange={setDate} />}
    >
      {day.data === null ? (
        <p className="hint">{day.error ?? 'Загрузка…'}</p>
      ) : rows.length === 0 ? (
        <EmptyState icon="checks" title="Чеков нет">
          За этот день (с 06:00) чеков не было.
        </EmptyState>
      ) : (
        <ul className="rows day-rows">
          {rows.map(({ check: c, orders }) => {
            const status = checkStatus(c);
            const counter = orders.filter((o) => o.number !== null);
            const live = counter.filter((o) => o.status !== 'CANCELLED');
            const net = c.paid - c.refunded;
            const what = counter.length ? linesSummary(c) : checkSummary(c, names, money);
            const paidBy = paymentsSummary(c, money);
            const cancellable = canCancel && live.length > 0 && c.status !== 'VOID';
            return (
              <li key={c.id} className="row-item day-row">
                <div className="row-main">
                  <strong>
                    Счёт №{c.number}
                    {counter.length > 0 && <span className="muted"> · заказ №{counter.map((o) => o.number).join(', №')}</span>}
                  </strong>
                  <span className="row-sub">
                    {formatClock(c.closedAt ?? c.createdAt, timezone)} · {c.createdBy}
                    {what ? ` · ${what}` : ''}
                  </span>
                  {paidBy && <span className="row-sub">{paidBy}</span>}
                  <span className="day-row-actions">
                    {c.status !== 'VOID' && (
                      <button type="button" className="btn btn-small" onClick={() => setReceipt(c)}>
                        Чек
                      </button>
                    )}
                    {cancellable &&
                      (net > 0 ? (
                        <span className="hint">Отменить можно после возврата денег («Чеки смены» → «Возврат»)</span>
                      ) : (
                        live.map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            className="btn btn-small btn-outline-danger"
                            onClick={() =>
                              setCancelling({ orderId: o.id, number: o.number, total: c.total, summary: what || undefined })
                            }
                          >
                            Отменить заказ №{o.number}
                          </button>
                        ))
                      ))}
                  </span>
                </div>
                <span className={`tag tag-${status.tone}`}>{status.text}</span>
                <span className="row-sub">{c.refunded > 0 ? `возврат ${money(c.refunded)}` : ''}</span>
                <span className="row-amount">{money(c.total)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {cancelling && (
        <CounterCancelDialog
          target={cancelling}
          actor={hub.actor}
          currency={currency}
          onClose={() => setCancelling(null)}
          onDone={(message) => {
            setCancelling(null);
            hub.notify(message);
            void hub.refresh();
          }}
        />
      )}
      {receipt && <ReceiptDialog check={receipt} onClose={() => setReceipt(null)} />}
    </SectionCard>
  );
}

function entryWho(e: ArchiveEntry): string {
  const parts = [e.by ?? '—'];
  if (e.approvedBy && e.approvedBy !== e.by) parts.push(`подтвердил ${e.approvedBy}`);
  return parts.join(', ');
}

/**
 * «Архив»: what was cancelled, refunded or voided on the chosen working day — number, time,
 * sum, who and why. Nothing in TS is deleted; this is where a «deleted» check is found.
 */
export function ArchivePanel() {
  const hub = useHub();
  const { timezone, currency } = hub.state.club;
  const money = (a: Minor) => formatMoney(a, currency);
  const [date, setDate] = useState('');
  const archive = useLive(() => getJson<ArchiveView>(`/api/archive${dayQuery(date)}`), [date], hub.version);
  const a = archive.data;
  const [receipt, setReceipt] = useState<CheckView | null>(null);
  // A refund's check, as it stands now (with the refund on it): «Чек» shows and reprints it.
  const openReceipt = (checkId: string) =>
    void hub.run(`receipt:${checkId}`, async () => setReceipt(await getJson<CheckView>(`/api/checks/${encodeURIComponent(checkId)}`)));

  return (
    <SectionCard
      title="Архив"
      className="archive"
      actions={<DayPicker label="День архива" value={a?.date ?? date} onChange={setDate} />}
    >
      <p className="hint">
        Чеки не удаляются. Здесь отменённые заказы, возвраты и аннулированные счета за день — с временем, суммой, кто и почему.
      </p>
      {a === null ? (
        <p className="hint">{archive.error ?? 'Загрузка…'}</p>
      ) : a.entries.length === 0 ? (
        <EmptyState icon="journal" title="Архив пуст">
          За этот день (с 06:00) отмен и возвратов не было.
        </EmptyState>
      ) : (
        <>
          <p className="archive-sum">
            Отменено: <strong>{a.cancelled.count}</strong> на <strong>{money(a.cancelled.total)}</strong>
            {a.refunds.count > 0 && (
              <>
                {' '}
                · Возвратов: <strong>{a.refunds.count}</strong> на <strong>{money(a.refunds.total)}</strong>
              </>
            )}
          </p>
          <ul className="rows archive-rows">
            {a.entries.map((e) => (
              <li key={`${e.kind}:${e.id}`} className="row-item archive-row" data-kind={e.kind}>
                <div className="row-main">
                  <strong>
                    {e.title}
                    {e.kind === 'ORDER' && e.checkNumber !== null && <span className="muted"> · счёт №{e.checkNumber}</span>}
                  </strong>
                  {e.detail && <span className="row-sub">{e.detail}</span>}
                  <span className="archive-why">
                    {e.reason ? `«${e.reason}»` : 'без причины'} · {entryWho(e)}
                  </span>
                  {e.kind === 'REFUND' && e.checkId && (
                    <span className="day-row-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        disabled={hub.isBusy(`receipt:${e.checkId}`)}
                        onClick={() => e.checkId && openReceipt(e.checkId)}
                      >
                        Чек
                      </button>
                    </span>
                  )}
                </div>
                <span className={`tag ${e.kind === 'REFUND' ? 'tag-warn' : e.kind === 'VOID' ? 'tag-muted' : 'tag-danger'}`}>
                  {ARCHIVE_KIND_LABEL[e.kind]}
                </span>
                <span className="row-sub">{formatClock(e.at, timezone)}</span>
                <span className="row-amount">{e.kind === 'VOID' ? '—' : money(e.amount)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {receipt && <ReceiptDialog check={receipt} onClose={() => setReceipt(null)} />}
    </SectionCard>
  );
}
