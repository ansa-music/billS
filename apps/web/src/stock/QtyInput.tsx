import type { IngredientUnit } from '@bills/domain';
import { inputUnits } from './stock.ts';

/**
 * An amount with its unit beside it: coffee is typed in кг or г, milk in л or мл (one tap
 * switches), pieces in шт. The numeric keypad opens on phones and tablets. The value stays
 * text as typed; `factor` says how many base units (г, мл, шт) one typed unit is.
 */
export function QtyInput({
  value,
  factor,
  unit,
  onChange,
  label,
  placeholder = '0',
  autoFocus,
  disabled,
  invalid,
}: {
  value: string;
  factor: number;
  unit: IngredientUnit;
  onChange: (text: string, factor: number) => void;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const units = inputUnits(unit);
  return (
    <div className="stock-qty-field" data-units={units.length}>
      <input
        inputMode="decimal"
        enterKeyHint="next"
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value, factor)}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        {...(autoFocus ? { 'data-autofocus': '' } : {})}
      />
      {units.length > 1 ? (
        <span className="stock-unit-switch" role="group" aria-label={`${label}: единица`}>
          {units.map((u) => (
            <button
              key={u.label}
              type="button"
              aria-pressed={u.factor === factor}
              disabled={disabled}
              onClick={() => onChange(value, u.factor)}
            >
              {u.label}
            </button>
          ))}
        </span>
      ) : (
        <span className="stock-unit-static">{units[0]!.label}</span>
      )}
    </div>
  );
}
