import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ClubAdminView } from '@bills/domain';

/** What every settings section gets from the page. */
export interface SectionProps {
  club: ClubAdminView;
  /** The HUB is reachable; otherwise every save button is disabled. */
  online: boolean;
  isBusy: (key: string) => boolean;
  /** POST through useCommands: adds the actor, refreshes state, reports errors through the toast. */
  run: <T>(key: string, path: string, body?: object) => Promise<T | undefined>;
  /** Called with the HUB's answer after a successful save. */
  onSaved: (club: ClubAdminView, message?: string) => void;
  /** Re-reads GET /api/club (after a command whose answer is only a part of it) and shows the message. */
  reload: (message?: string) => Promise<void>;
}

/**
 * A form draft that follows the server value until the person starts editing:
 * live updates from another tablet do not wipe what is being typed.
 */
export function useDraft<T>(server: T): {
  draft: T;
  setDraft: (next: T | ((prev: T) => T)) => void;
  dirty: boolean;
  reset: () => void;
} {
  const key = JSON.stringify(server);
  const [draft, setDraft] = useState<T>(server);
  const [baseKey, setBaseKey] = useState(key);
  if (key !== baseKey) {
    const wasDirty = JSON.stringify(draft) !== baseKey;
    setBaseKey(key);
    if (!wasDirty) setDraft(server);
  }
  return { draft, setDraft, dirty: JSON.stringify(draft) !== key, reset: () => setDraft(server) };
}

// ── Money in major units for inputs (the HUB only ever sees minor integers) ──

const digitsCache = new Map<string, number>();

export function currencyDigits(currency: string): number {
  let d = digitsCache.get(currency);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    digitsCache.set(currency, d);
  }
  return d;
}

/** 200000 (minor) → "2000" for an input field. */
export function toMajor(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  const major = minor / 10 ** digits;
  return Number.isInteger(major) ? String(major) : major.toFixed(digits);
}

/** "2000" or "2 000,50" → 200050 (minor); null when it is not a non-negative amount. */
export function fromMajor(text: string, currency: string): number | null {
  const cleaned = text.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d*)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10 ** currencyDigits(currency));
}

/** "30" → 30; null when it is not a non-negative integer. */
export function toInt(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

export const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

export const CURRENCIES = ['KZT', 'RUB', 'USD', 'EUR', 'UZS', 'KGS'] as const;

export const TIME_ZONES = [
  'Asia/Almaty',
  'Asia/Aqtobe',
  'Asia/Aqtau',
  'Asia/Qyzylorda',
  'Asia/Oral',
  'Europe/Moscow',
  'Asia/Tashkent',
  'Asia/Bishkek',
] as const;

export function SaveBar({
  dirty,
  canSave = dirty,
  busy,
  disabled,
  onSave,
  onReset,
  label = 'Сохранить',
  children,
}: {
  dirty: boolean;
  /** The draft is valid; defaults to `dirty`. */
  canSave?: boolean;
  busy: boolean;
  disabled?: boolean;
  onSave: () => void;
  onReset: () => void;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <div className="form-actions settings-save">
      <button type="button" className="btn btn-primary" disabled={disabled || busy || !dirty || !canSave} onClick={onSave}>
        {busy ? 'Сохраняем…' : label}
      </button>
      {dirty && (
        <button type="button" className="btn btn-ghost btn-narrow" disabled={busy} onClick={onReset}>
          Отменить
        </button>
      )}
      {children}
    </div>
  );
}
