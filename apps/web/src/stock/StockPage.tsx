import { useCallback, useState } from 'react';
import type { Action, StockSetupView } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { Icon } from '../icons.tsx';
import { useCommands, useHub, useLive } from '../useHub.tsx';
import { navigate, useLocation } from '../router.tsx';
import { Loading, Page, Toast, useToast } from '../ui.tsx';
import { InventoryTab } from './Inventory.tsx';
import { LevelsTab } from './Levels.tsx';
import { RecipesTab } from './Recipes.tsx';
import { plural, useIngredients } from './stock.ts';
import { SuppliesTab } from './Supplies.tsx';
import './stock.css';

type Tab = 'levels' | 'supplies' | 'recipes' | 'inventory';

const TABS: Array<{ id: Tab; label: string; action: Action }> = [
  { id: 'levels', label: 'Остатки', action: 'stock.view' },
  { id: 'supplies', label: 'Поставки', action: 'stock.supply' },
  { id: 'recipes', label: 'Состав', action: 'stock.view' },
  { id: 'inventory', label: 'Инвентаризация', action: 'stock.view' },
];

const HIDE_KEY = 'ts.stock.checklist.hidden';

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * #/stock — «Склад» of a coffee shop: levels, deliveries, recipes (граммовка) and counts.
 * Senior staff see every tab and, until it is all set up, the four steps of a café's stock;
 * a cashier or a barista only receives deliveries.
 */
export function StockPage() {
  const hub = useHub();
  const { query } = useLocation();
  const { toast, show, clear } = useToast();
  const { run, busy } = useCommands(show);
  const ingredients = useIngredients();
  const [openNew, setOpenNew] = useState(false);
  const tabs = TABS.filter((t) => hub.can(t.action));
  const wanted = query.get('tab') as Tab | null;
  const tab = tabs.find((t) => t.id === wanted)?.id ?? tabs[0]?.id ?? 'supplies';
  const props = { ingredients: ingredients.data?.ingredients ?? [], run, busy: busy.size > 0 || !hub.online, notify: show };
  const go = (t: Tab) => navigate('/stock', { tab: t });
  const onNewOpened = useCallback(() => setOpenNew(false), []);

  return (
    <Page title="Склад">
      {hub.can('stock.view') && (
        <Checklist
          onIngredients={() => {
            go('levels');
            setOpenNew(true);
          }}
          onRecipes={() => go('recipes')}
          onSupplies={() => go('supplies')}
        />
      )}
      {tabs.length > 1 && (
        <nav className="stock-tabs" aria-label="Разделы склада">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className="stock-tab-btn"
              aria-current={t.id === tab ? 'page' : undefined}
              onClick={() => go(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
      {!ingredients.data ? (
        ingredients.error ? <p className="form-error">{ingredients.error}</p> : <Loading online={hub.online} />
      ) : tab === 'levels' ? (
        <LevelsTab {...props} openNew={openNew} onNewOpened={onNewOpened} />
      ) : tab === 'supplies' ? (
        <SuppliesTab {...props} />
      ) : tab === 'recipes' ? (
        <RecipesTab {...props} />
      ) : (
        <InventoryTab {...props} />
      )}
      <Toast message={toast} onClose={clear} />
    </Page>
  );
}

/**
 * «Как начать»: raw materials → what each drink is made of → deliveries → sales take it off by
 * themselves. Each step says whether it is done; it disappears once everything is (or on «Скрыть»).
 */
function Checklist({ onIngredients, onRecipes, onSupplies }: { onIngredients: () => void; onRecipes: () => void; onSupplies: () => void }) {
  const { version } = useHub();
  const { data } = useLive(() => fetchJson<StockSetupView>('/api/stock/setup'), [], version);
  const [hidden, setHidden] = useState(readHidden);
  if (!data || hidden) return null;
  const withRecipe = data.products - data.withoutRecipe.length;
  const steps = [
    {
      done: data.ingredients > 0,
      title: 'Сырьё',
      text: data.ingredients > 0 ? `${data.ingredients} ${plural(data.ingredients, 'позиция', 'позиции', 'позиций')}: зерно, молоко, стаканы…` : 'Зерно, молоко, сиропы, стаканы — из чего готовите.',
      action: 'Добавить сырьё',
      onClick: onIngredients,
    },
    {
      // Ready goods (a croissant) may rightly have none: one recipe is enough to call the step done.
      done: withRecipe > 0,
      title: 'Состав напитков',
      text:
        data.products === 0
          ? 'Сначала добавьте позиции в «Меню».'
          : withRecipe === 0
            ? 'Капучино = зерно 18 г + молоко 150 мл. Без состава продажа не списывает склад.'
            : `Есть у ${withRecipe} из ${data.products}. Без состава: ${data.withoutRecipe.slice(0, 3).map((p) => p.name).join(', ')}${data.withoutRecipe.length > 3 ? '…' : ''}`,
      action: 'Заполнить состав',
      onClick: onRecipes,
      more: data.withoutRecipe.length > 0,
    },
    {
      done: data.supplies > 0,
      title: 'Поставки',
      text: data.supplies > 0 ? 'Склад прибавляет и запоминает цену.' : 'Внесите накладную — склад прибавит количество и запомнит цену.',
      action: 'Принять поставку',
      onClick: onSupplies,
    },
    {
      done: data.sales > 0,
      title: 'Продажи списывают сами',
      text: 'Каждая продажа на кассе снимает состав со склада, отмена заказа возвращает.',
      action: null,
      onClick: null,
    },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <section className="stock-checklist" aria-label="Как начать со складом">
      <header>
        <h2>Склад за 4 шага</h2>
        <button
          type="button"
          className="btn btn-small"
          onClick={() => {
            setHidden(true);
            try {
              localStorage.setItem(HIDE_KEY, '1');
            } catch {
              // A private window: hidden until the page reloads.
            }
          }}
        >
          Скрыть
        </button>
      </header>
      <ol>
        {steps.map((s, i) => (
          <li key={s.title} data-done={s.done || undefined}>
            <span className="stock-step-num" aria-hidden="true">
              {s.done ? <Icon name="check" size={16} /> : i + 1}
            </span>
            <div>
              <strong>
                {s.title}
                {s.done && <span className="sr-only"> — готово</span>}
              </strong>
              <span>{s.text}</span>
            </div>
            {s.action && s.onClick && (!s.done || ('more' in s && s.more)) && (
              <button type="button" className="btn btn-small" onClick={s.onClick}>
                {s.action}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
