import type { IngredientUnit, Recipe, RecipeOptionLine } from '@bills/domain';
import { transaction } from './db.ts';
import type { Hub } from './hub.ts';

/**
 * Sample raw materials and recipes for the sample coffee menu (seed.ts CAFE_MENU, template
 * 'menu-cafe'): the browser trial calls it, so a new coffee shop sees «Склад» working at once —
 * sell a latte and the milk goes down by its граммовка. Ingredients that exist by name and
 * products that already have a recipe are left alone, so a second call adds nothing.
 */

type SampleIngredient = [name: string, unit: IngredientUnit, quantity: number, costPerUnit: number, minLevel: number];

/** Cost per one unit in minor units: coffee 12 000 ₸/кг = 12 ₸/г = 1200. */
const INGREDIENTS: SampleIngredient[] = [
  ['Кофе в зёрнах', 'г', 3000, 1200, 1000],
  ['Молоко 3,2%', 'мл', 12000, 60, 4000],
  ['Овсяное молоко', 'мл', 3000, 180, 1000],
  ['Сахар', 'г', 2000, 60, 500],
  ['Сироп карамельный', 'мл', 1000, 400, 200],
  ['Сироп ванильный', 'мл', 1000, 400, 200],
  ['Сироп ореховый', 'мл', 1000, 400, 200],
  ['Стакан 0,3', 'шт', 200, 3000, 50],
  ['Стакан 0,4', 'шт', 150, 3500, 50],
  ['Стакан 0,5', 'шт', 100, 4000, 30],
];

/** Milk per size S / M / L (cups 0,3 / 0,4 / 0,5). */
type MilkDrink = [product: string, coffee: number, milk: [number, number, number], sugar?: number];

const MILK_DRINKS: MilkDrink[] = [
  ['Капучино', 18, [150, 200, 280]],
  ['Латте', 18, [200, 270, 350]],
  ['Раф', 18, [150, 210, 280], 10],
  ['Флэт уайт', 18, [120, 160, 220]],
];

export interface SampleStockResult {
  ingredients: number;
  recipes: number;
}

export function seedSampleStock(hub: Hub, actor: string): SampleStockResult {
  return transaction(hub.db, () => {
    const result: SampleStockResult = { ingredients: 0, recipes: 0 };
    const existing = hub.stock.ingredients().ingredients.filter((i) => !i.isArchived);
    const id = new Map(existing.map((i) => [i.name, i.id]));
    for (const [name, unit, quantity, costPerUnit, minLevel] of INGREDIENTS) {
      if (id.has(name)) continue;
      id.set(name, hub.stock.createIngredient({ name, unit, quantity, costPerUnit, minLevel, actor, sample: true }).id);
      result.ingredients++;
    }
    const ing = (name: string) => id.get(name)!;
    const coffee = ing('Кофе в зёрнах');
    const milk = ing('Молоко 3,2%');
    const oat = ing('Овсяное молоко');
    const cup = { s: ing('Стакан 0,3'), m: ing('Стакан 0,4'), l: ing('Стакан 0,5') };

    // Options every coffee shares: syrups +20 мл, an extra shot +9 г of coffee.
    const extras: RecipeOptionLine[] = [
      { choiceId: 'caramel', mode: 'add', ingredientId: ing('Сироп карамельный'), quantity: 20 },
      { choiceId: 'vanilla', mode: 'add', ingredientId: ing('Сироп ванильный'), quantity: 20 },
      { choiceId: 'nut', mode: 'add', ingredientId: ing('Сироп ореховый'), quantity: 20 },
      { choiceId: 'extra-shot', mode: 'add', ingredientId: coffee, quantity: 9 },
    ];
    // A bigger size takes a bigger cup: the 0,3 cup of the base recipe is swapped.
    const cups: RecipeOptionLine[] = [
      { choiceId: 'm', mode: 'swap', ingredientId: cup.m, replacesId: cup.s, quantity: 0 },
      { choiceId: 'l', mode: 'swap', ingredientId: cup.l, replacesId: cup.s, quantity: 0 },
    ];

    const recipes = new Map<string, Recipe>();
    recipes.set('Эспрессо', {
      items: [{ ingredientId: coffee, quantity: 9 }],
      options: [
        { choiceId: 'm', mode: 'set', ingredientId: coffee, quantity: 18 },
        { choiceId: 'l', mode: 'set', ingredientId: coffee, quantity: 27 },
        ...extras,
      ],
    });
    recipes.set('Американо', {
      items: [
        { ingredientId: coffee, quantity: 18 },
        { ingredientId: cup.s, quantity: 1 },
      ],
      options: [
        ...cups,
        { choiceId: 'regular', mode: 'add', ingredientId: milk, quantity: 30 },
        { choiceId: 'oat', mode: 'add', ingredientId: oat, quantity: 30 },
        ...extras,
      ],
    });
    for (const [product, grams, [s, m, l], sugar] of MILK_DRINKS) {
      recipes.set(product, {
        items: [
          { ingredientId: coffee, quantity: grams },
          { ingredientId: milk, quantity: s },
          ...(sugar ? [{ ingredientId: ing('Сахар'), quantity: sugar }] : []),
          { ingredientId: cup.s, quantity: 1 },
        ],
        options: [
          { choiceId: 'm', mode: 'set', ingredientId: milk, quantity: m },
          { choiceId: 'l', mode: 'set', ingredientId: milk, quantity: l },
          ...cups,
          // «Овсяное»: the milk of the chosen size becomes oat milk.
          { choiceId: 'oat', mode: 'swap', ingredientId: oat, replacesId: milk, quantity: 0 },
          ...extras,
        ],
      });
    }

    const catalog = hub.bar.catalog();
    const withRecipe = new Set(hub.stock.recipes().recipes.map((r) => r.productId));
    for (const [name, recipe] of recipes) {
      const product = catalog.products.find((p) => p.name === name && p.isActive);
      if (!product || withRecipe.has(product.id)) continue;
      const choices = new Set(product.options.flatMap((g) => g.choices.map((c) => c.id)));
      hub.stock.setRecipe({
        productId: product.id,
        items: recipe.items,
        options: recipe.options.filter((o) => choices.has(o.choiceId)),
        sample: true,
        actor,
      });
      result.recipes++;
    }
    return result;
  });
}
