import { useEffect, useMemo, useState } from 'react';
import type {
  CreateIngredientRequest,
  IngredientRemovalView,
  IngredientUnit,
  IngredientView,
  RemoveIngredientResponse,
  RemoveSampleResponse,
  StockMovementsView,
  StockSampleView,
  UpdateIngredientRequest,
} from '@bills/domain';
import { bigUnitOf, formatMoney, INGREDIENT_UNITS, STOCK_MOVEMENT_LABEL } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { FormError, Modal } from '../cash/Modal.tsx';
import { EmptyState, StatTile } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { parseMajor, toMajorText } from '../pages/bar/money.tsx';
import { formatDateTime } from '../ui.tsx';
import { useHub, useLive } from '../useHub.tsx';
import type { SupplyDraft } from './BuyList.tsx';
import { BuyListModal } from './BuyList.tsx';
import { QtyInput } from './QtyInput.tsx';
import { SampleStart } from './SampleFill.tsx';
import { byName, daysLabel, matches, packOf, packPrice, plural, qtyInput, qtyLabel, typedQty } from './stock.ts';

type Run = <T>(key: string, path: string, body?: object) => Promise<T | undefined>;

const REASONS = ['Пролили', 'Испортилось', 'Для персонала', 'Проба', 'Брак'];
const ADJUST_REASONS = ['Пересчитали', 'Продажа списала неверно', 'Ошибка при вводе', 'Пример от TS'];

/**
 * «Остатки»: every ingredient with its level and the warning below the minimum; «Списать»,
 * «История», change it (the level too: «Сколько есть на самом деле», an adjustment with a reason),
 * «В архив» / «Вернуть» to hide it for a while, or «Удалить» — active or archived, for good: its
 * history keeps the name, what is left is written off, it leaves recipes when asked. The example
 * TS put in is marked and goes away at once with «Убрать пример».
 */
export function LevelsTab({
  ingredients,
  run,
  busy,
  notify,
  openNew,
  onNewOpened,
  onStartSupply,
}: {
  ingredients: IngredientView[];
  run: Run;
  busy: boolean;
  notify: (m: string) => void;
  /** The checklist asked for «Добавить сырьё». */
  openNew?: boolean;
  onNewOpened?: () => void;
  /** «Создать поставку» from «Докупить на неделю»; absent for someone who does not receive deliveries. */
  onStartSupply?: ((draft: SupplyDraft) => void) | undefined;
}) {
  const { state, canNow } = useHub();
  const currency = state.club.currency;
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<IngredientView | 'new' | null>(null);
  const [writingOff, setWritingOff] = useState<IngredientView | null>(null);
  const [history, setHistory] = useState<IngredientView | null>(null);
  const [removing, setRemoving] = useState<IngredientView | null>(null);
  const [sampleOpen, setSampleOpen] = useState(false);
  const [buying, setBuying] = useState(false);
  const canEdit = canNow('stock.edit');
  const canWriteOff = canNow('stock.writeoff');

  /** «В архив» / «Вернуть из архива»: hidden for a while, nothing is lost. */
  const setArchivedOf = async (i: IngredientView, archive: boolean): Promise<boolean> => {
    const ok = await run(`ingredient:${i.id}`, `/api/stock/ingredients/${i.id}/update`, { isArchived: archive });
    if (ok) notify(archive ? `«${i.name}» убрано в архив — вернуть можно из «Архива»` : `«${i.name}» снова на складе`);
    return ok !== undefined;
  };

  useEffect(() => {
    if (openNew && canEdit) {
      setEditing('new');
      onNewOpened?.();
    }
  }, [openNew, canEdit, onNewOpened]);

  const active = ingredients.filter((i) => !i.isArchived);
  const low = active.filter((i) => i.low);
  const samples = active.filter((i) => i.isSample);
  const value = active.reduce((s, i) => s + (i.value ?? 0), 0);
  const shown = useMemo(
    () =>
      byName(ingredients.filter((i) => i.isArchived === archived && matches(i.name, query))).sort(
        (a, b) => Number(b.low) - Number(a.low),
      ),
    [ingredients, archived, query],
  );

  return (
    <div className="stock-tab">
      <div className="stat-row">
        <StatTile label="Сырья на складе" value={active.length} detail={`${ingredients.length - active.length} в архиве`} />
        <StatTile label="Заканчивается" value={low.length} tone={low.length ? 'warn' : undefined} detail={low.length ? low.slice(0, 3).map((i) => i.name).join(', ') : 'всё в норме'} />
        <StatTile label="На сумму" value={formatMoney(value, currency)} detail="по закупочной цене" />
      </div>

      {samples.length > 0 && (
        <div className="stock-sample-note">
          <Icon name="wand" size={18} />
          <div>
            <strong>Это пример от TS</strong>
            <span>
              {samples.length} {plural(samples.length, 'позиция', 'позиции', 'позиций')} сырья с придуманными остатками и составы напитков. Меняйте их как свои — название,
              остаток, состав — или уберите пример целиком и внесите своё.
            </span>
          </div>
          {canEdit && (
            <button type="button" className="btn" onClick={() => setSampleOpen(true)}>
              Убрать пример
            </button>
          )}
        </div>
      )}

      <div className="stock-toolbar">
        <label className="stock-search">
          <Icon name="search" size={18} />
          <input type="search" placeholder="Найти сырьё" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Найти сырьё" />
        </label>
        <button type="button" className="chip" aria-pressed={archived} onClick={() => setArchived((a) => !a)}>
          Архив
        </button>
        {active.length > 0 && (
          <button type="button" className="btn stock-buy-btn" onClick={() => setBuying(true)}>
            Докупить на неделю
          </button>
        )}
        {canEdit && (
          <button type="button" className="btn btn-primary stock-add" onClick={() => setEditing('new')}>
            <Icon name="plus" size={18} /> Добавить сырьё
          </button>
        )}
      </div>

      {active.length === 0 && !archived && !query && canEdit ? (
        <SampleStart run={run} busy={busy} notify={notify} />
      ) : shown.length === 0 ? (
        <EmptyState icon="orders" title={query ? 'Ничего не нашлось' : archived ? 'Архив пуст' : 'Сырья пока нет'}>
          {!query && !archived && 'Добавьте кофе, молоко, стаканы — всё, из чего готовите.'}
          {!query && archived && 'Сюда попадает сырьё, которое убрали в архив, — его можно вернуть или удалить.'}
        </EmptyState>
      ) : (
        <ul className="stock-list">
          {shown.map((i) => {
            // Below zero the tag says it already («в минусе»).
            const days = i.quantity < 0 ? null : daysLabel(i);
            return (
              <li key={i.id} className="stock-item" data-low={(i.low && !i.isArchived) || undefined}>
                <div className="stock-item-main">
                  <span className="stock-item-name">
                    {i.name}
                    {i.isSample && <span className="tag tag-muted">пример</span>}
                  </span>
                  <span className="stock-item-meta">
                    {packPrice(i.costPerUnit, i.unit, currency)}
                    {i.usedIn > 0 ? ` · в составе ${i.usedIn} ${plural(i.usedIn, 'позиции', 'позиций', 'позиций')}` : ''}
                  </span>
                </div>
                <div className="stock-item-qty">
                  <span className="stock-qty" data-negative={i.quantity < 0 || undefined}>
                    {qtyLabel(i.quantity, i.unit)}
                  </span>
                  <span className="stock-item-tags">
                    {i.low && !i.isArchived && (
                      <span className="tag tag-warn">
                        <Icon name="alert" size={12} />
                        {i.quantity < 0 ? 'в минусе' : `меньше ${qtyLabel(i.minLevel ?? 0, i.unit)}`}
                      </span>
                    )}
                    {days && !i.isArchived && <span className="muted">{days}</span>}
                  </span>
                </div>
                <div className="stock-item-actions">
                  <button type="button" className="btn btn-small" onClick={() => setHistory(i)}>
                    История
                  </button>
                  {i.isArchived ? (
                    canEdit && (
                      <>
                        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void setArchivedOf(i, false)}>
                          Вернуть
                        </button>
                        <button type="button" className="btn btn-small" onClick={() => setEditing(i)} aria-label={`Изменить: ${i.name}`}>
                          <Icon name="edit" size={16} /> <span className="stock-btn-word">Изменить</span>
                        </button>
                        <button type="button" className="btn btn-small btn-outline-danger" onClick={() => setRemoving(i)} aria-label={`Удалить: ${i.name}`}>
                          <Icon name="trash" size={16} /> <span className="stock-btn-word">Удалить</span>
                        </button>
                      </>
                    )
                  ) : (
                    <>
                      {canWriteOff && (
                        <button type="button" className="btn btn-small" onClick={() => setWritingOff(i)}>
                          Списать
                        </button>
                      )}
                      {canEdit && (
                        <button type="button" className="btn btn-small" onClick={() => setEditing(i)} aria-label={`Изменить: ${i.name}`}>
                          <Icon name="edit" size={16} /> <span className="stock-btn-word">Изменить</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <IngredientForm
          ingredient={editing === 'new' ? null : editing}
          currency={currency}
          busy={busy}
          onClose={() => setEditing(null)}
          onRemove={editing !== 'new' ? () => {
            setRemoving(editing);
            setEditing(null);
          } : undefined}
          onArchive={editing !== 'new' ? async () => {
            if (await setArchivedOf(editing, !editing.isArchived)) setEditing(null);
          } : undefined}
          onSave={async (body, adjust, id) => {
            if (!id) {
              const ok = await run('ingredient:new', '/api/stock/ingredients', body);
              if (ok) {
                setEditing(null);
                notify('Сырьё добавлено');
              }
              return;
            }
            if (adjust) {
              const ok = await run(`ingredient:${id}:adjust`, `/api/stock/ingredients/${id}/adjust`, adjust);
              if (!ok) return;
            }
            const ok = await run(`ingredient:${id}`, `/api/stock/ingredients/${id}/update`, body);
            if (ok) {
              setEditing(null);
              notify(adjust ? 'Сохранено, остаток исправлен' : 'Сохранено');
            }
          }}
        />
      )}
      {removing && (
        <RemoveIngredientDialog
          ingredient={removing}
          currency={currency}
          busy={busy}
          onClose={() => setRemoving(null)}
          onConfirm={async (fromRecipes) => {
            const res = await run<RemoveIngredientResponse>(`ingredient:${removing.id}:remove`, `/api/stock/ingredients/${removing.id}/remove`, { fromRecipes });
            if (res) {
              setRemoving(null);
              const parts = [
                res.quantity > 0 ? `списано ${qtyLabel(res.quantity, removing.unit)}` : '',
                res.recipes.length ? `убрано из состава: ${res.recipes.join(', ')}` : '',
              ].filter(Boolean);
              notify(`«${removing.name}» удалено${parts.length ? ` — ${parts.join(', ')}` : ''}`);
            }
          }}
        />
      )}
      {writingOff && (
        <WriteOffForm
          ingredient={writingOff}
          busy={busy}
          onClose={() => setWritingOff(null)}
          onSave={async (quantity, reason) => {
            const ok = await run('writeoff', '/api/stock/writeoffs', { ingredientId: writingOff.id, quantity, reason });
            if (ok) {
              setWritingOff(null);
              notify(`Списано: ${writingOff.name}, ${qtyLabel(quantity, writingOff.unit)}`);
            }
          }}
        />
      )}
      {history && <HistoryModal ingredient={history} onClose={() => setHistory(null)} />}
      {buying && (
        <BuyListModal
          onClose={() => setBuying(false)}
          onStartSupply={
            onStartSupply &&
            ((draft) => {
              setBuying(false);
              onStartSupply(draft);
              notify('Список перенесён в поставку: укажите поставщика и суммы по накладной');
            })
          }
        />
      )}
      {sampleOpen && (
        <RemoveSampleDialog
          busy={busy}
          onClose={() => setSampleOpen(false)}
          onConfirm={async () => {
            const res = await run<RemoveSampleResponse>('sample:remove', '/api/stock/sample/remove', {});
            if (res) {
              setSampleOpen(false);
              const parts = [
                res.deleted.length ? `удалено ${res.deleted.length}` : '',
                res.archived.length ? `в архив ${res.archived.length}` : '',
                res.kept.length ? `оставлено ${res.kept.length}` : '',
                res.recipes.length ? `составов убрано ${res.recipes.length}` : '',
              ].filter(Boolean);
              notify(`Пример убран: ${parts.join(', ') || 'ничего не осталось'}`);
            }
          }}
        />
      )}
    </div>
  );
}

function IngredientForm({
  ingredient,
  currency,
  busy,
  onClose,
  onSave,
  onRemove,
  onArchive,
}: {
  ingredient: IngredientView | null;
  currency: string;
  busy: boolean;
  onClose: () => void;
  onSave: (body: CreateIngredientRequest | UpdateIngredientRequest, adjust: { quantity: number; reason: string } | null, id: string | null) => void;
  /** «Удалить» — always offered for an existing one, archived too. */
  onRemove?: (() => void) | undefined;
  /** «В архив» / «Вернуть из архива». */
  onArchive?: (() => void) | undefined;
}) {
  const [name, setName] = useState(ingredient?.name ?? '');
  const [unit, setUnit] = useState<IngredientUnit>(ingredient?.unit ?? 'г');
  // A level below zero is not typed back in: the field starts empty («как по учёту»).
  // The unit follows the level: 1,5 кг of beans, 40 г of cinnamon; a new one starts in кг / л.
  const startQty = !ingredient
    ? { text: '', factor: 1000 }
    : ingredient.quantity > 0
      ? qtyInput(ingredient.quantity, ingredient.unit)
      : { text: '', factor: 1 };
  const [quantity, setQuantity] = useState(startQty.text);
  const [qtyFactor, setQtyFactor] = useState(startQty.factor);
  const [adjustReason, setAdjustReason] = useState('');
  const startMin = ingredient?.minLevel != null ? qtyInput(ingredient.minLevel, ingredient.unit) : { text: '', factor: 1000 };
  const [minLevel, setMinLevel] = useState(startMin.text);
  const [minFactor, setMinFactor] = useState(startMin.factor);
  const pack = packOf(unit);
  const [price, setPrice] = useState(
    ingredient?.costPerUnit != null ? toMajorText(ingredient.costPerUnit * packOf(ingredient.unit).size, currency) : '',
  );
  const [error, setError] = useState<string | null>(null);
  // The HUB keeps the unit once anything happened to the ingredient (the history is in it).
  const unitLocked = ingredient !== null && ingredient.hasHistory;
  // An archived one keeps its level as it was: it comes back first, then the level can change.
  const archived = ingredient?.isArchived === true;
  // Empty: a new ingredient starts at 0, an existing one keeps its level.
  const typed = quantity.trim() ? typedQty(quantity, qtyFactor) : (ingredient?.quantity ?? 0);
  const changesLevel =
    ingredient !== null &&
    !archived &&
    quantity.trim() !== '' &&
    typed !== null &&
    Math.round(typed * 1000) !== Math.round(ingredient.quantity * 1000);

  const pickUnit = (u: IngredientUnit) => {
    setUnit(u);
    setQtyFactor(bigUnitOf(u).factor);
    setMinFactor(bigUnitOf(u).factor);
  };

  const submit = () => {
    if (!name.trim()) return setError('Укажите название');
    if (typed === null) return setError('Остаток — число, например 2 или 1,5');
    const min = minLevel.trim() ? typedQty(minLevel, minFactor) : null;
    if (minLevel.trim() && min === null) return setError('Минимум — число');
    const packCost = price.trim() ? parseMajor(price, currency) : null;
    if (price.trim() && packCost === null) return setError('Цена — число');
    const costPerUnit = packCost === null ? null : Math.round(packCost / pack.size);
    if (changesLevel && adjustReason.trim().length < 3) return setError('Остаток меняется — укажите почему (например, «Пересчитали»)');
    setError(null);
    if (ingredient) {
      onSave({ name, unit, minLevel: min, costPerUnit }, changesLevel ? { quantity: typed, reason: adjustReason.trim() } : null, ingredient.id);
    } else {
      onSave({ name, unit, quantity: typed, minLevel: min, costPerUnit }, null, null);
    }
  };

  return (
    <Modal
      title={ingredient ? `Сырьё: ${ingredient.name}` : 'Новое сырьё'}
      onClose={onClose}
      className="stock-modal"
      footer={
        <div className="stock-modal-foot">
          <FormError error={error} />
          <div className="row wrap">
            {onRemove && (
              <button type="button" className="btn btn-outline-danger" disabled={busy} onClick={onRemove}>
                <Icon name="trash" size={16} /> Удалить
              </button>
            )}
            {onArchive && ingredient && (
              <button type="button" className="btn" disabled={busy} onClick={onArchive}>
                {ingredient.isArchived ? 'Вернуть из архива' : 'В архив'}
              </button>
            )}
            <button type="button" className="btn btn-primary btn-large" disabled={busy} onClick={submit}>
              Сохранить
            </button>
          </div>
        </div>
      }
    >
      <div className="stock-form">
        <label className="field">
          <span>Название</span>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Молоко 3,2%" data-autofocus="" />
        </label>
        <div className="field">
          <span>Как считаем</span>
          <div className="seg-chips" role="group" aria-label="Единица">
            {INGREDIENT_UNITS.map((u) => (
              <button key={u} type="button" className="chip" aria-pressed={u === unit} disabled={unitLocked} onClick={() => pickUnit(u)}>
                {u === 'г' ? 'вес: кг, г' : u === 'мл' ? 'объём: л, мл' : 'штуки'}
              </button>
            ))}
          </div>
          {unitLocked && <span className="hint">Единицу не меняем: по этому сырью уже есть история. Нужна другая — заведите новое сырьё.</span>}
        </div>
        {archived && ingredient ? (
          <div className="field">
            <span>В архиве</span>
            <span className="hint">
              Не видно в поставках, составах и инвентаризации, по учёту {qtyLabel(ingredient.quantity, ingredient.unit)}. «Вернуть из архива» — снова на
              складе, «Удалить» — убрать совсем.
            </span>
          </div>
        ) : (
          <div className="field">
            <span>{ingredient ? 'Сколько есть на самом деле' : 'Сейчас на складе'}</span>
            <QtyInput value={quantity} factor={qtyFactor} unit={unit} label="Остаток" placeholder={ingredient ? 'как по учёту' : '0'} onChange={(t, f) => {
              setQuantity(t);
              setQtyFactor(f);
            }} />
            {ingredient && !changesLevel && <span className="hint">Сейчас по учёту {qtyLabel(ingredient.quantity, ingredient.unit)}. Поменяйте, если на полке другое.</span>}
          </div>
        )}
        {changesLevel && ingredient && typed !== null && (
          <div className="field stock-adjust">
            <span>
              Остаток станет {qtyLabel(typed, unit)} (было {qtyLabel(ingredient.quantity, ingredient.unit)}). Почему?
            </span>
            <div className="seg-chips" role="group" aria-label="Почему меняется остаток">
              {ADJUST_REASONS.map((r) => (
                <button key={r} type="button" className="chip" aria-pressed={adjustReason === r} onClick={() => setAdjustReason(r)}>
                  {r}
                </button>
              ))}
            </div>
            <input value={adjustReason} maxLength={300} onChange={(e) => setAdjustReason(e.target.value)} placeholder="или своими словами" />
            <span className="hint">В истории появится «Остаток исправлен» с причиной — прошлые записи не меняются.</span>
          </div>
        )}
        <div className="field">
          <span>Предупредить, когда меньше</span>
          <QtyInput value={minLevel} factor={minFactor} unit={unit} label="Минимум" placeholder="не предупреждать" onChange={(t, f) => {
            setMinLevel(t);
            setMinFactor(f);
          }} />
        </div>
        <label className="field">
          <span>Закупочная цена за 1 {pack.label}, {currency}</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="узнаем из поставки" />
          <span className="hint">Пересчитывается сама с каждой поставкой</span>
        </label>
      </div>
    </Modal>
  );
}

/**
 * «Удалить сырьё?» — active or archived: what will happen, said before it happens. Never used —
 * it goes completely; with history — for good («навсегда»), the history keeps its name, what is
 * left on hand is written off as «удалено». The recipes that use it are named and it leaves them
 * on the same click. Hiding it for a while is «В архив».
 */
function RemoveIngredientDialog({
  ingredient,
  currency,
  busy,
  onClose,
  onConfirm,
}: {
  ingredient: IngredientView;
  currency: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (fromRecipes: boolean) => void;
}) {
  const { data, error } = useLive(() => fetchJson<IngredientRemovalView>(`/api/stock/ingredients/${ingredient.id}/removal`), [ingredient.id], 0);
  const recipes = data?.recipes ?? [];
  const forGood = data?.outcome === 'history';
  const h = data?.history;
  const history = h
    ? [
        h.movements ? `${h.movements} ${plural(h.movements, 'движение', 'движения', 'движений')}` : '',
        h.supplies ? `${h.supplies} ${plural(h.supplies, 'поставка', 'поставки', 'поставок')}` : '',
        h.counts ? `${h.counts} ${plural(h.counts, 'инвентаризация', 'инвентаризации', 'инвентаризаций')}` : '',
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  const worth = data && data.quantity > 0 && ingredient.costPerUnit !== null ? Math.round(data.quantity * ingredient.costPerUnit) : null;
  return (
    <Modal
      title={forGood ? `Удалить «${ingredient.name}» навсегда?` : `Удалить «${ingredient.name}»?`}
      onClose={onClose}
      className="stock-modal"
      footer={
        <div className="stock-modal-foot">
          <div className="row wrap">
            <button type="button" className="btn" onClick={onClose}>
              Не удалять
            </button>
            <button type="button" className="btn btn-danger btn-large" disabled={busy || !data} onClick={() => onConfirm(recipes.length > 0)}>
              {recipes.length > 0 ? 'Убрать из составов и удалить' : forGood ? 'Удалить навсегда' : 'Удалить'}
            </button>
          </div>
        </div>
      }
    >
      <div className="stock-form">
        {error && <p className="form-error">{error}</p>}
        {!data ? (
          <p className="muted">Проверяем, где используется…</p>
        ) : (
          <>
            {recipes.length > 0 && (
              <div className="warn-note">
                Используется в составе: <strong>{recipes.map((r) => r.name).join(', ')}</strong>. Оно уйдёт из этих составов — их продажи перестанут
                списывать «{ingredient.name}». Остальное в составах останется.
              </div>
            )}
            {forGood ? (
              <>
                <p>
                  <strong>История движений сохранится</strong>
                  {history ? ` (${history})` : ''}: в поставках, инвентаризациях и журнале название останется. Из остатков, архива и списков выбора
                  сырьё пропадёт, вернуть его будет нельзя. Новое сырьё с таким же названием можно завести потом.
                </p>
                {data.quantity > 0 && (
                  <div className="warn-note">
                    На складе ещё <strong>{qtyLabel(data.quantity, data.unit)}</strong>
                    {worth !== null ? ` на ${formatMoney(worth, currency)}` : ''} — спишется с пометкой «удалено».
                  </div>
                )}
                {data.quantity < 0 && <p>Остаток в минусе ({qtyLabel(data.quantity, data.unit)}) — обнулится с пометкой «удалено».</p>}
                {!ingredient.isArchived && <p className="hint">Нужно только спрятать на время — нажмите «В архив» в карточке сырья.</p>}
              </>
            ) : (
              <p>По нему ещё ничего не было — оно удалится полностью.</p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** «Убрать пример со склада»: what goes, what goes to the archive and what stays — and why. */
function RemoveSampleDialog({ busy, onClose, onConfirm }: { busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const { data, error } = useLive(() => fetchJson<StockSampleView>('/api/stock/sample'), [], 0);
  const del = data?.ingredients.filter((i) => i.outcome === 'delete') ?? [];
  const arch = data?.ingredients.filter((i) => i.outcome === 'archive') ?? [];
  const keep = data?.ingredients.filter((i) => i.outcome === 'keep') ?? [];
  return (
    <Modal
      title="Убрать пример со склада?"
      onClose={onClose}
      className="stock-modal"
      footer={
        <div className="stock-modal-foot">
          <div className="row wrap">
            <button type="button" className="btn" onClick={onClose}>
              Оставить
            </button>
            <button type="button" className="btn btn-danger btn-large" disabled={busy || !data} onClick={onConfirm}>
              Убрать пример
            </button>
          </div>
        </div>
      }
    >
      <div className="stock-form">
        {error && <p className="form-error">{error}</p>}
        {!data ? (
          <p className="muted">Загрузка…</p>
        ) : (
          <>
            <p>TS добавил пример, чтобы склад заработал сразу. Своё — поставки, продажи, ваши составы — не пропадёт.</p>
            {del.length > 0 && (
              <p>
                <strong>Удалим:</strong> {del.map((i) => i.name).join(', ')}.
              </p>
            )}
            {arch.length > 0 && (
              <p>
                <strong>Уберём в архив</strong> (история останется): {arch.map((i) => `${i.name} — ${i.why}`).join('; ')}.
              </p>
            )}
            {keep.length > 0 && (
              <p>
                <strong>Оставим как ваше:</strong> {keep.map((i) => `${i.name} — ${i.why}`).join('; ')}.
              </p>
            )}
            {data.recipes.length > 0 && (
              <p>
                <strong>Составы-примеры:</strong> {data.recipes.map((r) => r.name).join(', ')} — уберём, позиции меню останутся.
              </p>
            )}
            {del.length + arch.length + keep.length + data.recipes.length === 0 && <p className="muted">Примера на складе уже нет.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

function WriteOffForm({
  ingredient,
  busy,
  onClose,
  onSave,
}: {
  ingredient: IngredientView;
  busy: boolean;
  onClose: () => void;
  onSave: (quantity: number, reason: string) => void;
}) {
  const [quantity, setQuantity] = useState('');
  const [factor, setFactor] = useState(1);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const q = typedQty(quantity, factor);
    if (q === null || q <= 0) return setError('Сколько списать — число больше нуля');
    if (reason.trim().length < 3) return setError('Укажите причину');
    setError(null);
    onSave(q, reason.trim());
  };
  return (
    <Modal
      title={`Списать: ${ingredient.name}`}
      onClose={onClose}
      className="stock-modal"
      footer={
        <div className="stock-modal-foot">
          <FormError error={error} />
          <button type="button" className="btn btn-danger btn-large" disabled={busy} onClick={submit}>
            Списать
          </button>
        </div>
      }
    >
      <div className="stock-form">
        <p className="muted">На складе сейчас {qtyLabel(ingredient.quantity, ingredient.unit)}</p>
        <div className="field">
          <span>Сколько</span>
          <QtyInput value={quantity} factor={factor} unit={ingredient.unit} label="Сколько списать" autoFocus onChange={(t, f) => {
            setQuantity(t);
            setFactor(f);
          }} />
        </div>
        <div className="field">
          <span>Причина</span>
          <div className="seg-chips" role="group" aria-label="Причина">
            {REASONS.map((r) => (
              <button key={r} type="button" className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>
                {r}
              </button>
            ))}
          </div>
          <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="или напишите своими словами" />
        </div>
      </div>
    </Modal>
  );
}

function HistoryModal({ ingredient, onClose }: { ingredient: IngredientView; onClose: () => void }) {
  const { state, version } = useHub();
  const { data, error } = useLive(
    () => fetchJson<StockMovementsView>(`/api/stock/movements?ingredientId=${encodeURIComponent(ingredient.id)}`),
    [ingredient.id],
    version,
  );
  const tz = state.club.timezone;
  return (
    <Modal title={`История: ${ingredient.name}`} onClose={onClose} className="stock-modal">
      {error && <p className="form-error">{error}</p>}
      {!data ? (
        <p className="muted">Загрузка…</p>
      ) : data.movements.length === 0 ? (
        <p className="muted">Движений ещё не было.</p>
      ) : (
        <ul className="stock-history">
          {data.movements.slice(0, 100).map((m) => (
            <li key={m.id}>
              <div>
                <span className="stock-history-kind">{STOCK_MOVEMENT_LABEL[m.kind]}</span>
                <span className="muted">
                  {formatDateTime(m.at, tz)} · {m.actor}
                  {m.reason ? ` · ${m.reason}` : ''}
                </span>
              </div>
              <div className="stock-history-qty">
                <span data-sign={m.quantity < 0 ? 'minus' : 'plus'}>
                  {m.quantity === 0 ? 'сумма' : `${m.quantity > 0 ? '+' : ''}${qtyLabel(m.quantity, m.unit)}`}
                </span>
                <span className="muted">остаток {qtyLabel(m.balance, m.unit)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
