import type { StaffGuestRequestView } from '@bills/domain';
import type { Draft } from '../cafe/pos-model.ts';
import { emptyDraft, lineId } from '../cafe/pos-model.ts';
import { useHub } from '../useHub.tsx';
import { rejectGuestRequest } from './api.ts';
import { reloadGuestRequests, useGuestRequests } from './store.ts';
import './guest.css';

/** An order ahead as a draft of «Касса»: the cashier checks it and takes the payment as usual. */
export function draftOfGuestOrder(r: StaffGuestRequestView, service: Draft['service']): Draft {
  return {
    ...emptyDraft(service),
    guestName: r.guestName ?? '',
    guestRequestId: r.id,
    lines: r.lines.map((l, i) => ({
      id: lineId(),
      productId: l.productId,
      choices: [...(l.options ?? [])],
      qty: l.qty,
      comments: [],
      text: i === 0 && r.note ? r.note : '',
    })),
  };
}

/**
 * Orders ahead from the guest QR page on «Касса»: «Заказ гостя: Аня, 2 позиции». A tap
 * loads it into the order panel; paying it links the counter order to the guest, whose
 * page then shows the number and the stage. × rejects it.
 */
export function PosGuestOrders({ loaded, onLoad }: { loaded: ReadonlySet<string>; onLoad: (r: StaffGuestRequestView) => void }) {
  const hub = useHub();
  const data = useGuestRequests(hub.version);
  const orders = (data?.requests ?? []).filter((r) => r.kind === 'PREORDER' && r.status === 'PENDING' && !loaded.has(r.id));
  if (orders.length === 0) return null;
  return (
    <div className="pos-guest" role="group" aria-label="Заказы гостей по QR">
      {orders.map((r) => (
        <span key={r.id} className="pos-guest-chip">
          <button type="button" onClick={() => onLoad(r)} title="Загрузить в заказ и принять оплату">
            {r.summary}
          </button>
          <button
            type="button"
            aria-label={`Отклонить: ${r.summary}`}
            title="Отклонить"
            disabled={hub.isBusy(`guest:${r.id}`)}
            onClick={() =>
              void hub.run(`guest:${r.id}`, () => rejectGuestRequest(hub.actor, r.id, 'Не принят на кассе')).finally(reloadGuestRequests)
            }
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
