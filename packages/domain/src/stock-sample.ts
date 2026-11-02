import type { ProductOptionGroup } from './cafe.ts';
import type { IngredientUnit } from './stock.ts';

/**
 * «Заполнить примером» on «Склад»: the sample raw materials and тех. карты (apps/hub
 * stock-sample.ts) fitted to a coffee shop's own menu. The coffee shop named its drinks and
 * options itself («Латте 0,4», «Флэт Уайт», size «Маленький / Большой», milk «На овсяном»),
 * so products and option choices are matched by name, and the coffee shop's own raw
 * materials are reused by name instead of being added a second time.
 */

/** Lower case, «ё» as «е», punctuation as spaces: «Флэт-Уайт (0,3)» → «флэт уайт 0 3». */
export function normalizeName(name: string): string {
  return name
    .toLocaleLowerCase('ru')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function hasWord(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

export const SAMPLE_DRINKS = ['espresso', 'americano', 'cappuccino', 'latte', 'raf', 'flat-white', 'mocha', 'cocoa'] as const;
export type SampleDrink = (typeof SAMPLE_DRINKS)[number];

/** How a drink is called on menus, in normalized form; a product matches when its name has one of them as words. */
const DRINK_NAMES: Record<SampleDrink, readonly string[]> = {
  'flat-white': ['флэт уайт', 'флет уайт', 'флэтуайт', 'флэт', 'flat white', 'flatwhite'],
  mocha: ['мокко', 'мокка', 'мокачино', 'мокаччино', 'mocha', 'mocca', 'mochaccino'],
  raf: ['раф', 'raf'],
  cappuccino: ['капучино', 'капуччино', 'каппучино', 'cappuccino', 'capuccino'],
  latte: ['латте', 'лате', 'latte'],
  americano: ['американо', 'americano', 'лунго', 'lungo'],
  espresso: ['эспрессо', 'экспрессо', 'espresso', 'доппио', 'doppio', 'ристретто', 'ristretto'],
  cocoa: ['какао', 'cocoa', 'горячий шоколад', 'hot chocolate'],
};

/** Not coffee, although the name says «латте»: matcha, tea, chai latte. */
const NOT_COFFEE = ['матча', 'matcha', 'чай', 'tea', 'чаи', 'chai', 'смузи', 'лимонад'];

/** The sample drink a product of the menu is, by its name; null — none fits. */
export function matchSampleDrink(productName: string): SampleDrink | null {
  const name = normalizeName(productName);
  if (!name) return null;
  const coffee = !NOT_COFFEE.some((w) => hasWord(name, w) || name.startsWith(`${w} `));
  for (const drink of SAMPLE_DRINKS_BY_PRIORITY) {
    if (drink !== 'cocoa' && !coffee) continue;
    if (DRINK_NAMES[drink].some((n) => hasWord(name, n))) return drink;
  }
  return null;
}

/** «Раф» before «латте» («Раф латте» is a raf), mocha before latte and cocoa. */
const SAMPLE_DRINKS_BY_PRIORITY: readonly SampleDrink[] = [
  'flat-white',
  'mocha',
  'raf',
  'cappuccino',
  'latte',
  'americano',
  'espresso',
  'cocoa',
];

export const SAMPLE_DRINK_LABEL: Record<SampleDrink, string> = {
  espresso: 'Эспрессо',
  americano: 'Американо',
  cappuccino: 'Капучино',
  latte: 'Латте',
  raf: 'Раф',
  'flat-white': 'Флэт уайт',
  mocha: 'Мокко',
  cocoa: 'Какао',
};

// ── Option choices ──────────────────────────────────────────────────────────

/**
 * What an option choice means for the sample recipe: a bigger size (m, l), a kind of milk,
 * a syrup, an extra shot. The sample recipes are written with these; `sampleChoiceRoles`
 * finds the product's own choice for each.
 */
export const SAMPLE_CHOICE_ROLES = ['m', 'l', 'regular', 'oat', 'caramel', 'vanilla', 'nut', 'extra-shot'] as const;
export type SampleChoiceRole = (typeof SAMPLE_CHOICE_ROLES)[number];

const SIZE_GROUP = /^(размер|объем|обьем|size|стакан|порция|объем стакана)/;

/** Order of a size choice: «S» < «M» < «L», «0,3» < «0,4», «250 мл» < «350 мл»; null — not a size. */
export function sizeRank(choiceName: string): number | null {
  const n = normalizeName(choiceName);
  const letters: Record<string, number> = { xs: 50, s: 100, m: 200, l: 300, xl: 400, xxl: 500 };
  const first = n.split(' ')[0] ?? '';
  if (first in letters) return letters[first]!;
  if (/^(маленьк|мал|small|короткий)/.test(n)) return 100;
  if (/^(средн|medium|стандарт)/.test(n)) return 200;
  if (/^(большо|больш|large|big|высокий)/.test(n)) return 300;
  if (/^(огромн|гранде|grande|венти|venti)/.test(n)) return 400;
  // «0,3» / «0.4 л» / «300 мл» / «12 oz»: litres below 5, else millilitres.
  const m = /(\d+(?:[.,]\d+)?)/.exec(choiceName);
  if (!m) return null;
  const value = Number(m[1]!.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  if (/oz|унц/.test(n)) return value * 30;
  return value < 5 ? value * 1000 : value;
}

function isSizeGroup(group: ProductOptionGroup): boolean {
  if (SIZE_GROUP.test(normalizeName(group.name))) return true;
  return group.choices.length >= 2 && group.choices.every((c) => sizeRank(c.name) !== null);
}

const ROLE_NAMES: Array<[SampleChoiceRole, RegExp]> = [
  ['oat', /овсян|oat/],
  ['regular', /обычн|коровь|regular|цельн|классическ/],
  ['caramel', /карамел|caramel/],
  ['vanilla', /ванил|vanil/],
  ['nut', /орех|фундук|миндальн(ый|ого) сироп|hazelnut|nut/],
  ['extra-shot', /шот|shot|доп(олнительный)? эспрессо|двойн|экстра кофе|\+ ?эспрессо/],
];

/**
 * The product's choice for each sample role: sizes by their order (the smallest is the base
 * recipe, the next «m», then «l»), milk and syrups by name. Roles without a choice are absent.
 */
export function sampleChoiceRoles(groups: readonly ProductOptionGroup[]): Map<SampleChoiceRole, string> {
  const roles = new Map<SampleChoiceRole, string>();
  const size = groups.find(isSizeGroup);
  if (size) {
    const ranked = size.choices
      .map((c, i) => ({ id: c.id, rank: sizeRank(c.name) ?? (i + 1) * 100, i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);
    if (ranked[1]) roles.set('m', ranked[1].id);
    if (ranked[2]) roles.set('l', ranked[2].id);
  }
  for (const group of groups) {
    if (group === size) continue;
    for (const choice of group.choices) {
      const name = normalizeName(`${group.name} ${choice.name}`);
      const own = normalizeName(choice.name);
      for (const [role, re] of ROLE_NAMES) {
        if (roles.has(role)) continue;
        // Milk is told by the choice («Овсяное»); a syrup by the choice or its group («Сироп: Карамель»).
        if (re.test(role === 'oat' || role === 'regular' ? own : name)) {
          roles.set(role, choice.id);
          break;
        }
      }
    }
  }
  return roles;
}

// ── Raw materials ───────────────────────────────────────────────────────────

/**
 * Whether the coffee shop already has a sample raw material under another name: same unit,
 * and the name (normalized) is the sample's or one of its usual names. Returns its id.
 */
export function findIngredient(
  existing: ReadonlyArray<{ id: string; name: string; unit: IngredientUnit; isArchived?: boolean }>,
  sample: { name: string; unit: IngredientUnit; aliases?: readonly string[] },
): { id: string } | { clash: true } | null {
  const wanted = new Set([sample.name, ...(sample.aliases ?? [])].map(normalizeName));
  const active = existing.filter((i) => !i.isArchived);
  const same = active.find((i) => normalizeName(i.name) === normalizeName(sample.name));
  if (same) return same.unit === sample.unit ? { id: same.id } : { clash: true };
  const alias = active.find((i) => i.unit === sample.unit && wanted.has(normalizeName(i.name)));
  return alias ? { id: alias.id } : null;
}
