import { randomUUID } from 'node:crypto';
import type { TariffConfig } from '@bills/domain';
import { validateTariff } from '@bills/domain';
import type { Db } from './db.ts';
import { one, run, transaction } from './db.ts';

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

/** Creates a demo company, club, tariffs and six tables when the database is empty. */
export function seedDemo(db: Db, now: number, timezone = 'Asia/Almaty'): boolean {
  return transaction(db, () => {
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
  });
}
