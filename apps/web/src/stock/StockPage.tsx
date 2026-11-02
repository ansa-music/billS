import { useState } from 'react';
import type { Action } from '@bills/domain';
import { useCommands, useHub } from '../useHub.tsx';
import { navigate, useLocation } from '../router.tsx';
import { Loading, Page, Toast, useToast } from '../ui.tsx';
import { InventoryTab } from './Inventory.tsx';
import { LevelsTab } from './Levels.tsx';
import { RecipesTab } from './Recipes.tsx';
import type { SupplyDraft } from './stock.ts';
import { useIngredients } from './stock.ts';
import { SuppliesTab } from './Supplies.tsx';
import './stock.css';

type Tab = 'levels' | 'supplies' | 'recipes' | 'inventory';

const TABS: Array<{ id: Tab; label: string; action: Action }> = [
  { id: 'levels', label: 'Остатки', action: 'stock.view' },
  { id: 'supplies', label: 'Поставки', action: 'stock.supply' },
  { id: 'recipes', label: 'Тех. карты', action: 'stock.view' },
  { id: 'inventory', label: 'Инвентаризация', action: 'stock.view' },
];

/**
 * #/stock — «Склад» of a coffee shop: levels, deliveries, recipes (граммовка) and counts.
 * Senior staff see every tab; a cashier or a barista only receives deliveries.
 */
export function StockPage() {
  const hub = useHub();
  const { query } = useLocation();
  const { toast, show, clear } = useToast();
  const { run, busy } = useCommands(show);
  const ingredients = useIngredients();
  const tabs = TABS.filter((t) => hub.can(t.action));
  const wanted = query.get('tab') as Tab | null;
  const tab = tabs.find((t) => t.id === wanted)?.id ?? tabs[0]?.id ?? 'supplies';
  const props = { ingredients: ingredients.data?.ingredients ?? [], run, busy: busy.size > 0 || !hub.online, notify: show };
  // «Создать поставку из списка» on «Докупить на неделю»: the delivery form opens filled in.
  const [supplyDraft, setSupplyDraft] = useState<SupplyDraft | null>(null);
  const startSupply = (draft: SupplyDraft) => {
    setSupplyDraft(draft);
    navigate('/stock', { tab: 'supplies' });
  };

  return (
    <Page title="Склад">
      {tabs.length > 1 && (
        <nav className="stock-tabs" aria-label="Разделы склада">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className="stock-tab-btn"
              aria-current={t.id === tab ? 'page' : undefined}
              onClick={() => navigate('/stock', { tab: t.id })}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}
      {!ingredients.data ? (
        ingredients.error ? <p className="form-error">{ingredients.error}</p> : <Loading online={hub.online} />
      ) : tab === 'levels' ? (
        <LevelsTab {...props} onStartSupply={hub.can('stock.supply') ? startSupply : undefined} />
      ) : tab === 'supplies' ? (
        <SuppliesTab {...props} draft={supplyDraft} onDraftUsed={() => setSupplyDraft(null)} />
      ) : tab === 'recipes' ? (
        <RecipesTab {...props} />
      ) : (
        <InventoryTab {...props} />
      )}
      <Toast message={toast} onClose={clear} />
    </Page>
  );
}
