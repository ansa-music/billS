import { useMemo, useState } from 'react';
import type { IngredientView, SuppliesView, SupplyView } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { FormError } from '../cash/Modal.tsx';
import { EmptyState, SectionCard } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { parseMajor } from '../pages/bar/money.tsx';
import { formatDateTime } from '../ui.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { byName, matches, packOf, parseQty, qtyLabel } from './stock.ts';

type Run = <T>(key: string, path: string, body?: object) => Promise<T | undefined>;

interface Line {
  key: number;
  ingredientId: string;
  quantity: string;
  amount: string;
}

let nextKey = 1;

/** «Поставки»: receive a delivery (supplier, lines with quantity and sum, total) and the deliveries so far. */
export function SuppliesTab({ ingredients, run, busy, notify }: { ingredients: IngredientView[]; run: Run; busy: boolean; notify: (m: string) => void }) {
  const { state, version } = useHub();
  const currency = state.club.currency;
  const tz = state.club.timezone;
  const list = useLive(() => fetchJson<SuppliesView>('/api/stock/supplies'), [], version);
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const active = useMemo(() => byName(ingredients.filter((i) => !i.isArchived)), [ingredients]);
  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const found = query.trim() ? active.filter((i) => matches(i.name, query)).slice(0, 8) : [];
  const suppliers = useMemo(() => [...new Set((list.data?.supplies ?? []).map((s) => s.supplier))].slice(0, 20), [list.data]);

  const parsed = lines.map((l) => ({ ...l, qty: parseQty(l.quantity), sum: l.amount.trim() ? parseMajor(l.amount, currency) : 0 }));
  const total = parsed.reduce((s, l) => s + (l.sum ?? 0), 0);

  const add = (ingredientId: string) => {
    setLines((ls) => [...ls, { key: nextKey++, ingredientId, quantity: '', amount: '' }]);
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
    const saved = await run<SupplyView>('supply', '/api/stock/supplies', {
      supplier: supplier.trim(),
      ...(note.trim() ? { note: note.trim() } : {}),
      lines: parsed.map((l) => ({ ingredientId: l.ingredientId, quantity: l.qty!, amount: l.sum! })),
    });
    if (saved) {
      notify(`Поставка принята: ${formatMoney(saved.total, currency)}`);
      setLines([]);
      setNote('');
      setSupplier('');
    }
  };

  return (
    <div className="stock-tab stock-two">
      <SectionCard title="Новая поставка" className="stock-supply-form">
        <label className="field">
          <span>Поставщик</span>
          <input
            value={supplier}
            maxLength={80}
            list="stock-suppliers"
            onChange={(e) => setSupplier(e.target.value)}
            placeholder="Молочная ферма, Метро…"
          />
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
          {query.trim() && found.length === 0 && <p className="muted">Такого сырья нет — его добавляет управляющий в «Остатках».</p>}
        </div>

        {parsed.length === 0 ? (
          <p className="muted">Найдите сырьё по названию и нажмите на него — появится строка поставки.</p>
        ) : (
          <ul className="stock-lines">
            {parsed.map((l, idx) => {
              const ing = byId.get(l.ingredientId);
              const unit = ing?.unit ?? 'шт';
              const pack = packOf(unit);
              const perPack = l.qty && l.sum ? Math.round((l.sum / l.qty) * pack.size) : null;
              return (
                <li key={l.key} className="stock-line">
                  <div className="stock-line-head">
                    <span className="stock-line-name">
                      {idx + 1}. {ing?.name ?? '—'}
                    </span>
                    <button type="button" className="btn btn-small" aria-label="Убрать строку" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                  <div className="stock-line-fields">
                    <label className="field">
                      <span>Количество, {unit}</span>
                      <input inputMode="decimal" value={l.quantity} onChange={(e) => patch(l.key, { quantity: e.target.value })} placeholder="0" />
                    </label>
                    <label className="field">
                      <span>Сумма по накладной</span>
                      <input inputMode="decimal" value={l.amount} onChange={(e) => patch(l.key, { amount: e.target.value })} placeholder="0" />
                    </label>
                  </div>
                  {perPack !== null && (
                    <span className="hint">
                      {formatMoney(perPack, currency)} за 1 {pack.label}
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
          Принять поставку
        </button>
      </SectionCard>

      <SectionCard title="Прошлые поставки">
        {list.error && <p className="form-error">{list.error}</p>}
        {!list.data ? (
          <p className="muted">Загрузка…</p>
        ) : list.data.supplies.length === 0 ? (
          <EmptyState icon="orders" title="Поставок ещё не было" />
        ) : (
          <ul className="stock-docs">
            {list.data.supplies.map((s) => (
              <li key={s.id}>
                <details>
                  <summary>
                    <span className="stock-doc-title">
                      {s.supplier}
                      <span className="muted">
                        {formatDateTime(s.at, tz)} · {s.createdBy}
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
                </details>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
