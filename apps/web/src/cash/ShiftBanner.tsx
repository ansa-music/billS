import { useState } from 'react';
import { useHub } from '../useHub.tsx';
import { useDesk } from './desk.ts';
import { Modal } from './Modal.tsx';
import { OpenShiftForm } from './ShiftPanel.tsx';

/**
 * «Смена не открыта» across the top of the hall and the checks, with the button
 * right there: without an open shift no payment can be taken. Shown only to
 * people who may open a shift (`shift.open`); nothing while a shift is open.
 */
export function ShiftBanner({ text = 'Чтобы принимать оплату, откройте смену.' }: { text?: string }) {
  const hub = useHub();
  const { state } = hub;
  const desk = useDesk({ state, actor: hub.actor, refresh: hub.refresh, notify: hub.notify });
  const [open, setOpen] = useState(false);
  if (state.shift || !hub.canNow('shift.open')) return null;
  return (
    <>
      <div className="shift-banner" role="status">
        <p>
          <strong>Смена не открыта.</strong> {text}
        </p>
        <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
          Открыть смену
        </button>
      </div>
      {open && (
        <Modal title="Открыть смену" onClose={() => setOpen(false)}>
          <OpenShiftForm
            desk={desk}
            onOpened={() => {
              setOpen(false);
              hub.notify('Смена открыта');
            }}
          />
        </Modal>
      )}
    </>
  );
}
