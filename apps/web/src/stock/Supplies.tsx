import { useEffect, useMemo, useState } from 'react';
import type { IngredientUnit, IngredientView, Minor, SuppliesView, SupplyLineInput, SupplyView } from '@bills/domain';
import { bigUnitOf, formatMoney, INGREDIENT_UNITS } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { FormError, Modal } from '../cash/Modal.tsx';
import { EmptyState, SectionCard } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { parseMajor, toMajorText } from '../pages/bar/money.tsx';
import { formatDateTime } from '../ui.tsx';
import { useHub, useLive } from '../useHub.tsx';
import type { SupplyDraft } from './BuyList.tsx';
import { QtyInput } from './QtyInput.tsx';
import { byName, matches, packOf, qtyInput, qtyLabel, typedQty } from './stock.ts';

type Run = <T>(key: string, path: string, body?: object) => Promise<T | undefined>;

interface Line {
  key: number;
  /** A known ingredient, or null with `fresh`: created with the delivery. */
  ingredientId: string | null;
  fresh: { name: string; unit: IngredientUnit } | null;
  quantity: string;
  /** Base units per typed unit: 1000 when typed in кг or л. */
  factor: number;
  amount: string;
  /** Rough sum from «Докупить на неделю», shown as the placeholder of the sum. */
  approx?: Minor | null;
}

let nextKey = 1;

/** Lines of «Докупить на неделю» for a new delivery: the amounts in кг, л or штуки, no sums yet. */
function draftLines(draft: SupplyDraft | null | undefined, ingredients: readonly IngredientView[]): Line[] {
  return (draft ?? []).flatMap((d) => {
    const ing = ingredients.find((i) => i.id === d.ingredientId && !i.isArchived);
    if (!ing) return [];
    const typed = qtyInput(d.quantity, ing.unit);
    return [{ key: nextKey++, ingredientId: ing.id, fresh: null, quantity: typed.text, factor: typed.factor, amount: '', approx: d.approx }];
  });
}

const UNIT_WORD: Record<IngredientUnit, string> = { г: 'кг / г', мл: 'л / мл', шт: 'штуки' };
const DELETE_REASONS = ['Ввели дважды', 'Не та поставка', 'Ошибка в накладной'];

/**
 * «Поставки»: type in a supplier's invoice line by line (кг and л as written on it; something
 * not on the stock yet is created right here), and the deliveries so far — each may be corrected
 * or deleted by the director or the administrator, or by whoever entered it within 30 minutes.
 */
export function SuppliesTab({
  ingredients,
  run,
  busy,
  notify,
  draft,
  onDraftUsed,
}: {
  ingredients: IngredientView[];
  run: Run;
  busy: boolean;
  notify: (m: string) => void;
  /** «Создать поставку» from «Докупить на неделю»: the first new-delivery form starts with these lines. */
  draft?: SupplyDraft | null;
  onDraftUsed?: () => void;
}) {
  const [startLines] = useState(draft ?? null);
  useEffect(() => {
    if (draft) onDraftUsed?.();
  }, [draft, onDraftUsed]);
  const { state, version, serverNow } = useHub();
  const currency = state.club.currency;
  const tz = state.club.timezone;
  const list = useLive(() => fetchJson<SuppliesView>('/api/stock/supplies'), [], version);
  const [editing, setEditing] = useState<SupplyView | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [deleting, setDeleting] = useState<SupplyView | null>(null);
  const suppliers = useMemo(() => [...new Set((list.data?.supplies ?? []).map((s) => s.supplier))].slice(0, 20), [list.data]);

  const startEdit = (s: SupplyView) => {
    setEditing(s);
    setFormKey((k) => k + 1);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="stock-tab stock-two">
      <SupplyForm
        key={`${editing?.id ?? 'new'}:${formKey}`}
        editing={editing}
        draft={!editing && formKey === 0 ? startLines : null}
        ingredients={ingredients}
        suppliers={suppliers}
        currency={currency}
        tz={tz}
        busy={busy}
        run={run}
        onDone={(message) => {
          notify(message);
          setEditing(null);
          setFormKey((k) => k + 1);
        }}
        onCancel={() => setEditing(null)}
      />

      <SectionCard title="Прошлые поставки">
        {list.error && <p className="form-error">{list.error}</p>}
        {!list.data ? (
          <p className="muted">Загрузка…</p>
        ) : list.data.supplies.length === 0 ? (
          <EmptyState icon="orders" title="Поставок ещё не было" />
        ) : (
          <ul className="stock-docs">
            {list.data.supplies.map((s) => (
              <li key={s.id} data-deleted={s.deletedAt !== null || undefined}>
                <details>
                  <summary>
                    <span className="stock-doc-title">
                      <span>
                        {s.supplier}
                        {s.deletedAt !== null && <span className="tag tag-muted">удалена</span>}
                        {s.deletedAt === null && s.changedAt !== null && <span className="tag tag-muted">исправлена</span>}
                      </span>
                      <span className="muted">
                        {formatDateTime(s.at, tz)} · {s.createdBy} · {s.lines.length} {s.lines.length === 1 ? 'строка' : s.lines.length < 5 ? 'строки' : 'строк'}
                      </span>
                    </span>
                    <strong className="money">{formatMoney(s.total, currency)}</strong>
                  </summary>
                  <ul className="stock-doc-lines">
                    {s.lines.map((l, i) => (
                      <li key={i}>
                        <span>{l.name}</span>
                        <span>{qtyLabel(l.quantity, l.unit)}</span>
                        <span className="money">{formatMoney(l.amount, currency)}</span>
                      </li>
                    ))}
                  </ul>
                  {s.note && <p className="muted">{s.note}</p>}
                  {s.deletedAt !== null ? (
                    <p className="muted">
                      Удалена {formatDateTime(s.deletedAt, tz)} · {s.deletedBy}
                      {s.deleteReason ? ` · ${s.deleteReason}` : ''}. Всё, что она добавила, снято со склада.
                    </p>
                  ) : (
                    <>
                      {s.changedAt !== null && (
                        <p className="muted">
                          Исправлена {formatDateTime(s.changedAt, tz)} · {s.changedBy}
                        </p>
                      )}
                      {s.canChange ? (
                        <div className="stock-doc-actions">
                          {s.changeUntil !== null && (
                            <span className="hint">Свою поставку можно исправить ещё {Math.max(1, Math.ceil((s.changeUntil - serverNow) / 60000))} мин</span>
                          )}
                          <button type="button" className="btn" disabled={busy} onClick={() => startEdit(s)}>
                            <Icon name="edit" size={16} /> Исправить
                          </button>
                          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setDeleting(s)}>
                            <Icon name="trash" size={16} /> Удалить поставку
                          </button>
                        </div>
                      ) : (
                        <p className="hint">Исправить или удалить её может директор или управляющий.</p>
                      )}
                    </>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {deleting && (
        <DeleteSupplyDialog
          supply={deleting}
          ingredients={ingredients}
          currency={currency}
          tz={tz}
          busy={busy}
          onClose={() => setDeleting(null)}
          onConfirm={async (reason) => {
            const done = await run<SupplyView>(`supply:${deleting.id}`, `/api/stock/supplies/${deleting.id}/delete`, reason ? { reason } : {});
            if (done) {
              setDeleting(null);
              if (editing?.id === deleting.id) setEditing(null);
              notify(`Поставка от «${deleting.supplier}» удалена: всё, что она добавила, снято со склада`);
            }
          }}
        />
      )}
    </div>
  );
}

function SupplyForm({
  editing,
  draft,
  ingredients,
  suppliers,
  currency,
  tz,
  busy,
  run,
  onDone,
  onCancel,
}: {
  editing: SupplyView | null;
  draft: SupplyDraft | null;
  ingredients: IngredientView[];
  suppliers: string[];
  currency: string;
  tz: string;
  busy: boolean;
  run: Run;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [supplier, setSupplier] = useState(editing?.supplier ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [lines, setLines] = useState<Line[]>(() =>
    (editing?.lines ?? []).map((l): Line => {
      const typed = qtyInput(l.quantity, l.unit);
      return {
        key: nextKey++,
        ingredientId: l.ingredientId,
        fresh: null,
        quantity: typed.text,
        factor: typed.factor,
        amount: l.amount ? toMajorText(l.amount, currency) : '',
      };
    }).concat(editing ? [] : draftLines(draft, ingredients)),
  );
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(() => byName(ingredients.filter((i) => !i.isArchived)), [ingredients]);
  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const q = query.trim().replace(/\s+/g, ' ');
  const found = q ? active.filter((i) => matches(i.name, q)).slice(0, 8) : [];
  const exact = q ? active.some((i) => i.name.toLocaleLowerCase('ru') === q.toLocaleLowerCase('ru')) : true;

  const parsed = lines.map((l) => ({ ...l, qty: typedQty(l.quantity, l.factor), sum: l.amount.trim() ? parseMajor(l.amount, currency) : 0 }));
  const total = parsed.reduce((s, l) => s + (l.sum ?? 0), 0);

  const add = (ingredientId: string) => {
    const ing = byId.get(ingredientId);
    setLines((ls) => [...ls, { key: nextKey++, ingredientId, fresh: null, quantity: '', factor: ing ? bigUnitOf(ing.unit).factor : 1, amount: '' }]);
    setQuery('');
  };
  const addFresh = (unit: IngredientUnit) => {
    setLines((ls) => [...ls, { key: nextKey++, ingredientId: null, fresh: { name: q, unit }, quantity: '', factor: bigUnitOf(unit).factor, amount: '' }]);
    setQuery('');
  };
  const patch = (key: number, p: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...p } : l)));

  const submit = async () => {
    if (!supplier.trim()) return setError('Укажите поставщика');
    if (parsed.length === 0) return setError('Добавьте хотя бы одну строку');
    const bad = parsed.findIndex((l) => l.qty === null || l.qty <= 0);
    if (bad >= 0) return setError(`Строка ${bad + 1}: укажите количество`);
    const badSum = parsed.findIndex((l) => l.sum === null);
    if (badSum >= 0) return setError(`Строка ${badSum + 1}: сумма — число`);
    setError(null);
    const body = {
      supplier: supplier.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
      lines: parsed.map(
        (l): SupplyLineInput =>
          l.ingredientId ? { ingredientId: l.ingredientId, quantity: l.qty!, amount: l.sum! } : { newIngredient: l.fresh!, quantity: l.qty!, amount: l.sum! },
      ),
    };
    const saved = editing
      ? await run<SupplyView>(`supply:${editing.id}`, `/api/stock/supplies/${editing.id}/update`, body)
      : await run<SupplyView>('supply', '/api/stock/supplies', body);
    if (saved) onDone(editing ? `Поставка исправлена: ${formatMoney(saved.total, currency)}` : `Поставка принята: ${formatMoney(saved.total, currency)}`);
  };

  return (
    <SectionCard
      title={editing ? `Исправить поставку от ${formatDateTime(editing.at, tz)}` : 'Новая поставка'}
      className="stock-supply-form"
      actions={
        editing ? (
          <button type="button" className="btn btn-small" onClick={onCancel}>
            Отменить
          </button>
        ) : undefined
      }
    >
      {editing && <p className="hint">Склад изменится только на разницу: что убрали — снимется, что добавили — прибавится.</p>}
      <label className="field">
        <span>Поставщик</span>
        <input value={supplier} maxLength={80} list="stock-suppliers" onChange={(e) => setSupplier(e.target.value)} placeholder="Молочная ферма, Метро…" />
        <datalist id="stock-suppliers">
          {suppliers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>

      <div className="stock-picker">
        <label className="stock-search">
          <Icon name="search" size={18} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Что привезли? Начните вводить название"
            aria-label="Найти сырьё для поставки"
            enterKeyHint="search"
          />
        </label>
        {found.length > 0 && (
          <div className="stock-found" role="list">
            {found.map((i) => (
              <button key={i.id} type="button" className="chip" role="listitem" onClick={() => add(i.id)}>
                <Icon name="plus" size={16} /> {i.name}
              </button>
            ))}
          </div>
        )}
        {q && !exact && (
          <div className="stock-new-inline">
            <span>
              {found.length === 0 ? 'Такого сырья на складе нет.' : 'Нет нужного?'} Добавить «{q}» как новое сырьё, считаем в:
            </span>
            <div className="seg-chips" role="group" aria-label={`Новое сырьё «${q}»: единица`}>
              {INGREDIENT_UNITS.map((u) => (
                <button key={u} type="button" className="chip" onClick={() => addFresh(u)}>
                  <Icon name="plus" size={16} /> {UNIT_WORD[u]}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {parsed.length === 0 ? (
        <p className="muted">Найдите сырьё по названию и нажмите на него — появится строка поставки. Количество — как в накладной: кг, л или штуки.</p>
      ) : (
        <ul className="stock-lines">
          {parsed.map((l, idx) => {
            const ing = l.ingredientId ? byId.get(l.ingredientId) : undefined;
            const unit = ing?.unit ?? l.fresh?.unit ?? 'шт';
            const pack = packOf(unit);
            const perPack = l.qty && l.sum ? Math.round((l.sum / l.qty) * pack.size) : null;
            return (
              <li key={l.key} className="stock-line">
                <div className="stock-line-head">
                  <span className="stock-line-name">
                    {idx + 1}. {ing?.name ?? l.fresh?.name ?? '—'}
                    {l.fresh && <span className="tag tag-ok">новое</span>}
                  </span>
                  <button type="button" className="btn btn-small" aria-label="Убрать строку" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
                <div className="stock-line-fields">
                  <label className="field">
                    <span>Количество</span>
                    <QtyInput
                      value={l.quantity}
                      factor={l.factor}
                      unit={unit}
                      label={`Количество: ${ing?.name ?? l.fresh?.name ?? ''}`}
                      invalid={l.quantity.trim() !== '' && l.qty === null}
                      onChange={(text, factor) => patch(l.key, { quantity: text, factor })}
                    />
                  </label>
                  <label className="field">
                    <span>Сумма, {currency}</span>
                    <input
                      inputMode="decimal"
                      value={l.amount}
                      onChange={(e) => patch(l.key, { amount: e.target.value })}
                      placeholder={l.approx != null ? `≈ ${formatMoney(l.approx, currency)}` : '0'}
                    />
                  </label>
                </div>
                {(perPack !== null || (l.qty !== null && l.factor > 1)) && (
                  <span className="hint">
                    {l.qty !== null && l.factor > 1 ? `= ${l.qty.toLocaleString('ru-RU')} ${unit}` : ''}
                    {l.qty !== null && l.factor > 1 && perPack !== null ? ' · ' : ''}
                    {perPack !== null ? `${formatMoney(perPack, currency)} за 1 ${pack.label}` : ''}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <label className="field">
        <span>Комментарий</span>
        <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="номер накладной, что не довезли" />
      </label>
      <div className="stock-total">
        <span>Итого</span>
        <strong className="money">{formatMoney(total, currency)}</strong>
      </div>
      <FormError error={error} />
      <button type="button" className="btn btn-primary btn-large" disabled={busy} onClick={() => void submit()}>
        {editing ? 'Сохранить исправления' : 'Принять поставку'}
      </button>
    </SectionCard>
  );
}

/**
 * «Удалить поставку?»: the date, the supplier and every line it takes back; lines whose stock was
 * used already say what the level becomes («станет −1,5 кг»), so nothing happens by surprise.
 */
function DeleteSupplyDialog({
  supply,
  ingredients,
  currency,
  tz,
  busy,
  onClose,
  onConfirm,
}: {
  supply: SupplyView;
  ingredients: IngredientView[];
  currency: string;
  tz: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  // Lines of one ingredient add up: the level after is the level now minus all of them.
  const taken = new Map<string, number>();
  for (const l of supply.lines) taken.set(l.ingredientId, (taken.get(l.ingredientId) ?? 0) + l.quantity);
  const below = [...taken]
    .map(([id, q]) => ({ ing: byId.get(id), after: Math.round(((byId.get(id)?.quantity ?? 0) - q) * 1000) / 1000 }))
    .filter((x) => x.ing && x.after < 0);
  return (
    <Modal
      title="Удалить поставку?"
      onClose={onClose}
      className="stock-modal"
      footer={
        <div className="stock-modal-foot">
          <div className="row wrap">
            <button type="button" className="btn" onClick={onClose}>
              Не удалять
            </button>
            <button type="button" className="btn btn-danger btn-large" disabled={busy} onClick={() => onConfirm(reason.trim())}>
              Удалить поставку
            </button>
          </div>
        </div>
      }
    >
      <div className="stock-form">
        <p>
          <strong>«{supply.supplier}»</strong> от {formatDateTime(supply.at, tz)} на <strong className="money">{formatMoney(supply.total, currency)}</strong>. Со
          склада снимется ровно то, что она добавила:
        </p>
        <ul className="stock-doc-lines stock-confirm-lines">
          {supply.lines.map((l, i) => (
            <li key={i}>
              <span>{l.name}</span>
              <span className="stock-minus">−{qtyLabel(l.quantity, l.unit)}</span>
              <span className="money">{formatMoney(l.amount, currency)}</span>
            </li>
          ))}
        </ul>
        {below.length > 0 && (
          <div className="warn-note">
            Часть уже ушла в продажи — остаток станет минусом:{' '}
            {below.map((b) => `${b.ing!.name} — ${qtyLabel(b.after, b.ing!.unit)}`).join(', ')}. Продажи не отменяются; примите правильную поставку
            или исправьте остаток.
          </div>
        )}
        <p className="hint">Поставка останется в списке с пометкой «удалена», в истории сырья появится «Поставка удалена». Цена сырья вернётся к прежней.</p>
        <div className="field">
          <span>Почему (необязательно)</span>
          <div className="seg-chips" role="group" aria-label="Причина">
            {DELETE_REASONS.map((r) => (
              <button key={r} type="button" className="chip" aria-pressed={reason === r} onClick={() => setReason(reason === r ? '' : r)}>
                {r}
              </button>
            ))}
          </div>
          <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="или своими словами" />
        </div>
      </div>
    </Modal>
  );
}
