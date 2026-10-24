import { randomUUID } from 'node:crypto';
import type { BusinessType, ProductOptionGroup, Role, TariffConfig } from '@bills/domain';
import { primaryRole, validateTariff } from '@bills/domain';
import { scopeOf } from './auth.ts';
import type { Db } from './db.ts';
import { all, one, run, transaction } from './db.ts';
import { hashPin } from './staff.ts';

export const STANDARD: TariffConfig = {
  currency: 'KZT',
  basePricePerHour: 2000_00,
  windows: [
    { label: 'Вечер', days: [1, 2, 3, 4, 5], from: '18:00', to: '02:00', pricePerHour: 3000_00 },
    { label: 'Выходные', days: [6, 7], from: '00:00', to: '24:00', pricePerHour: 3500_00 },
  ],
  stepMinutes: 1,
  minimumMinutes: 30,
  freeMinutes: 3,
  roundingMinor: 10_00,
};

export const SNOOKER: TariffConfig = {
  ...STANDARD,
  basePricePerHour: 4000_00,
  windows: [
    { label: 'Вечер', days: [1, 2, 3, 4, 5], from: '18:00', to: '02:00', pricePerHour: 5000_00 },
    { label: 'Выходные', days: [6, 7], from: '00:00', to: '24:00', pricePerHour: 5500_00 },
  ],
};

/**
 * Demo staff: PIN 1234 for everyone (demo only). The platform (owner, tech) is
 * not seeded: it comes from the cloud, or as the installer on first start; the
 * public demo adds the people of DEMO_KEYS (AuthService.issueFixedKeys).
 */
const DEMO_STAFF: Array<[name: string, roles: Role[]]> = [
  ['Марат Управляющий', ['manager']],
  ['Асель Администратор', ['admin']],
  ['Айгерим Кассир', ['cashier']],
  ['Данияр Официант', ['waiter']],
];

export const DEMO_MENU: Array<[category: string, products: Array<[name: string, priceMinor: number]>]> = [
  [
    'Напитки',
    [
      ['Кола 0,5', 600_00],
      ['Вода 0,5', 300_00],
      ['Чай', 500_00],
      ['Кофе американо', 800_00],
      ['Пиво разливное 0,5', 1200_00],
    ],
  ],
  [
    'Снеки',
    [
      ['Чипсы', 700_00],
      ['Орешки', 600_00],
      ['Сухарики', 400_00],
    ],
  ],
  [
    'Аренда',
    [
      ['Мел', 200_00],
      ['Перчатка', 500_00],
    ],
  ],
];

// ── Coffee shop demo (HUB_DEMO_BUSINESS=cafe) ───────────────────────────────

const SIZE: ProductOptionGroup = {
  id: 'size',
  name: 'Размер',
  required: true,
  multiple: false,
  choices: [
    { id: 's', name: 'S', priceDelta: 0 },
    { id: 'm', name: 'M', priceDelta: 200_00 },
    { id: 'l', name: 'L', priceDelta: 400_00 },
  ],
};
const MILK: ProductOptionGroup = {
  id: 'milk',
  name: 'Молоко',
  required: false,
  multiple: false,
  choices: [
    { id: 'regular', name: 'Обычное', priceDelta: 0 },
    { id: 'oat', name: 'Овсяное', priceDelta: 300_00 },
    { id: 'almond', name: 'Миндальное', priceDelta: 300_00 },
    { id: 'lactose-free', name: 'Безлактозное', priceDelta: 200_00 },
  ],
};
const SYRUP: ProductOptionGroup = {
  id: 'syrup',
  name: 'Сироп',
  required: false,
  multiple: true,
  choices: [
    { id: 'caramel', name: 'Карамель', priceDelta: 200_00 },
    { id: 'vanilla', name: 'Ваниль', priceDelta: 200_00 },
    { id: 'nut', name: 'Орех', priceDelta: 200_00 },
  ],
};
const SHOT: ProductOptionGroup = {
  id: 'shot',
  name: 'Доп. шот',
  required: false,
  multiple: false,
  choices: [{ id: 'extra-shot', name: 'Доп. шот эспрессо', priceDelta: 300_00 }],
};
const MILK_COFFEE = [SIZE, MILK, SYRUP, SHOT];

export type CafeProduct = [name: string, priceMinor: number, options: ProductOptionGroup[], stock: number | null];

export const CAFE_MENU: Array<[category: string, products: CafeProduct[]]> = [
  [
    'Кофе',
    [
      // Espresso has no milk; the other coffees take every option.
      ['Эспрессо', 800_00, [SIZE, SYRUP, SHOT], null],
      ['Американо', 900_00, MILK_COFFEE, null],
      ['Капучино', 1200_00, MILK_COFFEE, null],
      ['Латте', 1300_00, MILK_COFFEE, null],
      ['Раф', 1500_00, MILK_COFFEE, null],
      ['Флэт уайт', 1400_00, MILK_COFFEE, null],
    ],
  ],
  [
    'Чай',
    [
      ['Чёрный', 700_00, [], null],
      ['Зелёный', 700_00, [], null],
      ['Матча-латте', 1600_00, [SIZE, MILK], null],
    ],
  ],
  [
    'Еда',
    [
      // Baked goods are counted: the counter shows «нет в наличии» when they run out.
      ['Круассан', 900_00, [], 12],
      ['Сэндвич с курицей', 1800_00, [], 8],
      ['Чизкейк', 1500_00, [], 6],
      ['Печенье', 500_00, [], 20],
    ],
  ],
];

const CAFE_STAFF: Array<[name: string, roles: Role[]]> = [
  ['Марат Управляющий', ['manager']],
  ['Асель Администратор', ['admin']],
  ['Айгерим Кассир', ['cashier']],
  ['Данияр Бариста', ['bartender']],
];

/**
 * Creates a demo company, club, tariffs and six tables when the database is
 * empty, then demo staff and a bar menu when their tables are empty — so a
 * club seeded by an older HUB gets them on upgrade too.
 *
 * `business: 'cafe'` (HUB_DEMO_BUSINESS=cafe) seeds a coffee shop instead: the club
 * set to `business.type = cafe`, no tables or tariffs, a barista, and a menu of
 * coffee with options (size, milk, syrup, extra shot), tea and baked goods.
 * The choice matters only for an empty database.
 */
export function seedDemo(db: Db, now: number, timezone = 'Asia/Almaty', business: BusinessType = 'billiards'): boolean {
  return transaction(db, () => {
    const created = business === 'cafe' ? seedCafeClub(db, now, timezone) : seedClub(db, now, timezone);
    const club = one<{ id: string; settings: string | null }>(db, 'SELECT id, settings FROM clubs ORDER BY created_at LIMIT 1');
    if (club) {
      const cafe = isCafe(club.settings);
      seedStaff(db, now, club.id, cafe ? CAFE_STAFF : DEMO_STAFF);
      if (cafe) seedCafeMenu(db, now, club.id);
      else seedMenu(db, now, club.id);
    }
    return created;
  });
}

/** Name of the club a real HUB creates on an empty database, until the cabinet sends the real one. */
export const NEW_CLUB_NAME = 'Моё заведение';

/**
 * A real club's first start: one company and one club row the HUB needs to run — named
 * «Моё заведение», in `timezone`, KZT — and nothing else: no tables, tariffs, menu or people.
 * The cabinet fills in the name, the business type and the staff once the HUB is connected;
 * nobody sees fake demo data. Returns true when the club was created (the database was empty).
 */
export function seedEmptyClub(db: Db, now: number, timezone = 'Asia/Almaty'): boolean {
  return transaction(db, () => {
    if (one(db, 'SELECT id FROM companies LIMIT 1')) return false;
    const companyId = randomUUID();
    run(db, 'INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', companyId, NEW_CLUB_NAME, now);
    run(
      db,
      'INSERT INTO clubs (id, company_id, name, timezone, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      randomUUID(),
      companyId,
      NEW_CLUB_NAME,
      timezone,
      'KZT',
      now,
    );
    return true;
  });
}

/**
 * What main.ts does with the database on start. A demo HUB (HUB_DEMO=1) gets the demo club
 * (`seedDemo`) and, when it was just created, a key for every demo employee; a real HUB gets
 * only an empty club (`seedEmptyClub`) — its single starting key is the support (TECH) key that
 * `AuthService.bootstrapKeys` writes to first-run-keys.txt. Returns whether every active person
 * should get a starting key.
 */
export function prepareClub(
  db: Db,
  now: number,
  options: { demo: boolean; timezone?: string; business?: BusinessType },
): { created: boolean; keyEveryone: boolean } {
  if (options.demo) {
    const created = seedDemo(db, now, options.timezone, options.business);
    return { created, keyEveryone: created };
  }
  return { created: seedEmptyClub(db, now, options.timezone), keyEveryone: false };
}

function isCafe(settings: string | null): boolean {
  try {
    return (JSON.parse(settings ?? '{}') as { business?: { type?: unknown } }).business?.type === 'cafe';
  } catch {
    return false;
  }
}

function seedCafeClub(db: Db, now: number, timezone: string): boolean {
  if (one(db, 'SELECT id FROM companies LIMIT 1')) return false;
  const companyId = randomUUID();
  run(db, 'INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', companyId, 'Демо компания', now);
  run(
    db,
    'INSERT INTO clubs (id, company_id, name, timezone, currency, created_at, settings) VALUES (?, ?, ?, ?, ?, ?, ?)',
    randomUUID(),
    companyId,
    'Кофейня «Демо»',
    timezone,
    'KZT',
    now,
    JSON.stringify({ business: { type: 'cafe' } }),
  );
  return true;
}

function seedCafeMenu(db: Db, now: number, clubId: string): void {
  if (one(db, 'SELECT id FROM product_categories LIMIT 1')) return;
  CAFE_MENU.forEach(([category, products], ci) => {
    const categoryId = randomUUID();
    run(
      db,
      `INSERT INTO product_categories (id, club_id, name, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      categoryId,
      clubId,
      category,
      ci + 1,
      now,
      now,
    );
    products.forEach(([name, price, options, stock], pi) => {
      run(
        db,
        `INSERT INTO products (id, club_id, category_id, name, price, is_active, stock, sort_order, created_at, updated_at, options)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        randomUUID(),
        clubId,
        categoryId,
        name,
        price,
        stock,
        pi + 1,
        now,
        now,
        JSON.stringify(options),
      );
    });
  });
}

function seedClub(db: Db, now: number, timezone: string): boolean {
  if (one(db, 'SELECT id FROM companies LIMIT 1')) return false;

  const companyId = randomUUID();
  const clubId = randomUUID();
  run(db, 'INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', companyId, 'Демо компания', now);
  run(
    db,
    'INSERT INTO clubs (id, company_id, name, timezone, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    clubId,
    companyId,
    'Клуб «Демо»',
    timezone,
    'KZT',
    now,
  );

  const tariffIds: Record<string, string> = {};
  for (const [name, config] of [
    ['Стандарт', STANDARD],
    ['Снукер', SNOOKER],
  ] as const) {
    const errors = validateTariff(config, timezone);
    if (errors.length) throw new Error(`Demo tariff ${name} is invalid: ${errors.join('; ')}`);
    const id = randomUUID();
    tariffIds[name] = id;
    run(
      db,
      'INSERT INTO tariffs (id, club_id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      clubId,
      name,
      JSON.stringify(config),
      now,
      now,
    );
  }

  const tables = [
    ['Стол 1', 'pool', 'Стандарт'],
    ['Стол 2', 'pool', 'Стандарт'],
    ['Стол 3', 'pool', 'Стандарт'],
    ['Стол 4', 'russian', 'Стандарт'],
    ['Стол 5', 'russian', 'Стандарт'],
    ['Снукер', 'snooker', 'Снукер'],
  ] as const;
  tables.forEach(([name, kind, tariff], i) => {
    run(
      db,
      `INSERT INTO billiard_tables (id, club_id, name, kind, lamp_channel, default_tariff_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      clubId,
      name,
      kind,
      `relay-${i + 1}`,
      tariffIds[tariff] ?? '',
      i + 1,
    );
  });
  return true;
}

function seedStaff(db: Db, now: number, clubId: string, people: Array<[name: string, roles: Role[]]>): void {
  if (one(db, 'SELECT id FROM staff LIMIT 1')) return;
  const tables = all<{ id: string }>(db, 'SELECT id FROM billiard_tables WHERE club_id = ? ORDER BY sort_order', clubId);
  for (const [name, roles] of people) {
    const tableIds = roles.includes('waiter') ? tables.slice(0, 3).map((t) => t.id) : [];
    run(
      db,
      `INSERT INTO staff (id, club_id, name, role, roles, origin, scope, pin_hash, is_active, table_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'hub', ?, ?, 1, ?, ?, ?)`,
      randomUUID(),
      clubId,
      name,
      primaryRole(roles)!,
      JSON.stringify(roles),
      scopeOf(roles),
      hashPin('1234'),
      JSON.stringify(tableIds),
      now,
      now,
    );
  }
}

function seedMenu(db: Db, now: number, clubId: string): void {
  if (one(db, 'SELECT id FROM product_categories LIMIT 1')) return;
  DEMO_MENU.forEach(([category, products], ci) => {
    const categoryId = randomUUID();
    run(
      db,
      `INSERT INTO product_categories (id, club_id, name, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      categoryId,
      clubId,
      category,
      ci + 1,
      now,
      now,
    );
    products.forEach(([name, price], pi) => {
      run(
        db,
        `INSERT INTO products (id, club_id, category_id, name, price, is_active, stock, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)`,
        randomUUID(),
        clubId,
        categoryId,
        name,
        price,
        pi + 1,
        now,
        now,
      );
    });
  });
}
