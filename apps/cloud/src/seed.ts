import { randomUUID } from 'node:crypto';
import type { TableSetting, TariffConfig, TariffSetting } from '@bills/domain';
import { validateTariff } from '@bills/domain';
import { hashApiKey, hashPassword } from './auth.ts';
import type { SqlDriver } from './db/driver.ts';
import { saveSettings } from './settings.ts';

// Same demo tariffs as apps/hub/src/seed.ts.
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

export const DEMO_OWNER = { email: 'owner@demo.kz', password: 'demo1234', name: 'Владелец' };

export const DEMO_HUBS = [
  { id: 'hub-demo-1', key: 'demo-hub-key-1', club: 'Клуб «Демо»' },
  { id: 'hub-demo-2', key: 'demo-hub-key-2', club: 'Клуб «Север»' },
] as const;

function demoTariffs(): TariffSetting[] {
  return [
    { id: randomUUID(), name: 'Стандарт', config: STANDARD, isActive: true },
    { id: randomUUID(), name: 'Снукер', config: SNOOKER, isActive: true },
  ];
}

function demoTables(tariffs: TariffSetting[]): TableSetting[] {
  const byName = new Map(tariffs.map((t) => [t.name, t.id]));
  const rows = [
    ['Стол 1', 'pool', 'Стандарт'],
    ['Стол 2', 'pool', 'Стандарт'],
    ['Стол 3', 'pool', 'Стандарт'],
    ['Стол 4', 'russian', 'Стандарт'],
    ['Стол 5', 'russian', 'Стандарт'],
    ['Снукер', 'snooker', 'Снукер'],
  ] as const;
  return rows.map(([name, kind, tariff], i) => ({
    id: randomUUID(),
    name,
    kind,
    lampChannel: `relay-${i + 1}`,
    defaultTariffId: byName.get(tariff) ?? '',
    sortOrder: i + 1,
    isActive: true,
  }));
}

/**
 * Creates the demo company, its owner, two clubs and one HUB per club with
 * fixed API keys — only when the database has no companies at all.
 */
export async function seedDemo(
  db: SqlDriver,
  now: number,
  log: (message: string) => void = () => undefined,
  timezone = 'Asia/Almaty',
): Promise<boolean> {
  for (const [name, config] of [
    ['Стандарт', STANDARD],
    ['Снукер', SNOOKER],
  ] as const) {
    const errors = validateTariff(config, timezone);
    if (errors.length) throw new Error(`Demo tariff ${name} is invalid: ${errors.join('; ')}`);
  }

  return db.transaction(async (tx) => {
    const existing = await tx.all<{ id: string }>('SELECT id FROM companies LIMIT 1');
    if (existing.length) return false;

    const companyId = randomUUID();
    await tx.run('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', [companyId, 'Демо сеть', now]);
    await tx.run(
      'INSERT INTO owners (id, company_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), companyId, DEMO_OWNER.email, DEMO_OWNER.name, hashPassword(DEMO_OWNER.password), now],
    );

    for (const hub of DEMO_HUBS) {
      const clubId = randomUUID();
      await tx.run(
        'INSERT INTO clubs (id, company_id, name, timezone, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [clubId, companyId, hub.club, timezone, 'KZT', now],
      );
      await tx.run(
        `INSERT INTO hubs (id, club_id, name, api_key_hash, created_at, settings_version)
         VALUES (?, ?, ?, ?, ?, 0)`,
        [hub.id, clubId, `HUB ${hub.club}`, hashApiKey(hub.key), now],
      );
      const tariffs = demoTariffs();
      await saveSettings(
        tx,
        clubId,
        {
          version: 0,
          club: { name: hub.club, timezone, currency: 'KZT' },
          tariffs,
          tables: demoTables(tariffs),
          staff: [],
        },
        'hub',
        now,
      );
      log(`Демо-HUB ${hub.id} (${hub.club}): CLOUD_API_KEY=${hub.key}`);
    }
    log(`Демо-владелец: ${DEMO_OWNER.email} / ${DEMO_OWNER.password}`);
    return true;
  });
}
