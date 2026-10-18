import type { ClubSnapshot, StaffSetting, TableSetting, TariffSetting } from '@bills/domain';
import type { SqlDriver } from './db/driver.ts';

export interface ClubRow {
  id: string;
  company_id: string;
  name: string;
  timezone: string;
  currency: string;
  created_at: number;
}

interface SettingsRow {
  club_id: string;
  version: number;
  club_json: string;
  tariffs_json: string;
  tables_json: string;
  staff_json: string;
  updated_at: number;
  source: 'hub' | 'owner';
}

export interface StoredSettings extends ClubSnapshot {
  source: 'hub' | 'owner' | null;
  updatedAt: number | null;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Current settings of a club; version 0 and empty lists when nothing was reported yet. */
export async function loadSettings(db: SqlDriver, club: ClubRow): Promise<StoredSettings> {
  const rows = await db.all<SettingsRow>('SELECT * FROM club_settings WHERE club_id = ?', [club.id]);
  const row = rows[0];
  if (!row) {
    return {
      version: 0,
      club: { name: club.name, timezone: club.timezone, currency: club.currency },
      tariffs: [],
      tables: [],
      staff: [],
      source: null,
      updatedAt: null,
    };
  }
  return {
    version: Number(row.version),
    club: parseJson(row.club_json, { name: club.name, timezone: club.timezone, currency: club.currency }),
    tariffs: parseJson<TariffSetting[]>(row.tariffs_json, []),
    tables: parseJson<TableSetting[]>(row.tables_json, []),
    staff: parseJson<StaffSetting[]>(row.staff_json, []),
    source: row.source,
    updatedAt: Number(row.updated_at),
  };
}

export async function saveSettings(
  db: SqlDriver,
  clubId: string,
  settings: ClubSnapshot,
  source: 'hub' | 'owner',
  now: number,
): Promise<void> {
  await db.run(
    `INSERT INTO club_settings (club_id, version, club_json, tariffs_json, tables_json, staff_json, updated_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (club_id) DO UPDATE SET
       version = excluded.version, club_json = excluded.club_json, tariffs_json = excluded.tariffs_json,
       tables_json = excluded.tables_json, staff_json = excluded.staff_json,
       updated_at = excluded.updated_at, source = excluded.source`,
    [
      clubId,
      settings.version,
      JSON.stringify(settings.club),
      JSON.stringify(settings.tariffs),
      JSON.stringify(settings.tables),
      JSON.stringify(settings.staff),
      now,
      source,
    ],
  );
}

export function toClubSettings(s: StoredSettings): ClubSnapshot {
  return { version: s.version, club: s.club, tariffs: s.tariffs, tables: s.tables, staff: s.staff };
}

/** tariffId → name, for naming games in the projection. */
export function tariffNames(settings: ClubSnapshot): Map<string, string> {
  return new Map(settings.tariffs.map((t) => [t.id, t.name]));
}

/** tableId → name. */
export function tableNames(settings: ClubSnapshot): Map<string, string> {
  return new Map(settings.tables.map((t) => [t.id, t.name]));
}
