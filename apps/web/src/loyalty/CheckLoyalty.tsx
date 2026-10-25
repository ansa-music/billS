import { useEffect, useState } from 'react';
import type { CheckLoyaltyRequest, CheckLoyaltyView, CheckView, LoyaltySettings } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { toActionError } from '../cash/desk.ts';
import { FormError } from '../cash/Modal.tsx';
import { Icon } from '../icons.tsx';
import { GuestPad } from './GuestPad.tsx';
import { fetchCheckLoyalty, giftOrdinal, guestStatus } from './model.ts';
import './loyalty.css';

/**
 * «Гость» in the pay dialog of a billiards check (and of any check paid in «Счета»): the same
 * keypad as the counter, then one tap for the gift or the bonuses. The reward is the check's
 * discount; bonuses are earned when the check is paid.
 */
export function CheckLoyalty({
  check,
  settings,
  currency,
  editable,
  send,
  onCheck,
}: {
  check: CheckView;
  settings: LoyaltySettings;
  currency: string;
  /** Open and nothing paid yet: the guest and the reward may change. */
  editable: boolean;
  send: <T>(path: string, body?: object) => Promise<T>;
  onCheck: (next: CheckView) => void;
}) {
  const money = (a: number) => formatMoney(a, currency);
  const [view, setView] = useState<CheckLoyaltyView | null>(null);
  const [padOpen, setPadOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchCheckLoyalty(check.id).then(
      (v) => alive && setView(v),
      () => alive && setView(null),
    );
    return () => {
      alive = false;
    };
  }, [check.id, check.updatedAt]);

  const call = async (path: string, body: object = {}) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await send<{ loyalty: CheckLoyaltyView; check: CheckView }>(path, body);
      setView(res.loyalty);
      onCheck(res.check);
      setPadOpen(false);
    } catch (e) {
      setError(toActionError(e).message);
    } finally {
      setPending(false);
    }
  };
  // Without `phone` the HUB keeps the guest already on the check (the screen only sees it masked).
  const apply = (body: CheckLoyaltyRequest) => call(`/api/checks/${check.id}/loyalty`, body);

  const guest = view?.guest ?? null;
  if (!settings.enabled && !guest) return null;

  if (!view || !guest) {
    if (!editable || !settings.enabled) return null;
    return (
      <div className="loy-box">
        {padOpen ? (
          <GuestPad
            settings={settings}
            currency={currency}
            initial={null}
            onDone={(g) => void apply({ phone: g.digits, ...(g.name && !g.known ? { name: g.name } : {}) })}
            onRemove={null}
            onClose={() => setPadOpen(false)}
          />
        ) : (
          <div className="loy-box-row">
            <span className="muted">Гость по номеру телефона — бонусы и подарки</span>
            <button type="button" className="btn btn-small" onClick={() => setPadOpen(true)}>
              <Icon name="user" size={16} /> Гость
            </button>
          </div>
        )}
        <FormError error={error} />
      </div>
    );
  }

  const { applied, offer } = view;
  const open = view.status === 'OPEN';
  return (
    <div className="loy-box">
      <div className="loy-box-row">
        <span>
          <strong>{guest.name ?? 'Гость'}</strong> <span className="muted">{guest.phone}</span>
          {' · '}
          {view.known ? guestStatus(guest, settings, currency) : 'новый гость'}
        </span>
        {open && editable && (
          <button type="button" className="btn btn-small btn-ghost" disabled={pending} onClick={() => void call(`/api/checks/${check.id}/loyalty/remove`)}>
            Без гостя
          </button>
        )}
      </div>
      {open && editable && applied.discount > 0 && (
        <button type="button" className="loy-offer" aria-pressed="true" disabled={pending} onClick={() => void apply({})}>
          <span>✓ {applied.kind === 'FREE' ? `${giftOrdinal(settings.stampsEvery)} в подарок` : 'Бонусами'}</span>
          <small>−{money(applied.discount)} · отменить</small>
        </button>
      )}
      {open && editable && applied.discount === 0 && settings.program === 'stamps' && offer.freeUnits > 0 && (
        <button
          type="button"
          className="loy-offer"
          aria-pressed="false"
          disabled={pending}
          onClick={() => void apply({ free: true, expectDiscount: offer.freeDiscount })}
        >
          <span>{giftOrdinal(settings.stampsEvery)} напиток в подарок — применить?</span>
          <small>−{money(offer.freeDiscount)}</small>
        </button>
      )}
      {open && editable && applied.discount === 0 && settings.program === 'cashback' && offer.redeemMax > 0 && (
        <button
          type="button"
          className="loy-offer"
          aria-pressed="false"
          disabled={pending}
          onClick={() => void apply({ redeem: offer.redeemMax, expectDiscount: offer.redeemMax })}
        >
          <span>Списать {money(offer.redeemMax)} бонусами?</span>
          <small>−{money(offer.redeemMax)}</small>
        </button>
      )}
      {open && <span className="hint">Бонусы и штампы начислятся, когда счёт будет оплачен.</span>}
      {view.status === 'PAID' && view.accrued && (
        <span className="hint">
          {settings.program === 'stamps' ? `Штампов за счёт: ${view.accrued.stamps}` : `Начислено бонусами: ${money(view.accrued.bonus)}`}
        </span>
      )}
      {view.status === 'REVERSED' && <span className="hint">Деньги вернули — начисления по счёту отменены.</span>}
      <FormError error={error} />
    </div>
  );
}
