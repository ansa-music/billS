import type { Minor, ProductOptionGroup } from '@bills/domain';
import { OPTION_CHOICES_MAX, OPTION_GROUPS_MAX, OPTION_NAME_MAX } from '@bills/domain';
import { Icon } from '../../icons.tsx';
import { parseMajor, toMajorText } from './money.tsx';
import '../../cafe/cafe.css';

/**
 * Product options in the menu editor: groups («Размер», «Молоко», «Сироп») and
 * their choices with a price change. The draft keeps prices as typed; `toGroups`
 * turns it into what the HUB stores (validated with validateOptionGroups).
 */

export interface ChoiceDraft {
  id: string;
  name: string;
  /** "+100", "-50", "0" — major units, a sign is allowed. */
  delta: string;
}

export interface GroupDraft {
  id: string;
  name: string;
  required: boolean;
  multiple: boolean;
  choices: ChoiceDraft[];
}

/** Ids only have to be unique within the product: lines refer to choices by them. */
function newId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

function deltaText(minor: Minor, currency: string): string {
  if (minor === 0) return '0';
  return `${minor > 0 ? '+' : '-'}${toMajorText(Math.abs(minor), currency)}`;
}

/** "+100" / "-50" / "" → minor units; null when it is not a number. */
export function parseDelta(text: string, currency: string): Minor | null {
  const t = text.replace(/\s/g, '').replace('−', '-');
  if (t === '' || t === '+' || t === '-') return 0;
  const negative = t.startsWith('-');
  const abs = parseMajor(t.replace(/^[+-]/, ''), currency);
  if (abs === null) return null;
  return negative ? -abs : abs;
}

export function toDraft(groups: readonly ProductOptionGroup[], currency: string): GroupDraft[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    required: g.required,
    multiple: g.multiple,
    choices: g.choices.map((c) => ({ id: c.id, name: c.name, delta: deltaText(c.priceDelta, currency) })),
  }));
}

/** The draft as the HUB takes it, or the first problem with a price. */
export function toGroups(draft: readonly GroupDraft[], currency: string): { groups: ProductOptionGroup[] } | { error: string } {
  const groups: ProductOptionGroup[] = [];
  for (const [gi, g] of draft.entries()) {
    const choices = [];
    for (const [ci, c] of g.choices.entries()) {
      const priceDelta = parseDelta(c.delta, currency);
      if (priceDelta === null) {
        return { error: `«${g.name || `Группа ${gi + 1}`}», вариант ${ci + 1}: надбавка — число, например +100 или -50` };
      }
      choices.push({ id: c.id, name: c.name, priceDelta });
    }
    groups.push({ id: g.id, name: g.name, required: g.required, multiple: g.multiple, choices });
  }
  return { groups };
}

const move = <T,>(list: readonly T[], from: number, to: number): T[] => {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
};

export function OptionsEditor({
  groups,
  onChange,
  currency,
  disabled,
}: {
  groups: GroupDraft[];
  onChange: (groups: GroupDraft[]) => void;
  currency: string;
  disabled?: boolean;
}) {
  const setGroup = (gi: number, patch: Partial<GroupDraft>) =>
    onChange(groups.map((g, i) => (i === gi ? { ...g, ...patch } : g)));
  const setChoice = (gi: number, ci: number, patch: Partial<ChoiceDraft>) =>
    setGroup(gi, { choices: groups[gi]!.choices.map((c, i) => (i === ci ? { ...c, ...patch } : c)) });

  const addGroup = () =>
    onChange([
      ...groups,
      {
        id: newId('g'),
        name: groups.length === 0 ? 'Размер' : '',
        required: groups.length === 0,
        multiple: false,
        choices: [{ id: newId('c'), name: '', delta: '0' }],
      },
    ]);

  return (
    <div className="opt-editor">
      {groups.length === 0 && (
        <p className="hint">
          Нет добавок. Для напитков добавьте, например, «Размер» (обязательно: S, M, L), «Молоко» (по желанию), «Сироп»
          (можно несколько).
        </p>
      )}
      {groups.map((g, gi) => (
        <fieldset key={g.id} className="opt-group" disabled={disabled}>
          <div className="opt-group-head">
            <input
              className="opt-group-name"
              aria-label="Название группы"
              placeholder="Например: Молоко"
              value={g.name}
              maxLength={OPTION_NAME_MAX}
              onChange={(e) => setGroup(gi, { name: e.target.value })}
            />
            <span className="opt-tools">
              <button type="button" className="opt-icon" aria-label="Группу выше" disabled={gi === 0} onClick={() => onChange(move(groups, gi, gi - 1))}>
                ↑
              </button>
              <button
                type="button"
                className="opt-icon"
                aria-label="Группу ниже"
                disabled={gi === groups.length - 1}
                onClick={() => onChange(move(groups, gi, gi + 1))}
              >
                ↓
              </button>
              <button type="button" className="opt-icon opt-danger" aria-label="Удалить группу" onClick={() => onChange(groups.filter((_, i) => i !== gi))}>
                <Icon name="trash" size={16} />
              </button>
            </span>
          </div>
          <div className="opt-flags">
            <label className="bar-switch" data-on={g.required ? '' : undefined}>
              <input type="checkbox" checked={g.required} onChange={(e) => setGroup(gi, { required: e.target.checked })} />
              обязательно
            </label>
            <label className="bar-switch" data-on={g.multiple ? '' : undefined}>
              <input type="checkbox" checked={g.multiple} onChange={(e) => setGroup(gi, { multiple: e.target.checked })} />
              можно несколько
            </label>
          </div>
          <ul className="opt-choices">
            {g.choices.map((c, ci) => (
              <li key={c.id}>
                <input
                  aria-label="Вариант"
                  placeholder={gi === 0 ? 'Например: L' : 'Вариант'}
                  value={c.name}
                  maxLength={OPTION_NAME_MAX}
                  onChange={(e) => setChoice(gi, ci, { name: e.target.value })}
                />
                <input
                  className="opt-delta"
                  aria-label={`Надбавка, ${currency}`}
                  inputMode="decimal"
                  placeholder="+0"
                  value={c.delta}
                  onChange={(e) => setChoice(gi, ci, { delta: e.target.value })}
                />
                <span className="opt-tools">
                  <button
                    type="button"
                    className="opt-icon"
                    aria-label="Выше"
                    disabled={ci === 0}
                    onClick={() => setGroup(gi, { choices: move(g.choices, ci, ci - 1) })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="opt-icon opt-danger"
                    aria-label="Удалить вариант"
                    disabled={g.choices.length === 1}
                    onClick={() => setGroup(gi, { choices: g.choices.filter((_, i) => i !== ci) })}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-small"
            disabled={g.choices.length >= OPTION_CHOICES_MAX}
            onClick={() => setGroup(gi, { choices: [...g.choices, { id: newId('c'), name: '', delta: '0' }] })}
          >
            + Вариант
          </button>
          {g.required && <p className="hint">Первый вариант выбран на кассе сразу.</p>}
        </fieldset>
      ))}
      <button type="button" className="btn btn-small" disabled={disabled || groups.length >= OPTION_GROUPS_MAX} onClick={addGroup}>
        + Группа добавок
      </button>
    </div>
  );
}
