import { useMemo, useState } from 'react';
import type {
  CreateIngredientRequest,
  IngredientUnit,
  IngredientView,
  StockMovementsView,
  UpdateIngredientRequest,
} from '@bills/domain';
import { formatMoney, INGREDIENT_UNITS, STOCK_MOVEMENT_LABEL } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { FormError, Modal } from '../cash/Modal.tsx';
import { EmptyState, StatTile } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { parseMajor, toMajorText } from '../pages/bar/money.tsx';
import { formatDateTime } from '../ui.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { BuyListModal } from './BuyList.tsx';
import { SampleStart } from './SampleFill.tsx';
import type { SupplyDraft } from './stock.ts';
import { byName, daysLabel, matches, packOf, packPrice, parseQty, qtyLabel, qtyText } from './stock.ts';

type Run = <T>(key: string, path: string, body?: object) => Promise<T | undefined>;

const REASONS = ['Пролили', 'Испортилось', 'Для персонала', 'Проба', 'Брак'];

/** «Остатки»: every ingredient with its level, the warning below the minimum, «Списать». */
export function LevelsTab({
  ingredients,
  run,
  busy,
  notify,
  onStartSupply,
}: {
  ingredients: IngredientView[];
  run: Run;
  busy: boolean;
  notify: (m: string) => void;
  /** «Создать поставку из списка»; absent for someone who does not receive deliveries. */
  onStartSupply?: ((draft: SupplyDraft) => void) | undefined;
}) {
  const { state, canNow } = useHub();
  const currency = state.club.currency;
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<IngredientView | 'new' | null>(null);
  const [writingOff, setWritingOff] = useState<IngredientView | null>(null);
  const [history, setHistory] = useState<IngredientView | null>(null);
  const [buying, setBuying] = useState(false);
  const canEdit = canNow('stock.edit');
  const canWriteOff = canNow('stock.writeoff');

  const active = ingredients.filter((i) => !i.isArchived);
  const low = active.filter((i) => i.low);
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
        </EmptyState>
      ) : (
        <ul className="stock-list">
          {shown.map((i) => {
            const days = daysLabel(i);
            return (
              <li key={i.id} className="stock-item" data-low={i.low || undefined}>
                <div className="stock-item-main">
                  <span className="stock-item-name">{i.name}</span>
                  <span className="stock-item-meta">
                    {packPrice(i.costPerUnit, i.unit, currency)}
                    {i.usedIn > 0 ? ` · в ${i.usedIn} тех. картах` : ''}
                  </span>
                </div>
                <div className="stock-item-qty">
                  <span className="stock-qty" data-negative={i.quantity < 0 || undefined}>
                    {qtyLabel(i.quantity, i.unit)}
                  </span>
                  <span className="stock-item-tags">
                    {i.low && (
                      <span className="tag tag-warn">
                        <Icon name="alert" size={12} />
                        {i.quantity < 0 ? 'в минусе' : `меньше ${qtyLabel(i.minLevel ?? 0, i.unit)}`}
                      </span>
                    )}
                    {days && <span className="muted">{days}</span>}
                  </span>
                </div>
                <div className="stock-item-actions">
                  <button type="button" className="btn btn-small" onClick={() => setHistory(i)}>
                    История
                  </button>
                  {canWriteOff && !i.isArchived && (
                    <button type="button" className="btn btn-small" onClick={() => setWritingOff(i)}>
                      Списать
                    </button>
                  )}
                  {canEdit && (
                    <button type="button" className="btn btn-small" onClick={() => setEditing(i)} aria-label={`Изменить: ${i.name}`}>
                      <Icon name="edit" size={16} />
                    </button>
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
          onSave={async (body, id) => {
            const ok = id
              ? await run(`ingredient:${id}`, `/api/stock/ingredients/${id}/update`, body)
              : await run('ingredient:new', '/api/stock/ingredients', body);
            if (ok) {
              setEditing(null);
              notify(id ? 'Сохранено' : 'Сырьё добавлено');
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
    </div>
  );
}

function IngredientForm({
  ingredient,
  currency,
  busy,
  onClose,
  onSave,
}: {
  ingredient: IngredientView | null;
  currency: string;
  busy: boolean;
  onClose: () => void;
  onSave: (body: CreateIngredientRequest | UpdateIngredientRequest, id: string | null) => void;
}) {
  const [name, setName] = useState(ingredient?.name ?? '');
  const [unit, setUnit] = useState<IngredientUnit>(ingredient?.unit ?? 'г');
  const [quantity, setQuantity] = useState('');
  const [minLevel, setMinLevel] = useState(ingredient?.minLevel != null ? qtyText(ingredient.minLevel) : '');
  const pack = packOf(unit);
  const [price, setPrice] = useState(
    ingredient?.costPerUnit != null ? toMajorText(ingredient.costPerUnit * packOf(ingredient.unit).size, currency) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const unitLocked = ingredient !== null && ingredient.quantity !== 0;

  const submit = () => {
    if (!name.trim()) return setError('Укажите название');
    const qty = quantity.trim() ? parseQty(quantity) : 0;
    if (qty === null) return setError('Остаток — число, например 1500 или 2,5');
    const min = minLevel.trim() ? parseQty(minLevel) : null;
    if (minLevel.trim() && min === null) return setError('Минимум — число');
    const packCost = price.trim() ? parseMajor(price, currency) : null;
    if (price.trim() && packCost === null) return setError('Цена — число');
    const costPerUnit = packCost === null ? null : Math.round(packCost / pack.size);
    setError(null);
    if (ingredient) onSave({ name, unit, minLevel: min, costPerUnit }, ingredient.id);
    else onSave({ name, unit, quantity: qty, minLevel: min, costPerUnit }, null);
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
            {ingredient && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => onSave({ isArchived: !ingredient.isArchived }, ingredient.id)}
              >
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
          <span>Единица</span>
          <div className="seg-chips" role="group" aria-label="Единица">
            {INGREDIENT_UNITS.map((u) => (
              <button key={u} type="button" className="chip" aria-pressed={u === unit} disabled={unitLocked} onClick={() => setUnit(u)}>
                {u === 'г' ? 'граммы' : u === 'мл' ? 'миллилитры' : 'штуки'}
              </button>
            ))}
          </div>
          {unitLocked && <span className="hint">Единицу нельзя менять, пока сырьё есть на складе</span>}
        </div>
        {!ingredient && (
          <label className="field">
            <span>Сейчас на складе, {unit}</span>
            <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
          </label>
        )}
        <label className="field">
          <span>Предупредить, когда меньше, {unit}</span>
          <input inputMode="decimal" value={minLevel} onChange={(e) => setMinLevel(e.target.value)} placeholder="не предупреждать" />
        </label>
        <label className="field">
          <span>Закупочная цена за 1 {pack.label}</span>
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="узнаем из поставки" />
          <span className="hint">Пересчитывается сама с каждой поставкой</span>
        </label>
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
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const q = parseQty(quantity);
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
        <label className="field">
          <span>Сколько, {ingredient.unit}</span>
          <input inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} data-autofocus="" placeholder="0" />
        </label>
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
                  {m.quantity > 0 ? '+' : ''}
                  {qtyLabel(m.quantity, m.unit)}
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
