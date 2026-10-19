import { randomUUID } from 'node:crypto';
import type { Role, TariffConfig } from '@bills/domain';
import { primaryRole, validateTariff } from '@bills/domain';
import { scopeOf } from './auth.ts';
import type { Db } from './db.ts';
import { all, one, run, transaction } from './db.ts';
import { hashPin } from './staff.ts';

const STANDARD: TariffConfig = {
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

const SNOOKER: TariffConfig = {
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

const DEMO_MENU: Array<[category: string, products: Array<[name: string, priceMinor: number]>]> = [
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

/**
 * Creates a demo company, club, tariffs and six tables when the database is
 * empty, then demo staff and a bar menu when their tables are empty — so a
 * club seeded by an older HUB gets them on upgrade too.
 */
export function seedDemo(db: Db, now: number, timezone = 'Asia/Almaty'): boolean {
  return transaction(db, () => {
    const created = seedClub(db, now, timezone);
    const clubId = one<{ id: string }>(db, 'SELECT id FROM clubs ORDER BY created_at LIMIT 1')?.id;
    if (clubId) {
      seedStaff(db, now, clubId);
      seedMenu(db, now, clubId);
    }
    return created;
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

function seedStaff(db: Db, now: number, clubId: string): void {
  if (one(db, 'SELECT id FROM staff LIMIT 1')) return;
  const tables = all<{ id: string }>(db, 'SELECT id FROM billiard_tables WHERE club_id = ? ORDER BY sort_order', clubId);
  for (const [name, roles] of DEMO_STAFF) {
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
