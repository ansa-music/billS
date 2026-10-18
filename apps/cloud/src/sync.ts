import { randomUUID } from 'node:crypto';
import type {
  ClubSnapshot,
  SyncEventsRequest,
  SyncEventsResponse,
  SyncSettingsResponse,
  SyncSnapshotRequest,
  SyncSnapshotResponse,
  TariffConfig,
  TariffSetting,
  TariffWindow,
  UpdateTariffsRequest,
  UpdateTariffsResponse,
} from '@bills/domain';
import { validateTariff } from '@bills/domain';
import { hashApiKey } from './auth.ts';
import type { SqlDriver } from './db/driver.ts';
import { CloudError } from './errors.ts';
import { projectEvent } from './projection.ts';
import type { ClubRow } from './settings.ts';
import { loadSettings, saveSettings, tariffNames, toClubSettings } from './settings.ts';

export interface HubRow {
  id: string;
  club_id: string;
  name: string;
  api_key_hash: string;
  created_at: number;
  last_seen_at: number | null;
  last_outbox_id: number | null;
  settings_version: number;
}

export async function findHubByKey(db: SqlDriver, key: string): Promise<HubRow | null> {
  const rows = await db.all<HubRow>('SELECT * FROM hubs WHERE api_key_hash = ?', [hashApiKey(key)]);
  return rows[0] ?? null;
}

export async function loadClub(db: SqlDriver, clubId: string): Promise<ClubRow | null> {
  const rows = await db.all<ClubRow>('SELECT * FROM clubs WHERE id = ?', [clubId]);
  return rows[0] ?? null;
}

async function clubOfHub(tx: SqlDriver, hub: HubRow): Promise<ClubRow> {
  const club = await loadClub(tx, hub.club_id);
  if (!club) throw new CloudError(500, 'CLUB_MISSING', 'Клуб этого HUB не найден');
  return club;
}

// ---------------------------------------------------------------------------
// UP: events
// ---------------------------------------------------------------------------

/**
 * Stores a batch and projects the new events, all in one transaction.
 * An event already stored (same hub, same outbox id) is skipped — the HUB
 * resends batches after a lost response.
 */
export async function acceptEvents(
  db: SqlDriver,
  now: number,
  hub: HubRow,
  req: SyncEventsRequest,
): Promise<SyncEventsResponse> {
  return db.transaction(async (tx) => {
    const club = await clubOfHub(tx, hub);
    const settings = await loadSettings(tx, club);
    const ctx = { clubId: club.id, timezone: club.timezone, tariffNames: tariffNames(settings) };

    let inserted = 0;
    for (const event of [...req.events].sort((a, b) => a.id - b.id)) {
      const changes = await tx.run(
        `INSERT INTO events (hub_id, outbox_id, club_id, at, topic, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (hub_id, outbox_id) DO NOTHING`,
        [hub.id, event.id, club.id, event.at, event.topic, JSON.stringify(event.payload), now],
      );
      if (changes === 0) continue;
      inserted++;
      await projectEvent(tx, ctx, event);
    }

    const last = await tx.all<{ m: number | string | null }>('SELECT MAX(outbox_id) AS m FROM events WHERE hub_id = ?', [
      hub.id,
    ]);
    const raw = last[0]?.m;
    const lastAcceptedId = raw === null || raw === undefined ? null : Number(raw);
    await tx.run('UPDATE hubs SET last_seen_at = ?, last_outbox_id = ?, settings_version = ? WHERE id = ?', [
      now,
      lastAcceptedId,
      req.settingsVersion,
      hub.id,
    ]);
    return { lastAcceptedId, inserted, settingsVersion: settings.version };
  });
}

// ---------------------------------------------------------------------------
// Settings: snapshot (UP), pull (DOWN), owner edits
// ---------------------------------------------------------------------------

export interface SnapshotOutcome {
  status: 200 | 409;
  body: SyncSnapshotResponse;
}

/** Accepts the HUB's settings unless the HUB is behind the cloud's version. */
export async function acceptSnapshot(
  db: SqlDriver,
  now: number,
  hub: HubRow,
  req: SyncSnapshotRequest,
): Promise<SnapshotOutcome> {
  return db.transaction(async (tx) => {
    const club = await clubOfHub(tx, hub);
    const current = await loadSettings(tx, club);
    await tx.run('UPDATE hubs SET last_seen_at = ?, settings_version = ? WHERE id = ?', [now, req.settingsVersion, hub.id]);
    if (req.settingsVersion < current.version) {
      return { status: 409, body: { accepted: false, settingsVersion: current.version } };
    }
    // Normally equal; a HUB ahead of the cloud (cloud restored from an older backup) wins.
    const version = Math.max(current.version, req.settingsVersion);
    await saveSettings(
      tx,
      club.id,
      { version, club: req.club, tariffs: req.tariffs, tables: req.tables, staff: current.staff },
      'hub',
      now,
    );
    return { status: 200, body: { accepted: true, settingsVersion: version } };
  });
}

export async function settingsSince(db: SqlDriver, club: ClubRow, since: number): Promise<SyncSettingsResponse> {
  const current = await loadSettings(db, club);
  if (since >= current.version) return { changed: false, version: current.version };
  return { changed: true, ...toClubSettings(current) };
}

// --- Owner tariff edits ------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(name: string, detail: string): CloudError {
  return new CloudError(400, 'TARIFF_INVALID', `Тариф «${name}»: ${detail}`);
}

/** Picks the known TariffConfig fields with loose types; validateTariff checks the values. */
function readConfig(name: string, raw: unknown): TariffConfig {
  if (!isObject(raw)) throw invalid(name, 'нет настроек тарифа');
  const windowsRaw = raw.windows;
  if (!Array.isArray(windowsRaw)) throw invalid(name, 'окна цен должны быть списком');
  const windows: TariffWindow[] = windowsRaw.map((w, i) => {
    if (!isObject(w)) throw invalid(name, `окно ${i + 1} задано неверно`);
    if (!Array.isArray(w.days)) throw invalid(name, `окно ${i + 1}: дни недели должны быть списком`);
    return {
      label: typeof w.label === 'string' ? w.label : '',
      days: w.days as TariffWindow['days'],
      from: typeof w.from === 'string' ? w.from : '',
      to: typeof w.to === 'string' ? w.to : '',
      pricePerHour: w.pricePerHour as number,
    };
  });
  return {
    currency: typeof raw.currency === 'string' ? raw.currency : '',
    basePricePerHour: raw.basePricePerHour as number,
    windows,
    stepMinutes: raw.stepMinutes as number,
    minimumMinutes: raw.minimumMinutes as number,
    freeMinutes: raw.freeMinutes as number,
    roundingMinor: raw.roundingMinor as number,
  };
}

/**
 * Replaces the tariff list of a club: version + 1, source 'owner'. Tariffs
 * missing from the request are kept but deactivated so old games keep their names.
 */
export async function updateTariffs(
  db: SqlDriver,
  now: number,
  club: ClubRow,
  req: UpdateTariffsRequest,
): Promise<UpdateTariffsResponse> {
  if (!isObject(req) || !Array.isArray(req.tariffs)) {
    throw new CloudError(400, 'TARIFF_INVALID', 'Нужен список тарифов');
  }
  const next: TariffSetting[] = [];
  const seen = new Set<string>();
  for (const [i, item] of req.tariffs.entries()) {
    if (!isObject(item)) throw new CloudError(400, 'TARIFF_INVALID', `Тариф ${i + 1} задан неверно`);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) throw new CloudError(400, 'TARIFF_INVALID', `Тариф ${i + 1}: укажите название`);
    if (item.id !== undefined && (typeof item.id !== 'string' || !item.id)) throw invalid(name, 'неверный id');
    const id = typeof item.id === 'string' ? item.id : randomUUID();
    if (seen.has(id)) throw invalid(name, 'повторяющийся id');
    seen.add(id);
    const config = readConfig(name, item.config);
    const errors = validateTariff(config, club.timezone);
    if (errors.length) throw invalid(name, errors.join('; '));
    next.push({ id, name, config, isActive: item.isActive === undefined ? true : item.isActive === true });
  }
  if (!next.some((t) => t.isActive)) {
    throw new CloudError(400, 'TARIFF_INVALID', 'Нужен хотя бы один действующий тариф');
  }

  return db.transaction(async (tx) => {
    const current = await loadSettings(tx, club);
    for (const old of current.tariffs) if (!seen.has(old.id)) next.push({ ...old, isActive: false });
    const settings: ClubSnapshot = {
      version: current.version + 1,
      club: current.club,
      tariffs: next,
      tables: current.tables,
      staff: current.staff,
    };
    await saveSettings(tx, club.id, settings, 'owner', now);
    return { settings };
  });
}
