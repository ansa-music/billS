import { randomUUID } from 'node:crypto';
import type { LicensePayload, TableSetting, TariffConfig, TariffSetting } from '@bills/domain';
import type { Role } from '@bills/domain';
import { keyPrefixOf, shortKeyHashInput, validateTariff } from '@bills/domain';
import { addPlatformStaff, issueManagerKey } from './access.ts';
import { hashApiKey, hashPassword } from './auth.ts';
import type { SqlDriver } from './db/driver.ts';
import type { LicenseSigner } from './license.ts';
import { DEV_SIGNER, storeLicense } from './license.ts';
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

/** The demo client's manager (an `owners` row): cabinet e-mail + password, and DEMO_MANAGER_KEY for the HUBs. */
export const DEMO_OWNER = { email: 'owner@demo.kz', password: 'demo1234', name: 'Владелец' };

/** Platform keys of the demo cloud: the owner of TS and support. */
export const DEMO_PLATFORM = [
  { name: 'Владелец TS', role: 'owner', key: 'OWNER-2222-2222-2222-2222' },
  { name: 'Поддержка TS', role: 'tech', key: 'TECH-7777-7777-7777-7777' },
] as const;
export const DEMO_MANAGER_KEY = 'MGR-3333-3333-3333-3333';

/** Demo staff of the first demo club with fixed six-digit keys (the cloud's short keys are 6 digits). */
export const DEMO_CLUB_STAFF: ReadonlyArray<{ name: string; roles: readonly Role[]; key: string }> = [
  { name: 'Старший смены', roles: ['senior'], key: '260417' },
  { name: 'Кассир', roles: ['cashier'], key: '318540' },
  { name: 'Официант', roles: ['waiter'], key: '527193' },
  { name: 'Официант-кассир', roles: ['cashier', 'waiter'], key: '640285' },
];

/** access_version of the demo company right after the seed: one per platform person, the MGR key, the license. */
export const DEMO_ACCESS_VERSION = DEMO_PLATFORM.length + 2;

/** Demo license: a 7-day trial, two branches, every module. */
export const DEMO_LICENSE_DAYS = 7;

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
 * Creates the demo company, its manager, two clubs and one HUB per club with
 * fixed API keys — only when the database has no companies at all. Also the platform
 * (OWNER-…/TECH-… of DEMO_PLATFORM), the manager's MGR-… key, a license signed with `signer`
 * (the dev key by default) and the demo staff (short keys) of the first club.
 * Writes only, after the first check: scripts/supabase-sql.ts prints it as SQL.
 */
export async function seedDemo(
  db: SqlDriver,
  now: number,
  log: (message: string) => void = () => undefined,
  timezone = 'Asia/Almaty',
  signer: LicenseSigner = DEV_SIGNER,
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
    const ownerId = randomUUID();
    await tx.run('INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)', [companyId, 'Демо сеть', now]);
    await tx.run(
      'INSERT INTO owners (id, company_id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ownerId, companyId, DEMO_OWNER.email, DEMO_OWNER.name, hashPassword(DEMO_OWNER.password), now],
    );

    const clubIds: string[] = [];
    for (const hub of DEMO_HUBS) {
      const clubId = randomUUID();
      clubIds.push(clubId);
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

    // The platform with the demo keys.
    for (const p of DEMO_PLATFORM) await addPlatformStaff(tx, now, { name: p.name, role: p.role, key: p.key });
    await issueManagerKey(tx, now, ownerId, companyId, { key: DEMO_MANAGER_KEY, label: 'Демо' });

    const payload: LicensePayload = {
      v: 1,
      id: randomUUID(),
      companyId,
      companyName: 'Демо сеть',
      plan: 'trial',
      issuedAt: now,
      validFrom: now,
      validUntil: now + DEMO_LICENSE_DAYS * 86_400_000,
      maxClubs: 2,
      maxTables: null,
      maxStaff: null,
      modules: { bar: true, cloud: true, hardware: true },
      hubIds: DEMO_HUBS.map((h) => h.id),
      blocked: false,
    };
    await storeLicense(tx, signer, payload, null);

    // Demo staff of the first club.
    const firstClub = clubIds[0]!;
    for (const demo of DEMO_CLUB_STAFF) {
      const staffId = randomUUID();
      await tx.run(
        'INSERT INTO club_staff (id, club_id, company_id, name, roles, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        [staffId, firstClub, companyId, demo.name, JSON.stringify(demo.roles), now, now],
      );
      await tx.run(
        `INSERT INTO club_keys (id, staff_id, club_id, kind, key_hash, prefix, label, created_at)
         VALUES (?, ?, ?, 'short', ?, ?, ?, ?)`,
        [randomUUID(), staffId, firstClub, hashApiKey(shortKeyHashInput(firstClub, demo.key)), keyPrefixOf(demo.key), 'Демо', now],
      );
    }

    log(`Демо-управляющий: ${DEMO_OWNER.email} / ${DEMO_OWNER.password}, ключ ${DEMO_MANAGER_KEY}`);
    log(`Демо-платформа: ${DEMO_PLATFORM.map((p) => p.key).join(', ')}`);
    return true;
  });
}
