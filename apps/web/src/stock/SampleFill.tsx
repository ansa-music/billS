import { useState } from 'react';
import { fetchJson } from '../api.ts';
import { useHub, useLive } from '../useHub.tsx';
import { plural } from './stock.ts';

type Run = <T>(key: string, path: string, body?: object) => Promise<T | undefined>;

/** GET /api/stock/sample (apps/hub stock-sample.ts). */
export interface SamplePreview {
  ingredients: number;
  products: Array<{ productId: string; name: string; sample: string }>;
}

interface SampleResult {
  ingredients: number;
  recipes: number;
}

/** What «Заполнить примером» would add; null while loading or for someone who may not edit the stock. */
export function useSamplePreview(): SamplePreview | null {
  const { version, canNow } = useHub();
  const allowed = canNow('stock.edit');
  const { data } = useLive(
    () => (allowed ? fetchJson<SamplePreview>('/api/stock/sample') : Promise.resolve(null)),
    [allowed],
    version,
  );
  return data ?? null;
}

export function sampleMessage(r: SampleResult): string {
  if (r.ingredients === 0 && r.recipes === 0) return 'Добавлять нечего: всё уже есть';
  const parts: string[] = [];
  if (r.ingredients > 0) parts.push(`${r.ingredients} ${plural(r.ingredients, 'вид', 'вида', 'видов')} сырья`);
  if (r.recipes > 0) parts.push(`${r.recipes} ${plural(r.recipes, 'тех. карта', 'тех. карты', 'тех. карт')}`);
  return `Добавлено: ${parts.join(' и ')}`;
}

/**
 * «Заполнить примером»: the sample raw materials (coffee, milk, syrups, cups) with approximate
 * prices and levels, and тех. карты for the drinks of the menu it recognises by name.
 * `productIds` limits it to those products.
 */
export function SampleFillButton({
  run,
  busy,
  notify,
  productIds,
  label = 'Заполнить примером',
  className = 'btn btn-primary btn-large',
}: {
  run: Run;
  busy: boolean;
  notify: (m: string) => void;
  productIds?: string[];
  label?: string;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy || pending}
      onClick={async () => {
        setPending(true);
        const r = await run<SampleResult>('stock:sample', '/api/stock/sample', productIds ? { productIds } : {});
        setPending(false);
        if (r) notify(sampleMessage(r));
      }}
    >
      {pending ? 'Заполняем…' : label}
    </button>
  );
}

/** The empty «Остатки»: start from the sample instead of typing every raw material. */
export function SampleStart({ run, busy, notify }: { run: Run; busy: boolean; notify: (m: string) => void }) {
  const preview = useSamplePreview();
  const drinks = preview?.products.map((p) => p.name) ?? [];
  return (
    <div className="stock-sample">
      <p className="stock-sample-title">Начните с примера</p>
      <p className="muted">
        Добавим кофе, молоко, сиропы и стаканы с примерными ценами и остатками
        {drinks.length > 0 ? (
          <>
            {' '}
            и тех. карты для: <strong>{drinks.slice(0, 8).join(', ')}</strong>
            {drinks.length > 8 ? ` и ещё ${drinks.length - 8}` : ''}
          </>
        ) : (
          ' — тех. карты добавим к напиткам, которые узнаем по названию (латте, капучино, американо…)'
        )}
        . Потом поправьте цифры под себя: примите поставку или проведите инвентаризацию.
      </p>
      <SampleFillButton run={run} busy={busy} notify={notify} />
    </div>
  );
}
