import { useState } from 'react';
import { fetchJson } from '../api.ts';
import { useHub, useLive } from '../useHub.tsx';
import { plural } from './stock.ts';
import './stock-reports.css';

type Run = <T>(key: string, path: string, body?: object) => Promise<T | undefined>;

/** GET /api/stock/sample/fill (apps/hub stock-sample.ts). */
interface SamplePreview {
  ingredients: number;
  products: Array<{ productId: string; name: string; sample: string }>;
}

interface SampleResult {
  ingredients: number;
  recipes: number;
}

function sampleMessage(r: SampleResult): string {
  if (r.ingredients === 0 && r.recipes === 0) return 'Добавлять нечего: всё уже есть';
  const parts: string[] = [];
  if (r.ingredients > 0) parts.push(`${r.ingredients} ${plural(r.ingredients, 'позиция', 'позиции', 'позиций')} сырья`);
  if (r.recipes > 0) parts.push(`состав ${r.recipes} ${plural(r.recipes, 'напитка', 'напитков', 'напитков')}`);
  return `Добавлен пример: ${parts.join(' и ')}. Поправьте цифры под себя или уберите его кнопкой «Убрать пример»`;
}

/**
 * The empty «Остатки» (`stock.edit`): start from the example instead of typing every raw material —
 * coffee, milk, syrups and cups with approximate prices and levels, and what the drinks of this
 * menu are made of (recognised by their names, fitted to their sizes and options). Everything it
 * adds is marked «пример», changes like the owner's own and goes away with «Убрать пример».
 */
export function SampleStart({ run, busy, notify }: { run: Run; busy: boolean; notify: (m: string) => void }) {
  const { version } = useHub();
  const { data: preview } = useLive(() => fetchJson<SamplePreview>('/api/stock/sample/fill'), [], version);
  const [pending, setPending] = useState(false);
  const drinks = preview?.products.map((p) => p.name) ?? [];
  const fill = async () => {
    setPending(true);
    const r = await run<SampleResult>('stock:sample-fill', '/api/stock/sample/fill', {});
    setPending(false);
    if (r) notify(sampleMessage(r));
  };
  return (
    <div className="stock-sample">
      <p className="stock-sample-title">Склад пуст — начните с примера</p>
      <p className="muted">
        Добавим кофе, молоко, сиропы и стаканы с примерными ценами и остатками
        {drinks.length > 0 ? (
          <>
            {' '}
            и состав для: <strong>{drinks.slice(0, 8).join(', ')}</strong>
            {drinks.length > 8 ? ` и ещё ${drinks.length - 8}` : ''}
          </>
        ) : (
          ' — состав добавим напиткам, которые узнаем по названию (латте, капучино, американо…)'
        )}
        . Всё будет помечено «пример»: меняйте как своё — после поставки или инвентаризации цифры станут настоящими — или уберите
        целиком кнопкой «Убрать пример».
      </p>
      <div className="stock-sample-actions">
        <button type="button" className="btn btn-primary btn-large" disabled={busy || pending} onClick={() => void fill()}>
          {pending ? 'Заполняем…' : 'Заполнить примером'}
        </button>
      </div>
    </div>
  );
}
