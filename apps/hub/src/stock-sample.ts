import type { IngredientUnit, ProductView, RecipeLine, RecipeOptionLine, SampleChoiceRole, SampleDrink } from '@bills/domain';
import { findIngredient, matchSampleDrink, SAMPLE_DRINK_LABEL, sampleChoiceRoles } from '@bills/domain';
import { transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { Hub } from './hub.ts';

/**
 * The example stock TS puts in: sample raw materials and recipes for a coffee shop. The browser
 * trial calls it for its sample menu (seed.ts CAFE_MENU, template 'menu-cafe'), and an empty
 * «Склад» offers it as «Заполнить примером» — so a coffee shop sees «Склад» working at once: sell
 * a latte and the milk goes down by its граммовка.
 *
 * The recipes are written for drinks, not products: a product of the coffee shop's own menu gets
 * one when its name says which drink it is («Латте 0,4», «Флэт Уайт», «Раф лавандовый» —
 * packages/domain stock-sample.ts), and the option changes are moved onto the product's own
 * choices (its sizes in order, «Овсяное», syrups by name). Raw materials the coffee shop has
 * already (by name or a usual name, same unit) are used instead of new ones, and products with a
 * recipe are left alone — so a second call adds nothing.
 *
 * Everything it adds is marked as the example (`is_sample`): «пример» on the screens, and
 * «Убрать пример» (StockService.removeSample) takes it away again.
 */

type Key = 'coffee' | 'milk' | 'oat' | 'sugar' | 'caramel' | 'vanilla' | 'nut' | 'cupS' | 'cupM' | 'cupL' | 'cocoa';

interface SampleIngredient {
  name: string;
  unit: IngredientUnit;
  quantity: number;
  /** Minor units per one unit: coffee 12 000 ₸/кг = 12 ₸/г = 1200. */
  costPerUnit: number;
  minLevel: number;
  /** Other names the coffee shop may already call it by. */
  aliases: string[];
  /** Added only when a recipe that is being filled needs it. */
  onDemand?: boolean;
}

const INGREDIENTS: Record<Key, SampleIngredient> = {
  coffee: { name: 'Кофе в зёрнах', unit: 'г', quantity: 3000, costPerUnit: 1200, minLevel: 1000, aliases: ['кофе', 'кофе зерновой', 'кофе в зерне', 'зерновой кофе', 'кофе зерно', 'зерно', 'эспрессо смесь'] },
  milk: { name: 'Молоко 3,2%', unit: 'мл', quantity: 12000, costPerUnit: 60, minLevel: 4000, aliases: ['молоко', 'молоко 3 2', 'молоко 2 5', 'молоко коровье'] },
  oat: { name: 'Овсяное молоко', unit: 'мл', quantity: 3000, costPerUnit: 180, minLevel: 1000, aliases: ['молоко овсяное', 'овсяное'] },
  sugar: { name: 'Сахар', unit: 'г', quantity: 2000, costPerUnit: 60, minLevel: 500, aliases: ['сахар песок', 'сахар белый'] },
  caramel: { name: 'Сироп карамельный', unit: 'мл', quantity: 1000, costPerUnit: 400, minLevel: 200, aliases: ['сироп карамель', 'карамельный сироп', 'карамель'] },
  vanilla: { name: 'Сироп ванильный', unit: 'мл', quantity: 1000, costPerUnit: 400, minLevel: 200, aliases: ['сироп ваниль', 'ванильный сироп', 'ваниль'] },
  nut: { name: 'Сироп ореховый', unit: 'мл', quantity: 1000, costPerUnit: 400, minLevel: 200, aliases: ['сироп орех', 'ореховый сироп', 'сироп лесной орех', 'сироп фундук'] },
  cupS: { name: 'Стакан 0,3', unit: 'шт', quantity: 200, costPerUnit: 3000, minLevel: 50, aliases: ['стакан 300', 'стакан 300 мл', 'стаканы 0 3', 'стакан 0 3 л'] },
  cupM: { name: 'Стакан 0,4', unit: 'шт', quantity: 150, costPerUnit: 3500, minLevel: 50, aliases: ['стакан 400', 'стакан 400 мл', 'стаканы 0 4', 'стакан 0 4 л'] },
  cupL: { name: 'Стакан 0,5', unit: 'шт', quantity: 100, costPerUnit: 4000, minLevel: 30, aliases: ['стакан 500', 'стакан 500 мл', 'стаканы 0 5', 'стакан 0 5 л'] },
  cocoa: { name: 'Какао-порошок', unit: 'г', quantity: 500, costPerUnit: 800, minLevel: 200, aliases: ['какао', 'какао порошок'], onDemand: true },
};

interface SampleLine {
  key: Key;
  quantity: number;
}

interface SampleOption {
  role: SampleChoiceRole;
  mode: RecipeOptionLine['mode'];
  key: Key;
  replaces?: Key;
  quantity: number;
}

interface SampleRecipe {
  items: SampleLine[];
  options: SampleOption[];
}

// Options every coffee shares: syrups +20 мл, an extra shot +9 г of coffee.
const EXTRAS: SampleOption[] = [
  { role: 'caramel', mode: 'add', key: 'caramel', quantity: 20 },
  { role: 'vanilla', mode: 'add', key: 'vanilla', quantity: 20 },
  { role: 'nut', mode: 'add', key: 'nut', quantity: 20 },
  { role: 'extra-shot', mode: 'add', key: 'coffee', quantity: 9 },
];
// A bigger size takes a bigger cup: the 0,3 cup of the base recipe is swapped.
const CUPS: SampleOption[] = [
  { role: 'm', mode: 'swap', key: 'cupM', replaces: 'cupS', quantity: 0 },
  { role: 'l', mode: 'swap', key: 'cupL', replaces: 'cupS', quantity: 0 },
];

/** A milk drink: coffee, milk per size S / M / L (cups 0,3 / 0,4 / 0,5), «Овсяное» swaps the milk. */
function milkDrink(coffee: number, [s, m, l]: [number, number, number], extra: SampleLine[] = []): SampleRecipe {
  return {
    items: [
      ...(coffee > 0 ? [{ key: 'coffee' as const, quantity: coffee }] : []),
      { key: 'milk', quantity: s },
      ...extra,
      { key: 'cupS', quantity: 1 },
    ],
    options: [
      { role: 'm', mode: 'set', key: 'milk', quantity: m },
      { role: 'l', mode: 'set', key: 'milk', quantity: l },
      ...CUPS,
      // «Овсяное»: the milk of the chosen size becomes oat milk.
      { role: 'oat', mode: 'swap', key: 'oat', replaces: 'milk', quantity: 0 },
      ...(coffee > 0 ? EXTRAS : EXTRAS.filter((e) => e.role !== 'extra-shot')),
    ],
  };
}

const RECIPES: Record<SampleDrink, SampleRecipe> = {
  espresso: {
    items: [{ key: 'coffee', quantity: 9 }],
    options: [
      { role: 'm', mode: 'set', key: 'coffee', quantity: 18 },
      { role: 'l', mode: 'set', key: 'coffee', quantity: 27 },
      ...EXTRAS,
    ],
  },
  americano: {
    items: [
      { key: 'coffee', quantity: 18 },
      { key: 'cupS', quantity: 1 },
    ],
    options: [
      ...CUPS,
      { role: 'regular', mode: 'add', key: 'milk', quantity: 30 },
      { role: 'oat', mode: 'add', key: 'oat', quantity: 30 },
      ...EXTRAS,
    ],
  },
  cappuccino: milkDrink(18, [150, 200, 280]),
  latte: milkDrink(18, [200, 270, 350]),
  raf: milkDrink(18, [150, 210, 280], [{ key: 'sugar', quantity: 10 }]),
  'flat-white': milkDrink(18, [120, 160, 220]),
  mocha: milkDrink(18, [150, 200, 280], [{ key: 'cocoa', quantity: 15 }]),
  cocoa: milkDrink(0, [200, 270, 350], [
    { key: 'cocoa', quantity: 25 },
    { key: 'sugar', quantity: 10 },
  ]),
};

export interface SampleStockResult {
  ingredients: number;
  recipes: number;
}

/** GET /api/stock/sample/fill: what «Заполнить примером» would add. */
export interface SampleStockPreview {
  /** Raw materials it would add (the rest the coffee shop has already). */
  ingredients: number;
  /** Products without a recipe that a sample drink fits, in menu order. */
  products: Array<{ productId: string; name: string; sample: string }>;
}

/** Active products without a recipe that a sample drink fits, in menu order. */
function candidates(hub: Hub): Array<{ product: ProductView; drink: SampleDrink }> {
  const withRecipe = new Set(hub.stock.recipes().recipes.map((r) => r.productId));
  const out: Array<{ product: ProductView; drink: SampleDrink }> = [];
  for (const product of hub.bar.catalog().products) {
    if (!product.isActive || withRecipe.has(product.id)) continue;
    const drink = matchSampleDrink(product.name);
    if (drink) out.push({ product, drink });
  }
  return out;
}

/** The whole sample set: every everyday raw material, plus what the drinks being filled need. */
function neededKeys(drinks: readonly SampleDrink[]): Key[] {
  const keys = new Set<Key>();
  for (const [key, ing] of Object.entries(INGREDIENTS) as Array<[Key, SampleIngredient]>) if (!ing.onDemand) keys.add(key);
  for (const d of drinks) {
    const r = RECIPES[d];
    for (const l of r.items) keys.add(l.key);
    for (const o of r.options) keys.add(o.key);
  }
  return [...keys];
}

/** Raw materials a recipe takes on this product: its base lines and the options the product has. */
function keysFor(recipe: SampleRecipe, roles: ReadonlyMap<SampleChoiceRole, string>): Key[] {
  const keys = recipe.items.map((l) => l.key);
  for (const o of recipe.options) if (roles.has(o.role)) keys.push(o.key);
  return keys;
}

export function previewSampleStock(hub: Hub): SampleStockPreview {
  const list = candidates(hub);
  const existing = hub.stock.ingredients().ingredients;
  const ingredients = neededKeys(list.map((c) => c.drink)).filter((k) => findIngredient(existing, INGREDIENTS[k]) === null).length;
  return {
    ingredients,
    products: list.map((c) => ({ productId: c.product.id, name: c.product.name, sample: SAMPLE_DRINK_LABEL[c.drink] })),
  };
}

/**
 * Adds the sample raw materials the coffee shop does not have yet and recipes for the products
 * without one that a sample drink fits, all marked as the example. `productIds` limits the recipes
 * to those products (and, when the stock has raw materials already, the new ones to what they take).
 */
export function seedSampleStock(hub: Hub, actor: string, options: { productIds?: readonly string[] } = {}): SampleStockResult {
  return transaction(hub.db, () => {
    const result: SampleStockResult = { ingredients: 0, recipes: 0 };
    let list = candidates(hub);
    if (options.productIds) {
      const known = new Set(hub.bar.catalog().products.map((p) => p.id));
      for (const id of options.productIds) if (!known.has(id)) throw new HubError(404, 'PRODUCT_NOT_FOUND', 'Товар не найден');
      const wanted = new Set(options.productIds);
      list = list.filter((c) => wanted.has(c.product.id));
    }
    const existing = hub.stock.ingredients().ingredients;
    // An empty stock gets the whole sample set; otherwise only what the filled recipes take.
    const keys =
      options.productIds && existing.some((i) => !i.isArchived)
        ? [...new Set(list.flatMap((c) => keysFor(RECIPES[c.drink], sampleChoiceRoles(c.product.options ?? []))))]
        : neededKeys(list.map((c) => c.drink));
    const id = new Map<Key, string | null>();
    for (const key of keys) {
      const ing = INGREDIENTS[key];
      const found = findIngredient(existing, ing);
      if (found && 'id' in found) id.set(key, found.id);
      else if (found) id.set(key, null); // the name is taken by a raw material in another unit
      else {
        const { name, unit, quantity, costPerUnit, minLevel } = ing;
        id.set(key, hub.stock.createIngredient({ name, unit, quantity, costPerUnit, minLevel, actor, sample: true }).id);
        result.ingredients++;
      }
    }

    for (const { product, drink } of list) {
      const recipe = RECIPES[drink];
      const roles = sampleChoiceRoles(product.options ?? []);
      const items: RecipeLine[] = [];
      let missing = false;
      for (const l of recipe.items) {
        const ingredientId = id.get(l.key);
        if (!ingredientId) {
          missing = true;
          break;
        }
        items.push({ ingredientId, quantity: l.quantity });
      }
      if (missing) continue;
      const lines: RecipeOptionLine[] = [];
      for (const o of recipe.options) {
        const choiceId = roles.get(o.role);
        const ingredientId = id.get(o.key);
        const replacesId = o.replaces ? id.get(o.replaces) : undefined;
        if (!choiceId || !ingredientId || replacesId === null) continue;
        // A swap of something the base recipe does not have (no cup in an espresso) changes nothing.
        if (o.mode === 'swap' && !items.some((i) => i.ingredientId === replacesId)) continue;
        lines.push({ choiceId, mode: o.mode, ingredientId, quantity: o.quantity, ...(o.mode === 'swap' ? { replacesId: replacesId! } : {}) });
      }
      hub.stock.setRecipe({ productId: product.id, items, options: lines, actor, sample: true });
      result.recipes++;
    }
    return result;
  });
}
