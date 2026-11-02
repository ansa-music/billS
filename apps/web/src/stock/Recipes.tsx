import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
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
import { formatMoney, marginPercent, RECIPE_OPTION_MODE_LABEL, RECIPE_OPTION_MODES, recipeCost, recipeUsage } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { FormError } from '../cash/Modal.tsx';
import { EmptyState, SectionCard } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { sortCatalog, useCatalog } from '../pages/bar/useCatalog.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { sampleMessage, useSamplePreview } from './SampleFill.tsx';
import { byName, matches, parseQty, qtyText } from './stock.ts';

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

/** «Тех. карты»: pick a product, edit its граммовка and what each option changes; cost and margin live. */
export function RecipesTab({ ingredients, run, busy, notify }: { ingredients: IngredientView[]; run: Run; busy: boolean; notify: (m: string) => void }) {
  const { state, version, canNow } = useHub();
  const currency = state.club.currency;
  const { catalog } = useCatalog();
  const summaries = useLive(() => fetchJson<RecipesView>('/api/stock/recipes'), [], version);
  const [query, setQuery] = useState('');
  const [productId, setProductId] = useState<string | null>(null);

  const sorted = useMemo(() => (catalog ? sortCatalog(catalog) : null), [catalog]);
  const summary = useMemo(() => new Map((summaries.data?.recipes ?? []).map((r) => [r.productId, r])), [summaries.data]);
  const products = (sorted?.products ?? []).filter((p) => p.isActive && matches(p.name, query));
  const categories = (sorted?.categories ?? []).filter((c) => c.isActive);
  const product = sorted?.products.find((p) => p.id === productId) ?? null;
  // «Заполнить примером»: drinks without a card the sample recognises by name.
  const preview = useSamplePreview();
  const samples = useMemo(() => new Map((preview?.products ?? []).map((p) => [p.productId, p])), [preview]);
  const [reload, setReload] = useState(0);
  const fillSample = async (productIds: string[]) => {
    const r = await run<{ ingredients: number; recipes: number }>('stock:sample', '/api/stock/sample', { productIds });
    if (r) {
      notify(sampleMessage(r));
      setReload((n) => n + 1);
    }
  };

  return (
    <div className="stock-tab stock-recipes" data-open={product ? '' : undefined}>
      <SectionCard title="Меню" className="stock-recipe-list">
        <label className="stock-search">
          <Icon name="search" size={18} />
          <input type="search" placeholder="Найти товар" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Найти товар" />
        </label>
        {canNow('stock.edit') && samples.size > 0 && (
          <div className="stock-sample-banner">
            <span>
              Есть пример тех. карт для: <strong>{[...samples.values()].map((p) => p.name).join(', ')}</strong>
            </span>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void fillSample([...samples.keys()])}>
              Заполнить примером
            </button>
          </div>
        )}
        {!sorted ? (
          <p className="muted">Загрузка…</p>
        ) : products.length === 0 ? (
          <EmptyState icon="bar" title="Товаров не нашлось" />
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
                        <span className="tag tag-muted">нет карты</span>
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
          key={`${product.id}:${reload}`}
          product={product}
          sample={canNow('stock.edit') ? (samples.get(product.id)?.sample ?? null) : null}
          onFillSample={() => void fillSample([product.id])}
          ingredients={ingredients}
          canEdit={canNow('stock.edit')}
          busy={busy}
          onBack={() => setProductId(null)}
          onSave={async (recipe) => {
            const saved = await run<RecipeView>(`recipe:${product.id}`, `/api/stock/recipes/${product.id}`, recipe);
            if (saved) notify(`Тех. карта «${product.name}» сохранена`);
            return saved;
          }}
        />
      ) : (
        <SectionCard className="stock-recipe-empty">
          <EmptyState icon="cup" title="Выберите товар из меню">
            Укажите, сколько сырья уходит на одну порцию — склад будет списывать его с каждой продажей.
          </EmptyState>
        </SectionCard>
      )}
    </div>
  );
}

function RecipeEditor({
  product,
  sample,
  onFillSample,
  ingredients,
  canEdit,
  busy,
  onBack,
  onSave,
}: {
  product: ProductView;
  /** The sample drink that fits this product when it has no card yet («Латте»). */
  sample: string | null;
  onFillSample: () => void;
  ingredients: IngredientView[];
  canEdit: boolean;
  busy: boolean;
  onBack: () => void;
  onSave: (recipe: Recipe) => Promise<RecipeView | undefined>;
}) {
  const { state } = useHub();
  const currency = state.club.currency;
  const [items, setItems] = useState<ItemDraft[] | null>(null);
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

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

  const active = useMemo(() => byName(ingredients.filter((i) => !i.isArchived)), [ingredients]);
  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const costs = useMemo(() => new Map(ingredients.map((i) => [i.id, i.costPerUnit])), [ingredients]);

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

  const submit = async () => {
    const badItem = items.findIndex((i) => !i.ingredientId || !parseQty(i.quantity));
    if (badItem >= 0) return setError(`Состав, строка ${badItem + 1}: выберите сырьё и количество больше нуля`);
    const badOption = options.findIndex((o) => !o.ingredientId || (o.mode === 'swap' && !o.replacesId) || (o.mode === 'add' && !parseQty(o.quantity)));
    if (badOption >= 0) return setError('Добавки: в каждой строке выберите сырьё, количество и что заменить');
    setError(null);
    const saved = await onSave(recipe);
    if (saved) load(saved);
  };

  const ingredientSelect = (value: string, onChange: (id: string) => void, label: string, extra?: IngredientView[]) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} disabled={!canEdit}>
      <option value="">— сырьё —</option>
      {[...active, ...(extra ?? [])].map((i) => (
        <option key={i.id} value={i.id}>
          {i.name}, {i.unit}
        </option>
      ))}
    </select>
  );
  // Archived ingredients still in the recipe stay selectable so the line does not go blank.
  const archivedIn = (id: string) => (byId.get(id)?.isArchived ? [byId.get(id)!] : []);

  return (
    <SectionCard
      className="stock-recipe-editor"
      title={
        <span className="stock-recipe-title">
          <button type="button" className="btn btn-small stock-back" onClick={onBack} aria-label="К списку товаров">
            <Icon name="back" size={18} />
          </button>
          {product.name}
        </span>
      }
    >
      {sample && items.length === 0 && options.length === 0 && (
        <div className="stock-sample-banner">
          <span>
            Тех. карты нет. Можно взять пример «{sample}» — граммовка под размеры и добавки этого товара.
          </span>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={onFillSample}>
            Заполнить примером
          </button>
        </div>
      )}
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
      {!base.complete && <p className="warn-note">У части сырья нет цены — себестоимость будет точной после первой поставки.</p>}

      <h3 className="stock-h3">Состав одной порции</h3>
      {items.length === 0 && <p className="muted">Пока пусто: добавьте сырьё, из которого готовится {product.name.toLocaleLowerCase('ru')}.</p>}
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
                  aria-label="Количество на порцию"
                  disabled={!canEdit}
                />
                <span>{ing?.unit ?? ''}</span>
              </label>
              <span className="stock-line-cost money">{cost && cost.complete ? formatMoney(cost.cost, currency) : '—'}</span>
              {canEdit && (
                <button type="button" className="btn btn-small" aria-label="Убрать" onClick={change(() => setItems((l) => l!.filter((x) => x.key !== i.key)))}>
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

      {product.options.length > 0 && (
        <>
          <h3 className="stock-h3">Что меняют добавки</h3>
          <p className="muted">
            «Добавить» — сверх состава (сироп +20 мл). «Вместо базы» — другое количество (размер L: молоко 350 мл). «Заменить» — одно сырьё на другое (овсяное вместо обычного).
          </p>
          {product.options.map((g) => (
            <div key={g.id} className="stock-option-group">
              <h4>{g.name}</h4>
              {g.choices.map((c) => (
                <ChoiceBlock
                  key={c.id}
                  choice={c}
                  lines={options.filter((o) => o.choiceId === c.id)}
                  price={product.price + c.priceDelta}
                  cost={recipeCost(recipeUsage(recipe, [c.id]), costs).cost}
                  currency={currency}
                  canEdit={canEdit}
                  onAdd={() => {
                    setOptions((l) => [...l, { key: nextKey++, choiceId: c.id, mode: 'add', ingredientId: '', replacesId: '', quantity: '' }]);
                    setDirty(true);
                  }}
                  renderLine={(o) => {
                    const ing = byId.get(o.ingredientId);
                    return (
                      <li key={o.key} className="stock-option-line">
                        <select
                          value={o.mode}
                          onChange={(e) => setOption({ key: o.key, mode: e.target.value as RecipeOptionMode })}
                          aria-label="Что сделать"
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
                            {ingredientSelect(o.replacesId, (id) => setOption({ key: o.key, replacesId: id }), 'Что заменить', archivedIn(o.replacesId))}
                            <span className="stock-arrow" aria-hidden="true">→</span>
                          </>
                        )}
                        {ingredientSelect(o.ingredientId, (id) => setOption({ key: o.key, ingredientId: id }), 'Сырьё', archivedIn(o.ingredientId))}
                        <label className="stock-qty-input">
                          <input
                            inputMode="decimal"
                            value={o.quantity}
                            onChange={(e) => setOption({ key: o.key, quantity: e.target.value })}
                            placeholder={o.mode === 'swap' ? 'то же' : '0'}
                            aria-label="Количество"
                            disabled={!canEdit}
                          />
                          <span>{ing?.unit ?? ''}</span>
                        </label>
                        {canEdit && (
                          <button type="button" className="btn btn-small" aria-label="Убрать" onClick={change(() => setOptions((l) => l.filter((x) => x.key !== o.key)))}>
                            <Icon name="trash" size={16} />
                          </button>
                        )}
                      </li>
                    );
                  }}
                />
              ))}
            </div>
          ))}
        </>
      )}

      <FormError error={error} />
      {canEdit && (
        <button type="button" className="btn btn-primary btn-large" disabled={busy || !dirty} onClick={() => void submit()}>
          {dirty ? 'Сохранить тех. карту' : 'Сохранено'}
        </button>
      )}
    </SectionCard>
  );
}

function ChoiceBlock({
  choice,
  lines,
  price,
  cost,
  currency,
  canEdit,
  onAdd,
  renderLine,
}: {
  choice: ProductOptionChoice;
  lines: OptionDraft[];
  price: Minor;
  cost: Minor;
  currency: string;
  canEdit: boolean;
  onAdd: () => void;
  renderLine: (o: OptionDraft) => ReactNode;
}) {
  const margin = marginPercent(price, cost);
  return (
    <div className="stock-choice">
      <div className="stock-choice-head">
        <span className="stock-choice-name">{choice.name}</span>
        <span className="muted">
          {lines.length ? `себестоимость ${formatMoney(cost, currency)}${margin !== null ? ` · наценка ${margin}%` : ''}` : 'как в составе'}
        </span>
        {canEdit && (
          <button type="button" className="btn btn-small" onClick={onAdd} aria-label={`Изменение для «${choice.name}»`}>
            <Icon name="plus" size={16} />
          </button>
        )}
      </div>
      {lines.length > 0 && <ul className="stock-option-lines">{lines.map(renderLine)}</ul>}
    </div>
  );
}
