import type { CheckView } from '@bills/domain';
import { useHub } from '../useHub.tsx';
import { Modal } from './Modal.tsx';
import { usePaper } from './print/paper.ts';
import { printReceipt, ReceiptPreview, receiptOf } from './print/Receipt.tsx';

/**
 * «Чек» of a check of the day or of the archive: the receipt on screen exactly as it prints
 * (same receiptOf as the print after payment), and «Печать» for a copy.
 */
export function ReceiptDialog({ check, onClose }: { check: CheckView; onClose: () => void }) {
  const { state } = useHub();
  const paper = usePaper();
  const names = new Map(state.tables.map((t) => [t.id, t.name]));
  const data = receiptOf(check, state, { names });
  return (
    <Modal
      title={`Чек · счёт №${check.number}`}
      onClose={onClose}
      className="modal-receipt"
      footer={
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Закрыть
          </button>
          <button type="button" className="btn btn-primary" data-autofocus onClick={() => printReceipt(check, state, { names })}>
            Печать
          </button>
        </div>
      }
    >
      <ReceiptPreview data={data} paper={paper} />
    </Modal>
  );
}
