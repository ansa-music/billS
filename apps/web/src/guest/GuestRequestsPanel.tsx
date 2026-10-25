import type { StaffGuestRequestView } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { formatAgo } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useHub } from '../useHub.tsx';
import { acceptGuestRequest, rejectGuestRequest } from './api.ts';
import { reloadGuestRequests, useGuestRequests } from './store.ts';
import './guest.css';

const ACCEPTED_TEXT: Record<StaffGuestRequestView['kind'], string> = {
  WAITER: 'Принято — подойдите к столу',
  BAR: 'Заказ добавлен к игре',
  EXTEND: 'Принято — продлите игру гостям',
  BILL: 'Принято — принесите счёт',
  PREORDER: 'Заказ принят',
};

/** Pending requests of the hall's tables, for the hall screen. */
function pendingOfTables(list: StaffGuestRequestView[] | undefined): StaffGuestRequestView[] {
  return (list ?? []).filter((r) => r.status === 'PENDING' && r.tableId !== null);
}

/**
 * «Запросы гостей» on the hall: what guests asked for from the QR page, oldest first,
 * with «Принять» (a bar request becomes an order on the game, by this employee) and
 * «Отклонить». Hidden while there is nothing pending.
 */
export function GuestRequestsPanel() {
  const hub = useHub();
  const data = useGuestRequests(hub.version);
  const pending = pendingOfTables(data?.requests);
  if (pending.length === 0) return null;
  const money = (a: number) => formatMoney(a, hub.state.club.currency);

  const act = (r: StaffGuestRequestView, accept: boolean) =>
    void hub
      .run(`guest:${r.id}`, async () => {
        if (accept) await acceptGuestRequest(hub.actor, r.id);
        else await rejectGuestRequest(hub.actor, r.id);
        hub.notify(accept ? `${r.tableName ?? 'Стол'}: ${ACCEPTED_TEXT[r.kind]}` : `${r.tableName ?? 'Стол'}: запрос отклонён`);
      })
      .finally(reloadGuestRequests);

  return (
    <section className="guest-panel" aria-label="Запросы гостей">
      <h2>
        <Icon name="bell" size={20} /> Запросы гостей <span className="guest-badge-card">{pending.length}</span>
      </h2>
      <ul>
        {pending.map((r) => {
          const busy = hub.isBusy(`guest:${r.id}`) || !hub.online;
          const canAccept = r.kind === 'BAR' ? hub.canNow('order.create') : true;
          return (
            <li key={r.id}>
              <div className="guest-panel-what">
                <strong>
                  {r.tableName}: {r.summary}
                </strong>
                <span>
                  {r.items.length > 0 && `${r.items.map((i) => `${i.qty > 1 ? `${i.qty} × ` : ''}${i.title}`).join(', ')} · ${money(r.total)} · `}
                  {r.note ? `«${r.note}» · ` : ''}
                  {formatAgo(hub.serverNow - r.createdAt)}
                </span>
              </div>
              <div className="guest-panel-tools">
                <button type="button" className="btn btn-primary btn-small" disabled={busy || !canAccept} onClick={() => act(r, true)}>
                  Принять
                </button>
                <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => act(r, false)}>
                  Отклонить
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A badge on a table card or the drawer: «QR: 2» while guests of this table wait. */
export function GuestBadge({ tableId }: { tableId: string }) {
  const hub = useHub();
  const data = useGuestRequests(hub.version);
  const n = pendingOfTables(data?.requests).filter((r) => r.tableId === tableId).length;
  if (n === 0) return null;
  return (
    <span className="guest-badge-card" title="Гости ждут: запросы с QR-кода" aria-label={`Запросов гостей: ${n}`}>
      <Icon name="bell" size={12} /> {n}
    </span>
  );
}
