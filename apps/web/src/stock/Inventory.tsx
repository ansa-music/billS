import { useMemo, useState } from 'react';
import type { IngredientView, StockCountsView, StockCountView } from '@bills/domain';
import { bigUnitOf, formatMoney } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { FormError } from '../cash/Modal.tsx';
import { EmptyState, SectionCard } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { formatDateTime } from '../ui.tsx';
import { useHub, useLive } from '../useHub.tsx';
import { QtyInput } from './QtyInput.tsx';
import { byName, matches, qtyLabel, typedQty, valueOf } from './stock.ts';

type Run = <T>(key: string, path: string, body?: object) => Promise<T | undefined>;

/**
 * «Инвентаризация»: every ingredient with what the system expects, the counted amount typed
 * in, the difference and its cost live; saving sets the stock to what was counted.
 * Blank rows are left as they are (a partial count of just the milk is fine).
 */
export function InventoryTab({ ingredients, run, busy, notify }: { ingredients: IngredientView[]; run: Run; busy: boolean; notify: (m: string) => void }) {
  const { state, version, canNow } = useHub();
  const currency = state.club.currency;
  const tz = state.club.timezone;
  const history = useLive(() => fetchJson<StockCountsView>('/api/stock/counts'), [], version);
  const [counting, setCounting] = useState(false);
  // What was typed per ingredient and in which unit (кг or г, л or мл).
  const [counted, setCounted] = useState<Record<string, { text: string; factor: number }>>({});
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const canEdit = canNow('stock.edit');

  const active = useMemo(() => byName(ingredients.filter((i) => !i.isArchived)), [ingredients]);
  const rows = active.map((i) => {
    const text = counted[i.id]?.text ?? '';
    // Counted in the unit the level reads in: 1,4 кг of beans, 50 г of cinnamon.
    const big = bigUnitOf(i.unit).factor;
    const factor = counted[i.id]?.factor ?? (Math.abs(i.quantity) >= big ? big : 1);
    const value = text.trim() ? typedQty(text, factor) : null;
    const difference = value === null ? null : Math.round((value - i.quantity) * 1000) / 1000;
    return { i, text, factor, value, difference, cost: difference === null ? null : valueOf(difference, i.costPerUnit) };
  });
  const filled = rows.filter((r) => r.value !== null);
  const invalid = rows.filter((r) => r.text.trim() && r.value === null);
  const shortage = filled.reduce((s, r) => s + Math.min(0, r.cost ?? 0), 0);
  const surplus = filled.reduce((s, r) => s + Math.max(0, r.cost ?? 0), 0);

  const save = async () => {
    if (invalid.length) return setError(`Проверьте: ${invalid.map((r) => r.i.name).join(', ')} — нужно число`);
    if (filled.length === 0) return setError('Введите посчитанное хотя бы для одного сырья');
    setError(null);
    const saved = await run<StockCountView>('count', '/api/stock/counts', {
      ...(note.trim() ? { note: note.trim() } : {}),
      lines: filled.map((r) => ({ ingredientId: r.i.id, counted: r.value! })),
    });
    if (saved) {
      notify(`Инвентаризация сохранена: разница ${formatMoney(saved.diffCost, currency)}`);
      setCounting(false);
      setCounted({});
      setNote('');
    }
  };

  return (
    <div className="stock-tab">
      {counting ? (
        <SectionCard
          title="Инвентаризация"
          actions={
            <button type="button" className="btn btn-small" onClick={() => setCounting(false)}>
              Отменить
            </button>
          }
        >
          <p className="muted">Посчитайте, что есть на самом деле, и впишите. Пустые строки не меняются.</p>
          <label className="stock-search">
            <Icon name="search" size={18} />
            <input type="search" placeholder="Найти сырьё" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Найти сырьё" />
          </label>
          <div className="stock-count" role="table" aria-label="Инвентаризация">
            <div className="stock-count-row stock-count-head" role="row">
              <span role="columnheader">Сырьё</span>
              <span role="columnheader">По учёту</span>
              <span role="columnheader">Посчитали</span>
              <span role="columnheader">Разница</span>
            </div>
            {rows
              .filter((r) => matches(r.i.name, query))
              .map((r) => (
                <div key={r.i.id} className="stock-count-row" role="row" data-diff={r.difference ? (r.difference < 0 ? 'minus' : 'plus') : undefined}>
                  <span role="cell" className="stock-count-name">
                    {r.i.name}
                  </span>
                  <span role="cell" className="stock-count-expected">
                    {qtyLabel(r.i.quantity, r.i.unit)}
                  </span>
                  <span role="cell" className="stock-count-input">
                    <QtyInput
                      value={r.text}
                      factor={r.factor}
                      unit={r.i.unit}
                      placeholder="—"
                      label={`Посчитали: ${r.i.name}`}
                      invalid={r.text.trim() !== '' && r.value === null}
                      onChange={(text, factor) => setCounted((c) => ({ ...c, [r.i.id]: { text, factor } }))}
                    />
                  </span>
                  <span role="cell" className="stock-count-diff">
                    {r.difference === null ? (
                      <span className="muted">—</span>
                    ) : (
                      <>
                        <strong>
                          {r.difference > 0 ? '+' : ''}
                          {qtyLabel(r.difference, r.i.unit)}
                        </strong>
                        {r.cost !== null && r.cost !== 0 && <span className="money">{formatMoney(r.cost, currency)}</span>}
                      </>
                    )}
                  </span>
                </div>
              ))}
          </div>
          <div className="stock-count-total">
            <div>
              <span className="muted">Посчитано</span>
              <strong>
                {filled.length} из {rows.length}
              </strong>
            </div>
            <div>
              <span className="muted">Недостача</span>
              <strong className="money" data-tone={shortage < 0 ? 'danger' : undefined}>
                {formatMoney(shortage, currency)}
              </strong>
            </div>
            <div>
              <span className="muted">Излишек</span>
              <strong className="money">{formatMoney(surplus, currency)}</strong>
            </div>
          </div>
          <label className="field">
            <span>Комментарий</span>
            <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="например, «конец месяца»" />
          </label>
          <FormError error={error} />
          <button type="button" className="btn btn-primary btn-large" disabled={busy} onClick={() => void save()}>
            Сохранить инвентаризацию
          </button>
        </SectionCard>
      ) : (
        <SectionCard>
          <div className="stock-count-start">
            <div>
              <h2>Инвентаризация</h2>
              <p className="muted">Сверьте склад с тем, что есть на полках: программа покажет недостачу и её сумму.</p>
            </div>
            {canEdit ? (
              <button type="button" className="btn btn-primary btn-large" onClick={() => setCounting(true)} disabled={active.length === 0}>
                Начать инвентаризацию
              </button>
            ) : (
              <p className="muted">Проводит директор или управляющий.</p>
            )}
          </div>
        </SectionCard>
      )}

      <SectionCard title="Прошлые инвентаризации">
        {history.error && <p className="form-error">{history.error}</p>}
        {!history.data ? (
          <p className="muted">Загрузка…</p>
        ) : history.data.counts.length === 0 ? (
          <EmptyState icon="checks" title="Инвентаризаций ещё не было" />
        ) : (
          <ul className="stock-docs">
            {history.data.counts.map((c) => {
              const changed = c.lines.filter((l) => l.difference !== 0);
              return (
                <li key={c.id}>
                  <details>
                    <summary>
                      <span className="stock-doc-title">
                        {formatDateTime(c.at, tz)}
                        <span className="muted">
                          {c.createdBy} · посчитано {c.lines.length}, расхождений {changed.length}
                        </span>
                      </span>
                      <strong className="money" data-tone={c.diffCost < 0 ? 'danger' : undefined}>
                        {formatMoney(c.diffCost, currency)}
                      </strong>
                    </summary>
                    {changed.length === 0 ? (
                      <p className="muted">Всё сошлось.</p>
                    ) : (
                      <ul className="stock-doc-lines">
                        {changed.map((l) => (
                          <li key={l.ingredientId}>
                            <span>{l.name}</span>
                            <span>
                              {l.difference > 0 ? '+' : ''}
                              {qtyLabel(l.difference, l.unit)}
                            </span>
                            <span className="money">{l.cost === null ? '—' : formatMoney(l.cost, currency)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {c.note && <p className="muted">{c.note}</p>}
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
