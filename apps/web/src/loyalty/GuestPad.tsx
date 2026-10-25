import { useEffect, useRef, useState } from 'react';
import type { LoyaltyGuestCard, LoyaltySettings } from '@bills/domain';
import { GUEST_NAME_MAX } from '@bills/domain';
import { toActionError } from '../cash/desk.ts';
import { guestStatus, lookupGuest, phoneMask } from './model.ts';
import './loyalty.css';

/** A guest picked on the keypad: the ten digits after +7, what the HUB knows, an optional name. */
export interface PickedGuest {
  digits: string;
  card: LoyaltyGuestCard;
  known: boolean;
  /** For a new number: the name typed here (shown on the guest screen too). */
  name: string;
}

/**
 * «Гость»: ten digits on a big keypad (the last 10 of the number), the HUB answers at once
 * with who it is — «Аня · 3 из 6 до подарка» or «Бонусов: 450 ₸». A new number is only
 * remembered: the guest is created when the order is paid. Keys work too: digits, ⌫, Enter, Esc.
 */
export function GuestPad({
  settings,
  currency,
  initial,
  onDone,
  onRemove,
  onClose,
}: {
  settings: LoyaltySettings;
  currency: string;
  initial: PickedGuest | null;
  onDone: (guest: PickedGuest) => void;
  onRemove: (() => void) | null;
  onClose: () => void;
}) {
  const [digits, setDigits] = useState(initial?.digits ?? '');
  const [found, setFound] = useState<{ digits: string; card: LoyaltyGuestCard; known: boolean } | null>(
    initial ? { digits: initial.digits, card: initial.card, known: initial.known } : null,
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Ten digits → ask the HUB (a keypad that waits for «Найти» would cost a tap).
  useEffect(() => {
    if (digits.length !== 10 || found?.digits === digits) return;
    let alive = true;
    setLoading(true);
    setError(null);
    lookupGuest(digits).then(
      (res) => {
        if (!alive) return;
        setFound({ digits, card: res.guest, known: res.known });
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(toActionError(e).message);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [digits, found?.digits]);

  const ready = found !== null && found.digits === digits && !loading;
  const done = () => {
    if (!ready || !found) return;
    onDone({ digits, card: found.card, known: found.known, name: found.known ? (found.card.name ?? '') : name.trim() });
  };
  const press = (k: string) => {
    setError(null);
    if (k === '⌫') setDigits((d) => d.slice(0, -1));
    else if (k === 'C') setDigits('');
    else setDigits((d) => (d.length >= 10 ? d : d + k));
  };

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const inName = e.target === nameRef.current;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      done();
      return;
    }
    if (inName) return;
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      press(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      press('⌫');
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, []);

  return (
    <div className="loy-pad" role="dialog" aria-label="Гость по номеру телефона">
      <div className="loy-pad-head">
        <strong>Гость</strong>
        <button type="button" className="loy-pad-x" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </div>
      <output className="loy-phone" data-empty={digits.length === 0 || undefined} aria-label="Номер телефона">
        {phoneMask(digits)}
      </output>
      <div className="loy-result" aria-live="polite">
        {error ? (
          <span className="loy-error">{error}</span>
        ) : loading ? (
          <span className="muted">Ищем…</span>
        ) : ready && found ? (
          found.known ? (
            <span>
              <strong>{found.card.name ?? 'Гость'}</strong> · {guestStatus(found.card, settings, currency)}
            </span>
          ) : (
            <span>
              <strong>Новый гость</strong> · карта появится после оплаты
            </span>
          )
        ) : (
          <span className="muted">Последние 10 цифр номера</span>
        )}
      </div>
      {ready && found && !found.known && (
        <input
          ref={nameRef}
          className="loy-name"
          value={name}
          maxLength={GUEST_NAME_MAX}
          placeholder="Имя (необязательно)"
          aria-label="Имя гостя"
          autoComplete="off"
          onChange={(e) => setName(e.target.value)}
        />
      )}
      <div className="loy-keys" role="group" aria-label="Цифры номера">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k) => (
          <button key={k} type="button" aria-label={k === '⌫' ? 'Стереть' : k === 'C' ? 'Очистить номер' : k} onClick={() => press(k)}>
            {k}
          </button>
        ))}
      </div>
      <div className="loy-pad-actions">
        {onRemove && (
          <button type="button" className="btn btn-ghost" onClick={onRemove}>
            Без гостя
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={done}>
          Готово
        </button>
      </div>
    </div>
  );
}
