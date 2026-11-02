import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  IngredientUnit,
  IngredientView,
  Minor,
  ProductOptionChoice,
  ProductView,
  Recipe,
  RecipeOptionLine,
  RecipeOptionMode,
  RecipesView,
  RecipeView,
} from '@bills/domain';
import {
  describeOptionLine,
  formatMoney,
  INGREDIENT_UNITS,
  marginPercent,
  RECIPE_OPTION_MODE_LABEL,
  RECIPE_OPTION_MODES,
  recipeCost,
  recipeUsage,
} from '@bills/domain';
import { fetchJson } from '../api.ts';
import { FormError } from '../cash/Modal.tsx';
import { EmptyState, SectionCard } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { sortCatalog, useCatalog } from '../pages/bar/useCatalog.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { byName, matches, parseQty, plural, qtyText } from './stock.ts';

type Run = <T>(key: string, path: string, body?: object) => Promise<T | undefined>;

interface ItemDraft {
  key: number;
  ingredientId: string;
  quantity: string;
}

interface OptionDraft extends ItemDraft {
  choiceId: string;
  mode: RecipeOptionMode;
  replacesId: string;
}

let nextKey = 1;

/** The «new ingredient» choice at the end of every ingredient picker. */
const NEW = '__new__';

/**
 * «Состав»: pick a menu item, say what one portion takes (граммовка) and what each option changes —
 * in a couple of taps, with a missing ingredient created right here. Items without a recipe are
 * marked: their sales take nothing off the stock.
 */
export function RecipesTab({ ingredients, run, busy, notify }: { ingredients: IngredientView[]; run: Run; busy: boolean; notify: (m: string) => void }) {
  const { state, version, canNow } = useHub();
  const currency = state.club.currency;
  const { catalog } = useCatalog();
  const summaries = useLive(() => fetchJson<RecipesView>('/api/stock/recipes'), [], version);
  const [query, setQuery] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [productId, setProductId] = useState<string | null>(null);

  const sorted = useMemo(() => (catalog ? sortCatalog(catalog) : null), [catalog]);
  const summary = useMemo(() => new Map((summaries.data?.recipes ?? []).map((r) => [r.productId, r])), [summaries.data]);
  const categories = (sorted?.categories ?? []).filter((c) => c.isActive);
  const activeCats = new Set(categories.map((c) => c.id));
  const menu = (sorted?.products ?? []).filter((p) => p.isActive && activeCats.has(p.categoryId));
  const missing = summaries.data ? menu.filter((p) => !summary.has(p.id)) : [];
  const products = menu.filter((p) => matches(p.name, query) && (!onlyMissing || !summary.has(p.id)));
  const product = sorted?.products.find((p) => p.id === productId) ?? null;

  return (
    <div className="stock-tab stock-recipes" data-open={product ? '' : undefined}>
      <SectionCard title="Меню" className="stock-recipe-list">
        {missing.length > 0 && (
          <p className="warn-note">
            {missing.length} {plural(missing.length, 'позиция', 'позиции', 'позиций')} без состава — их продажи не списывают склад.
          </p>
        )}
        <div className="stock-toolbar">
          <label className="stock-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Найти позицию" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Найти позицию меню" />
          </label>
          {missing.length > 0 && (
            <button type="button" className="chip" aria-pressed={onlyMissing} onClick={() => setOnlyMissing((v) => !v)}>
              Без состава
            </button>
          )}
        </div>
        {!sorted ? (
          <p className="muted">Загрузка…</p>
        ) : products.length === 0 ? (
          <EmptyState icon="bar" title={onlyMissing ? 'У всех позиций есть состав' : 'Позиций не нашлось'} />
        ) : (
          categories.map((c) => {
            const inCat = products.filter((p) => p.categoryId === c.id);
            if (inCat.length === 0) return null;
            return (
              <div key={c.id} className="stock-recipe-group">
                <h3>{c.name}</h3>
                {inCat.map((p) => {
                  const s = summary.get(p.id);
                  const margin = s ? marginPercent(p.price, s.cost) : null;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="stock-recipe-pick"
                      aria-pressed={p.id === productId}
                      onClick={() => setProductId(p.id)}
                    >
                      <span className="stock-recipe-pick-name">{p.name}</span>
                      {s ? (
                        <span className="stock-recipe-pick-cost">
                          {formatMoney(s.cost, currency)}
                          {margin !== null && <span className="tag tag-ok">{margin}%</span>}
                        </span>
                      ) : (
                        <span className="tag tag-warn">нет состава</span>
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })
        )}
      </SectionCard>

      {product ? (
        <RecipeEditor
          key={product.id}
          product={product}
          ingredients={ingredients}
          canEdit={canNow('stock.edit')}
          busy={busy}
          run={run}
          notify={notify}
          onBack={() => setProductId(null)}
          onSave={async (recipe) => {
            const saved = await run<RecipeView>(`recipe:${product.id}`, `/api/stock/recipes/${product.id}`, recipe);
            if (saved) notify(saved.items.length || saved.options.length ? `Состав «${product.name}» сохранён` : `Состав «${product.name}» удалён`);
            return saved;
          }}
        />
      ) : (
        <SectionCard className="stock-recipe-empty">
          <EmptyState icon="cup" title="Выберите позицию меню">
            Укажите, сколько сырья уходит на одну порцию (капучино = зерно 18 г + молоко 150 мл) — каждая продажа спишет это со склада, отмена вернёт.
          </EmptyState>
        </SectionCard>
      )}
    </div>
  );
}

function RecipeEditor({
  product,
  ingredients,
  canEdit,
  busy,
  run,
  notify,
  onBack,
  onSave,
}: {
  product: ProductView;
  ingredients: IngredientView[];
  canEdit: boolean;
  busy: boolean;
  run: Run;
  notify: (m: string) => void;
  onBack: () => void;
  onSave: (recipe: Recipe) => Promise<RecipeView | undefined>;
}) {
  const { state } = useHub();
  const currency = state.club.currency;
  const [items, setItems] = useState<ItemDraft[] | null>(null);
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [hadRecipe, setHadRecipe] = useState(false);
  // Ingredients created here, until the list from the HUB has them.
  const [created, setCreated] = useState<IngredientView[]>([]);
  // A picker asked for a new ingredient: which line gets it.
  const [creatingFor, setCreatingFor] = useState<((id: string) => void) | null>(null);

  const load = (r: RecipeView) => {
    setItems(r.items.map((i) => ({ key: nextKey++, ingredientId: i.ingredientId, quantity: qtyText(i.quantity) })));
    setOptions(
      r.options.map((o) => ({
        key: nextKey++,
        choiceId: o.choiceId,
        mode: o.mode,
        ingredientId: o.ingredientId,
        replacesId: o.replacesId ?? '',
        quantity: o.quantity ? qtyText(o.quantity) : '',
      })),
    );
    setHadRecipe(r.items.length + r.options.length > 0);
    setDirty(false);
  };

  useEffect(() => {
    let cancelled = false;
    fetchJson<RecipeView>(`/api/stock/recipes/${product.id}`)
      .then((r) => {
        if (!cancelled) load(r);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [product.id]);

  const all = useMemo(() => [...ingredients, ...created.filter((c) => !ingredients.some((i) => i.id === c.id))], [ingredients, created]);
  const active = useMemo(() => byName(all.filter((i) => !i.isArchived)), [all]);
  const byId = useMemo(() => new Map(all.map((i) => [i.id, i])), [all]);
  const costs = useMemo(() => new Map(all.map((i) => [i.id, i.costPerUnit])), [all]);

  if (!items) {
    return (
      <SectionCard title={product.name} className="stock-recipe-editor">
        {error ? <p className="form-error">{error}</p> : <p className="muted">Загрузка…</p>}
      </SectionCard>
    );
  }

  const recipe: Recipe = {
    items: items
      .filter((i) => i.ingredientId)
      .map((i) => ({ ingredientId: i.ingredientId, quantity: parseQty(i.quantity) ?? 0 })),
    options: options
      .filter((o) => o.ingredientId)
      .map((o): RecipeOptionLine => ({
        choiceId: o.choiceId,
        mode: o.mode,
        ingredientId: o.ingredientId,
        quantity: parseQty(o.quantity) ?? 0,
        ...(o.mode === 'swap' ? { replacesId: o.replacesId || null } : {}),
      })),
  };
  const base = recipeCost(recipeUsage(recipe), costs);
  const margin = marginPercent(product.price, base.cost);
  const change = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setDirty(true);
  };
  const setItem = change((p: Partial<ItemDraft> & { key: number }) => setItems((list) => list!.map((i) => (i.key === p.key ? { ...i, ...p } : i))));
  const setOption = change((p: Partial<OptionDraft> & { key: number }) => setOptions((list) => list.map((o) => (o.key === p.key ? { ...o, ...p } : o))));
  const nameOf = (id: string) => {
    const i = byId.get(id);
    return i ? { name: i.name, unit: i.unit } : undefined;
  };

  const submit = async () => {
    const badItem = items.findIndex((i) => !i.ingredientId || !parseQty(i.quantity));
    if (badItem >= 0) return setError(`Состав, строка ${badItem + 1}: выберите сырьё и количество больше нуля`);
    const seen = new Set<string>();
    const twice = items.find((i) => (seen.has(i.ingredientId) ? true : (seen.add(i.ingredientId), false)));
    if (twice) return setError(`«${byId.get(twice.ingredientId)?.name ?? ''}» в составе дважды — оставьте одну строку`);
    const badOption = options.findIndex((o) => !o.ingredientId || (o.mode === 'swap' && !o.replacesId) || (o.mode === 'add' && !parseQty(o.quantity)));
    if (badOption >= 0) return setError('Добавки: в каждой строке выберите сырьё и количество (для замены — что на что)');
    setError(null);
    const saved = await onSave(recipe);
    if (saved) load(saved);
  };

  const clear = async () => {
    setError(null);
    const saved = await onSave({ items: [], options: [] });
    if (saved) load(saved);
  };

  const createIngredient = async (name: string, unit: IngredientUnit) => {
    const res = await run<IngredientView>('ingredient:new', '/api/stock/ingredients', { name, unit });
    if (res) {
      setCreated((c) => [...c, res]);
      creatingFor?.(res.id);
      setCreatingFor(null);
      notify(`Сырьё «${res.name}» добавлено`);
    }
  };

  const ingredientSelect = (value: string, onChange: (id: string) => void, label: string, extra?: IngredientView[], className?: string) => (
    <select
      className={className}
      value={value}
      onChange={(e) => {
        if (e.target.value === NEW) setCreatingFor(() => onChange);
        else onChange(e.target.value);
      }}
      aria-label={label}
      disabled={!canEdit}
    >
      <option value="">— выберите сырьё —</option>
      {[...active, ...(extra ?? [])].map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}, {i.unit}
        </option>
      ))}
      {canEdit && <option value={NEW}>＋ Новое сырьё…</option>}
    </select>
  );
  // Archived ingredients still in the recipe stay selectable so the line does not go blank.
  const archivedIn = (id: string) => (byId.get(id)?.isArchived ? [byId.get(id)!] : []);
  const addOption = (choiceId: string, mode: RecipeOptionMode) => {
    setOptions((l) => [...l, { key: nextKey++, choiceId, mode, ingredientId: '', replacesId: '', quantity: '' }]);
    setDirty(true);
  };

  return (
    <SectionCard
      className="stock-recipe-editor"
      title={
        <span className="stock-recipe-title">
          <button type="button" className="btn btn-small stock-back" onClick={onBack} aria-label="К списку позиций">
            <Icon name="back" size={18} />
          </button>
          {product.name}
        </span>
      }
    >
      <div className="stock-cost">
        <div>
          <span className="muted">Себестоимость порции</span>
          <strong className="money">{formatMoney(base.cost, currency)}</strong>
        </div>
        <div>
          <span className="muted">Цена в меню</span>
          <strong className="money">{formatMoney(product.price, currency)}</strong>
        </div>
        <div>
          <span className="muted">Наценка</span>
          <strong data-tone={margin !== null && margin < 50 ? 'warn' : undefined}>
            {margin === null ? '—' : `${margin}%`} · {formatMoney(product.price - base.cost, currency)}
          </strong>
        </div>
      </div>
      {!base.complete && <p className="warn-note">У части сырья нет цены — себестоимость станет точной после первой поставки.</p>}

      <h3 className="stock-h3">Состав одной порции</h3>
      <p className="muted">Сколько сырья уходит на одну {product.name.toLocaleLowerCase('ru')} — каждая продажа спишет это со склада.</p>
      {items.length === 0 && !hadRecipe && <p className="warn-note">Состава нет — продажи «{product.name}» не списывают склад.</p>}
      <ul className="stock-recipe-lines">
        {items.map((i) => {
          const ing = byId.get(i.ingredientId);
          const q = parseQty(i.quantity);
          const cost = ing && q !== null ? recipeCost([{ ingredientId: ing.id, quantity: q }], costs) : null;
          return (
            <li key={i.key} className="stock-recipe-line">
              {ingredientSelect(i.ingredientId, (id) => setItem({ key: i.key, ingredientId: id }), 'Сырьё', archivedIn(i.ingredientId))}
              <label className="stock-qty-input">
                <input
                  inputMode="decimal"
                  value={i.quantity}
                  onChange={(e) => setItem({ key: i.key, quantity: e.target.value })}
                  placeholder="0"
                  aria-label={`Сколько на порцию${ing ? `: ${ing.name}` : ''}`}
                  disabled={!canEdit}
                />
                <span>{ing?.unit ?? ''}</span>
              </label>
              <span className="stock-line-cost money">{cost && cost.complete ? formatMoney(cost.cost, currency) : '—'}</span>
              {canEdit && (
                <button type="button" className="btn btn-small" aria-label="Убрать из состава" onClick={change(() => setItems((l) => l!.filter((x) => x.key !== i.key)))}>
                  <Icon name="trash" size={16} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {canEdit && (
        <button type="button" className="btn" onClick={change(() => setItems((l) => [...l!, { key: nextKey++, ingredientId: '', quantity: '' }]))}>
          <Icon name="plus" size={18} /> Добавить сырьё
        </button>
      )}
      {creatingFor && (
        <NewIngredient busy={busy} onCancel={() => setCreatingFor(null)} onCreate={(name, unit) => void createIngredient(name, unit)} />
      )}

      {product.options.length > 0 && (
        <>
          <h3 className="stock-h3">Что меняют добавки</h3>
          <div className="stock-option-help">
            <span>
              <strong>Добавить сверху</strong> — «L: молоко +100 мл», «Сироп: +20 мл»
            </span>
            <span>
              <strong>Другое количество</strong> — «L: молоко 350 мл вместо 200»
            </span>
            <span>
              <strong>Заменить</strong> — «Овсяное: вместо обычного молока», «L: стакан 0,5 вместо 0,3»
            </span>
          </div>
          {product.options.map((g) => (
            <div key={g.id} className="stock-option-group">
              <h4>{g.name}</h4>
              {g.choices.map((c) => {
                const lines = options.filter((o) => o.choiceId === c.id);
                const said = recipe.options
                  .filter((o) => o.choiceId === c.id)
                  .map((o) => describeOptionLine(o, nameOf, recipe.items));
                return (
                  <ChoiceBlock
                    key={c.id}
                    choice={c}
                    lines={lines}
                    said={said}
                    price={product.price + c.priceDelta}
                    cost={recipeCost(recipeUsage(recipe, [c.id]), costs).cost}
                    currency={currency}
                    canEdit={canEdit}
                    onAdd={(mode) => addOption(c.id, mode)}
                    renderLine={(o) => {
                      const ing = byId.get(o.ingredientId);
                      return (
                        <li key={o.key} className="stock-option-line">
                          <select
                            className="stock-opt-mode"
                            value={o.mode}
                            onChange={(e) => setOption({ key: o.key, mode: e.target.value as RecipeOptionMode })}
                            aria-label="Что делает добавка"
                            disabled={!canEdit}
                          >
                            {RECIPE_OPTION_MODES.map((m) => (
                              <option key={m} value={m}>
                                {RECIPE_OPTION_MODE_LABEL[m]}
                              </option>
                            ))}
                          </select>
                          {o.mode === 'swap' && (
                            <>
                              {ingredientSelect(o.replacesId, (id) => setOption({ key: o.key, replacesId: id }), 'Что заменить', archivedIn(o.replacesId), 'stock-opt-from')}
                              <span className="stock-arrow" aria-hidden="true">
                                →
                              </span>
                            </>
                          )}
                          {ingredientSelect(o.ingredientId, (id) => setOption({ key: o.key, ingredientId: id }), o.mode === 'swap' ? 'На что заменить' : 'Сырьё', archivedIn(o.ingredientId), 'stock-opt-to')}
                          <label className="stock-qty-input stock-opt-qty">
                            <input
                              inputMode="decimal"
                              value={o.quantity}
                              onChange={(e) => setOption({ key: o.key, quantity: e.target.value })}
                              placeholder={o.mode === 'swap' ? 'столько же' : o.mode === 'set' ? '0 = без' : '0'}
                              aria-label="Количество"
                              disabled={!canEdit}
                            />
                            <span>{ing?.unit ?? ''}</span>
                          </label>
                          {canEdit && (
                            <button type="button" className="btn btn-small stock-opt-del" aria-label="Убрать" onClick={change(() => setOptions((l) => l.filter((x) => x.key !== o.key)))}>
                              <Icon name="trash" size={16} />
                            </button>
                          )}
                        </li>
                      );
                    }}
                  />
                );
              })}
            </div>
          ))}
        </>
      )}

      <FormError error={error} />
      {canEdit && (
        <div className="stock-recipe-actions">
          {hadRecipe && (
            <button type="button" className="btn btn-outline-danger" disabled={busy} onClick={() => void clear()}>
              <Icon name="trash" size={16} /> Удалить состав
            </button>
          )}
          <button type="button" className="btn btn-primary btn-large" disabled={busy || !dirty} onClick={() => void submit()}>
            {dirty ? 'Сохранить состав' : 'Сохранено'}
          </button>
        </div>
      )}
    </SectionCard>
  );
}

/** A missing ingredient, created without leaving the recipe: a name and how it is counted. */
function NewIngredient({ busy, onCancel, onCreate }: { busy: boolean; onCancel: () => void; onCreate: (name: string, unit: IngredientUnit) => void }) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<IngredientUnit>('г');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stock-new-ingredient" role="group" aria-label="Новое сырьё">
      <strong>Новое сырьё</strong>
      <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Например, Сливки 33%" aria-label="Название нового сырья" autoFocus />
      <div className="seg-chips" role="group" aria-label="Как считаем">
        {INGREDIENT_UNITS.map((u) => (
          <button key={u} type="button" className="chip" aria-pressed={u === unit} onClick={() => setUnit(u)}>
            {u === 'г' ? 'граммы' : u === 'мл' ? 'миллилитры' : 'штуки'}
          </button>
        ))}
      </div>
      <FormError error={error} />
      <div className="row wrap">
        <button type="button" className="btn" onClick={onCancel}>
          Отмена
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            if (!name.trim()) return setError('Укажите название');
            setError(null);
            onCreate(name.trim(), unit);
          }}
        >
          Добавить и выбрать
        </button>
      </div>
    </div>
  );
}

function ChoiceBlock({
  choice,
  lines,
  said,
  price,
  cost,
  currency,
  canEdit,
  onAdd,
  renderLine,
}: {
  choice: ProductOptionChoice;
  lines: OptionDraft[];
  /** What the lines do, in words («Молоко +100 мл»). */
  said: string[];
  price: Minor;
  cost: Minor;
  currency: string;
  canEdit: boolean;
  onAdd: (mode: RecipeOptionMode) => void;
  renderLine: (o: OptionDraft) => ReactNode;
}) {
  const margin = marginPercent(price, cost);
  return (
    <div className="stock-choice">
      <div className="stock-choice-head">
        <span className="stock-choice-name">{choice.name}</span>
        <span className="muted">
          {said.length ? said.join(' · ') : 'состав как обычно'}
          {lines.length ? ` · себестоимость ${formatMoney(cost, currency)}${margin !== null ? `, наценка ${margin}%` : ''}` : ''}
        </span>
      </div>
      {lines.length > 0 && <ul className="stock-option-lines">{lines.map(renderLine)}</ul>}
      {canEdit && (
        <div className="stock-choice-add" role="group" aria-label={`Что меняет «${choice.name}»`}>
          <button type="button" className="chip" onClick={() => onAdd('add')}>
            <Icon name="plus" size={14} /> сверху
          </button>
          <button type="button" className="chip" onClick={() => onAdd('set')}>
            другое кол-во
          </button>
          <button type="button" className="chip" onClick={() => onAdd('swap')}>
            замена
          </button>
        </div>
      )}
    </div>
  );
}
