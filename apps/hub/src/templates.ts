import type { Action, CatalogView, ProductOptionGroup, TariffConfig } from '@bills/domain';
import { transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { Hub } from './hub.ts';
import { CAFE_MENU, DEMO_MENU, SNOOKER, STANDARD } from './seed.ts';

/**
 * «Заполнить примером»: ready-made tariffs and menus for an empty club, so a
 * new owner sees how things look and edits them instead of starting from a
 * blank form. Same data as the demo (seed.ts). Everything goes through the
 * ordinary services (audit, change events, license limits), in one transaction.
 * Rows that already exist by name are left alone, so applying twice adds nothing.
 */
export const TEMPLATE_KINDS = ['tariffs-standard', 'menu-cafe', 'menu-bar'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** What a template needs the person to be allowed to do. */
export const TEMPLATE_ACTION: Record<TemplateKind, Action> = {
  'tariffs-standard': 'tariffs.edit',
  'menu-cafe': 'catalog.edit',
  'menu-bar': 'catalog.edit',
};

export interface ApplyTemplateResult {
  kind: TemplateKind;
  tariffs: number;
  categories: number;
  products: number;
}

type MenuTemplate = Array<[category: string, products: Array<[name: string, price: number, options: ProductOptionGroup[], stock: number | null]>]>;

const TARIFFS: Array<[name: string, config: TariffConfig]> = [
  ['Стандарт', STANDARD],
  ['Снукер', SNOOKER],
];

const MENUS: Record<'menu-cafe' | 'menu-bar', MenuTemplate> = {
  'menu-cafe': CAFE_MENU,
  'menu-bar': DEMO_MENU.map(([category, products]) => [category, products.map(([name, price]) => [name, price, [], null])]),
};

export function applyTemplate(hub: Hub, kind: TemplateKind, actor: string): ApplyTemplateResult {
  const result: ApplyTemplateResult = { kind, tariffs: 0, categories: 0, products: 0 };
  return transaction(hub.db, () => {
    if (kind === 'tariffs-standard') {
      const club = hub.settings.club();
      const currency = club.currency;
      const taken = new Set(club.tariffs.filter((t) => t.isActive).map((t) => t.name));
      for (const [name, config] of TARIFFS) {
        if (taken.has(name)) continue;
        hub.settings.createTariff({ name, config: { ...config, currency }, actor });
        result.tariffs++;
      }
      return result;
    }
    const menu = MENUS[kind];
    if (!menu) throw new HubError(400, 'BAD_TEMPLATE', 'Неизвестный шаблон');
    const catalog: CatalogView = hub.bar.catalog();
    for (const [categoryName, products] of menu) {
      let categoryId = catalog.categories.find((c) => c.name === categoryName)?.id;
      if (!categoryId) {
        categoryId = hub.bar.createCategory({ name: categoryName, actor }).id;
        result.categories++;
      }
      const names = new Set(catalog.products.filter((p) => p.categoryId === categoryId).map((p) => p.name));
      for (const [name, price, options, stock] of products) {
        if (names.has(name)) continue;
        hub.bar.createProduct({ categoryId, name, price, stock, ...(options.length ? { options } : {}), actor });
        result.products++;
      }
    }
    return result;
  });
}
