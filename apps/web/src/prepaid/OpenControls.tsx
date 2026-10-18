import './prepaid.css';
import { useId } from 'react';
import { formatPrepaidMinutes, NO_SHIFT_HINT, PRESET_MINUTES } from './prepaid.ts';

/** «Без лимита / 30 мин / 1 ч …» next to «Открыть» on a free table. Null = no limit. */
export function DurationSelect({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (minutes: number | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className="prepaid-select"
      aria-label="Время игры"
      value={value ?? ''}
      disabled={disabled}
      data-set={value != null || undefined}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
    >
      <option value="">Без лимита</option>
      {PRESET_MINUTES.map((m) => (
        <option key={m} value={m}>
          {formatPrepaidMinutes(m)}
        </option>
      ))}
    </select>
  );
}

/** Opens the prepaid dialog; without an open cash shift it is disabled and says why. */
export function PrepaidButton({
  shiftOpen,
  disabled,
  onClick,
}: {
  shiftOpen: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const hintId = useId();
  return (
    <>
      <button
        type="button"
        className="btn prepaid-btn"
        disabled={disabled || !shiftOpen}
        aria-describedby={shiftOpen ? undefined : hintId}
        title={shiftOpen ? 'Открыть на время и сразу принять оплату' : NO_SHIFT_HINT}
        onClick={onClick}
      >
        Предоплата
      </button>
      {!shiftOpen && (
        <p id={hintId} className="hint prepaid-nohint">
          {NO_SHIFT_HINT}
        </p>
      )}
    </>
  );
}
