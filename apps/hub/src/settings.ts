import { randomUUID } from 'node:crypto';
import type {
  ClubAdminView,
  ClubSettingsPatch,
  CreateTableRequest,
  CreateTariffRequest,
  ReorderTablesRequest,
  TableAdminView,
  TableKind,
  TariffAdminView,
  TariffConfig,
  UpdateClubRequest,
  UpdateTableRequest,
  UpdateTariffRequest,
} from '@bills/domain';
import { isValidTimeZone, normalizeClubSettings, validateClubSettings, validateTariff } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import { clubId, loadSettings } from './views.ts';

export interface SettingsServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

interface TableRow {
  id: string;
  club_id: string;
  name: string;
  kind: TableKind;
  lamp_channel: string;
  default_tariff_id: string;
  sort_order: number;
  is_active: number;
  busy: number;
}

interface TariffRow {
  id: string;
  club_id: string;
  name: string;
  config: string;
  is_active: number;
  created_at: number;
  updated_at: number;
  table_count: number;
}

const TABLE_SQL = `
  SELECT t.id, t.club_id, t.name, t.kind, t.lamp_channel, t.default_tariff_id, t.sort_order, t.is_active,
         EXISTS (SELECT 1 FROM table_sessions s WHERE s.table_id = t.id AND s.status IN ('OPENING', 'ACTIVE')) AS busy
  FROM billiard_tables t`;

const TARIFF_SQL = `
  SELECT r.id, r.club_id, r.name, r.config, r.is_active, r.created_at, r.updated_at,
         (SELECT COUNT(*) FROM billiard_tables t WHERE t.default_tariff_id = r.id AND t.is_active = 1) AS table_count
  FROM tariffs r`;

function toTableView(r: TableRow): TableAdminView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    lampChannel: r.lamp_channel,
    defaultTariffId: r.default_tariff_id,
    sortOrder: r.sort_order,
    isActive: r.is_active === 1,
    busy: r.busy === 1,
  };
}

function toTariffView(r: TariffRow): TariffAdminView {
  return {
    id: r.id,
    name: r.name,
    config: JSON.parse(r.config) as TariffConfig,
    isActive: r.is_active === 1,
    tableCount: r.table_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function loadTables(db: Db, club: string): TableAdminView[] {
  return all<TableRow>(db, `${TABLE_SQL} WHERE t.club_id = ? ORDER BY t.sort_order, t.name`, club).map(toTableView);
}

export function loadTable(db: Db, id: string): TableAdminView {
  const row = one<TableRow>(db, `${TABLE_SQL} WHERE t.id = ?`, id);
  if (!row) throw new HubError(404, 'TABLE_NOT_FOUND', 'Стол не найден');
  return toTableView(row);
}

export function loadTariffs(db: Db, club: string): TariffAdminView[] {
  return all<TariffRow>(db, `${TARIFF_SQL} WHERE r.club_id = ? ORDER BY r.is_active DESC, r.name`, club).map(
    toTariffView,
  );
}

export function loadTariff(db: Db, id: string): TariffAdminView {
  const row = one<TariffRow>(db, `${TARIFF_SQL} WHERE r.id = ?`, id);
  if (!row) throw new HubError(404, 'TARIFF_NOT_FOUND', 'Тариф не найден');
  return toTariffView(row);
}

export function loadClub(db: Db): ClubAdminView {
  const club = one<{ id: string; company_id: string; company_name: string; name: string; timezone: string; currency: string }>(
    db,
    `SELECT c.id, c.company_id, co.name AS company_name, c.name, c.timezone, c.currency
     FROM clubs c JOIN companies co ON co.id = c.company_id
     WHERE c.id = ?`,
    clubId(db),
  );
  if (!club) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
  return {
    id: club.id,
    companyId: club.company_id,
    companyName: club.company_name,
    name: club.name,
    timezone: club.timezone,
    currency: club.currency,
    settings: loadSettings(db, club.id),
    tables: loadTables(db, club.id),
    tariffs: loadTariffs(db, club.id),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; errcode?: number; message?: string };
  return e?.code === 'ERR_SQLITE_ERROR' && /UNIQUE/i.test(e.message ?? '');
}

function cleanName(value: string, max: number, what: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > max) {
    throw new HubError(422, 'NAME_INVALID', `${what}: название от 1 до ${max} символов`);
  }
  return name;
}

/**
 * Club, tables, tariffs: see api.ts (ClubAdminView, UpdateClubRequest, CreateTableRequest, …).
 * Every command is one transaction with an audit record; screens are told through `club` events.
 */
export class SettingsService {
  readonly deps: SettingsServiceDeps;

  constructor(deps: SettingsServiceDeps) {
    this.deps = deps;
  }

  /** GET /api/club: everything the settings page edits, inactive rows included. */
  club(): ClubAdminView {
    return loadClub(this.deps.db);
  }

  updateClub(input: UpdateClubRequest & { actor: string }): ClubAdminView {
    const { db, clock, events } = this.deps;
    const now = clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const current = loadClub(db);
      const changed: Record<string, unknown> = {};

      if (input.name !== undefined) {
        const name = cleanName(input.name, 80, 'Клуб');
        if (name !== current.name) {
          run(db, 'UPDATE clubs SET name = ? WHERE id = ?', name, club);
          changed.name = name;
        }
      }
      if (input.timezone !== undefined) {
        const tz = input.timezone.trim();
        if (!isValidTimeZone(tz)) {
          throw new HubError(422, 'TIMEZONE_INVALID', `Неизвестный часовой пояс «${input.timezone}»`);
        }
        if (tz !== current.timezone) {
          run(db, 'UPDATE clubs SET timezone = ? WHERE id = ?', tz, club);
          changed.timezone = tz;
        }
      }
      if (input.currency !== undefined) {
        const currency = input.currency.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(currency)) {
          throw new HubError(422, 'CURRENCY_INVALID', 'Валюта — трёхбуквенный код ISO 4217, например KZT');
        }
        if (currency !== current.currency) {
          run(db, 'UPDATE clubs SET currency = ? WHERE id = ?', currency, club);
          changed.currency = currency;
        }
      }
      if (input.settings !== undefined) {
        const next = normalizeClubSettings(input.settings as ClubSettingsPatch, current.settings);
        const errors = validateClubSettings(next);
        if (errors.length) throw new HubError(422, 'SETTINGS_INVALID', errors.join('. '));
        if (JSON.stringify(next) !== JSON.stringify(current.settings)) {
          run(db, 'UPDATE clubs SET settings = ? WHERE id = ?', JSON.stringify(next), club);
          changed.settings = input.settings;
        }
      }

      if (Object.keys(changed).length) {
        record(db, now, { actor: input.actor, action: 'club.updated', entityType: 'club', entityId: club, data: changed });
        afterCommit(db, () => events.changed({ kind: 'club' }));
      }
      return loadClub(db);
    });
  }

  createTable(input: CreateTableRequest & { actor: string }): TableAdminView {
    const { db, clock, events } = this.deps;
    const now = clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const name = cleanName(input.name, 40, 'Стол');
      const lampChannel = cleanName(input.lampChannel, 40, 'Канал лампы');
      this.#assertTableNameFree(club, name, null);
      this.#assertLampChannelFree(club, lampChannel, null);
      this.#assertTariffActive(club, input.defaultTariffId);

      const id = randomUUID();
      const sortOrder =
        (one<{ m: number | null }>(db, 'SELECT MAX(sort_order) AS m FROM billiard_tables WHERE club_id = ?', club)?.m ??
          0) + 1;
      try {
        run(
          db,
          `INSERT INTO billiard_tables (id, club_id, name, kind, lamp_channel, default_tariff_id, sort_order, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          id,
          club,
          name,
          input.kind,
          lampChannel,
          input.defaultTariffId,
          sortOrder,
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new HubError(409, 'LAMP_CHANNEL_TAKEN', `Канал лампы «${lampChannel}» уже занят другим столом`);
        }
        throw err;
      }
      // The lamp controller learns the table from this row: it will bring the lamp to OFF.
      run(
        db,
        "INSERT INTO lamp_states (table_id, desired, reported, updated_at) VALUES (?, 'OFF', 'UNKNOWN', ?)",
        id,
        now,
      );
      record(db, now, {
        actor: input.actor,
        action: 'table.created',
        entityType: 'table',
        entityId: id,
        data: { name, kind: input.kind, lampChannel, defaultTariffId: input.defaultTariffId, sortOrder },
      });
      afterCommit(db, () => events.changed({ kind: 'club', tableId: id }));
      return loadTable(db, id);
    });
  }

  updateTable(input: UpdateTableRequest & { tableId: string; actor: string }): TableAdminView {
    const { db, clock, events } = this.deps;
    const now = clock.now();
    return transaction(db, () => {
      const row = one<TableRow>(db, `${TABLE_SQL} WHERE t.id = ?`, input.tableId);
      if (!row) throw new HubError(404, 'TABLE_NOT_FOUND', 'Стол не найден');
      const club = row.club_id;
      const changed: Record<string, unknown> = {};
      const sets: string[] = [];
      const params: Array<string | number> = [];

      const willBeActive = input.isActive ?? row.is_active === 1;

      if (input.name !== undefined) {
        const name = cleanName(input.name, 40, 'Стол');
        if (name !== row.name) {
          sets.push('name = ?');
          params.push(name);
          changed.name = name;
        }
      }
      // An active table must not clash with another active one (also when it is switched back on).
      if (willBeActive) this.#assertTableNameFree(club, (changed.name as string | undefined) ?? row.name, row.id);

      if (input.kind !== undefined && input.kind !== row.kind) {
        sets.push('kind = ?');
        params.push(input.kind);
        changed.kind = input.kind;
      }
      if (input.lampChannel !== undefined) {
        const lampChannel = cleanName(input.lampChannel, 40, 'Канал лампы');
        if (lampChannel !== row.lamp_channel) {
          this.#assertLampChannelFree(club, lampChannel, row.id);
          sets.push('lamp_channel = ?');
          params.push(lampChannel);
          changed.lampChannel = lampChannel;
        }
      }
      if (input.defaultTariffId !== undefined && input.defaultTariffId !== row.default_tariff_id) {
        this.#assertTariffActive(club, input.defaultTariffId);
        sets.push('default_tariff_id = ?');
        params.push(input.defaultTariffId);
        changed.defaultTariffId = input.defaultTariffId;
      }
      if (input.isActive !== undefined && input.isActive !== (row.is_active === 1)) {
        if (!input.isActive && row.busy === 1) {
          throw new HubError(409, 'TABLE_BUSY', `${row.name}: идёт игра, стол нельзя отключить`);
        }
        sets.push('is_active = ?');
        params.push(input.isActive ? 1 : 0);
        changed.isActive = input.isActive;
      }

      if (sets.length) {
        try {
          run(db, `UPDATE billiard_tables SET ${sets.join(', ')} WHERE id = ?`, ...params, row.id);
        } catch (err) {
          if (isUniqueViolation(err)) {
            throw new HubError(409, 'LAMP_CHANNEL_TAKEN', 'Канал лампы уже занят другим столом');
          }
          throw err;
        }
        record(db, now, { actor: input.actor, action: 'table.updated', entityType: 'table', entityId: row.id, data: changed });
        afterCommit(db, () => events.changed({ kind: 'club', tableId: row.id }));
      }
      return loadTable(db, row.id);
    });
  }

  reorderTables(input: ReorderTablesRequest & { actor: string }): { tables: TableAdminView[] } {
    const { db, clock, events } = this.deps;
    const now = clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const current = loadTables(db, club);
      const known = new Set(current.map((t) => t.id));
      const seen = new Set<string>();
      for (const id of input.tableIds) {
        if (!known.has(id) || seen.has(id)) {
          throw new HubError(422, 'TABLE_IDS_INVALID', 'Список столов не совпадает со столами клуба');
        }
        seen.add(id);
      }
      // Listed tables come first in the given order; the rest keep their relative order after them.
      const order = [...input.tableIds, ...current.filter((t) => !seen.has(t.id)).map((t) => t.id)];
      order.forEach((id, i) => run(db, 'UPDATE billiard_tables SET sort_order = ? WHERE id = ?', i + 1, id));
      record(db, now, {
        actor: input.actor,
        action: 'tables.reordered',
        entityType: 'club',
        entityId: club,
        data: { tableIds: order },
      });
      afterCommit(db, () => events.changed({ kind: 'club' }));
      return { tables: loadTables(db, club) };
    });
  }

  createTariff(input: CreateTariffRequest & { actor: string }): TariffAdminView {
    const { db, clock, events } = this.deps;
    const now = clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const name = cleanName(input.name, 60, 'Тариф');
      this.#assertTariffNameFree(club, name, null);
      const config = this.#checkTariff(club, input.config);
      const id = randomUUID();
      run(
        db,
        'INSERT INTO tariffs (id, club_id, name, config, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        id,
        club,
        name,
        JSON.stringify(config),
        now,
        now,
      );
      record(db, now, {
        actor: input.actor,
        action: 'tariff.created',
        entityType: 'tariff',
        entityId: id,
        data: { name, config },
      });
      afterCommit(db, () => events.changed({ kind: 'club' }));
      return loadTariff(db, id);
    });
  }

  /** Running games keep their tariff snapshot: nothing here touches table_sessions. */
  updateTariff(input: UpdateTariffRequest & { tariffId: string; actor: string }): TariffAdminView {
    const { db, clock, events } = this.deps;
    const now = clock.now();
    return transaction(db, () => {
      const row = one<TariffRow>(db, `${TARIFF_SQL} WHERE r.id = ?`, input.tariffId);
      if (!row) throw new HubError(404, 'TARIFF_NOT_FOUND', 'Тариф не найден');
      const club = row.club_id;
      const changed: Record<string, unknown> = {};
      const sets: string[] = [];
      const params: Array<string | number> = [];
      const willBeActive = input.isActive ?? row.is_active === 1;

      if (input.name !== undefined) {
        const name = cleanName(input.name, 60, 'Тариф');
        if (name !== row.name) {
          sets.push('name = ?');
          params.push(name);
          changed.name = name;
        }
      }
      if (willBeActive) this.#assertTariffNameFree(club, (changed.name as string | undefined) ?? row.name, row.id);

      if (input.config !== undefined) {
        const config = this.#checkTariff(club, input.config);
        const json = JSON.stringify(config);
        if (json !== JSON.stringify(JSON.parse(row.config))) {
          sets.push('config = ?');
          params.push(json);
          changed.config = config;
        }
      }
      if (input.isActive !== undefined && input.isActive !== (row.is_active === 1)) {
        if (!input.isActive && row.table_count > 0) {
          throw new HubError(
            409,
            'TARIFF_IN_USE',
            `Тариф «${row.name}» назначен по умолчанию ${row.table_count} ${plural(row.table_count, 'столу', 'столам', 'столам')}. Сначала переназначьте столы`,
          );
        }
        sets.push('is_active = ?');
        params.push(input.isActive ? 1 : 0);
        changed.isActive = input.isActive;
      }

      if (sets.length) {
        sets.push('updated_at = ?');
        params.push(now);
        run(db, `UPDATE tariffs SET ${sets.join(', ')} WHERE id = ?`, ...params, row.id);
        record(db, now, { actor: input.actor, action: 'tariff.updated', entityType: 'tariff', entityId: row.id, data: changed });
        afterCommit(db, () => events.changed({ kind: 'club' }));
      }
      return loadTariff(db, row.id);
    });
  }

  #checkTariff(club: string, config: TariffConfig): TariffConfig {
    const db = this.deps.db;
    const c = one<{ timezone: string; currency: string }>(db, 'SELECT timezone, currency FROM clubs WHERE id = ?', club);
    if (!c) throw new HubError(503, 'CLUB_NOT_CONFIGURED', 'Клуб не настроен');
    const errors = validateTariff(config, c.timezone);
    if (config.currency !== c.currency) errors.push(`валюта тарифа должна быть ${c.currency}`);
    if (errors.length) throw new HubError(422, 'TARIFF_INVALID', `Тариф задан неверно: ${errors.join('; ')}`);
    // Store a clean copy in the canonical key order: unknown keys are dropped by the schema already.
    return {
      currency: config.currency,
      basePricePerHour: config.basePricePerHour,
      windows: config.windows.map((w) => ({
        label: w.label.trim(),
        days: [...new Set(w.days)].sort((a, b) => a - b),
        from: w.from,
        to: w.to,
        pricePerHour: w.pricePerHour,
      })),
      stepMinutes: config.stepMinutes,
      minimumMinutes: config.minimumMinutes,
      freeMinutes: config.freeMinutes,
      roundingMinor: config.roundingMinor,
    };
  }

  #assertTableNameFree(club: string, name: string, exceptId: string | null): void {
    const clash = one<{ id: string }>(
      this.deps.db,
      'SELECT id FROM billiard_tables WHERE club_id = ? AND is_active = 1 AND name = ? AND id IS NOT ?',
      club,
      name,
      exceptId,
    );
    if (clash) throw new HubError(409, 'TABLE_NAME_TAKEN', `Стол «${name}» уже есть`);
  }

  #assertLampChannelFree(club: string, channel: string, exceptId: string | null): void {
    const clash = one<{ name: string }>(
      this.deps.db,
      'SELECT name FROM billiard_tables WHERE club_id = ? AND lamp_channel = ? AND id IS NOT ?',
      club,
      channel,
      exceptId,
    );
    if (clash) throw new HubError(409, 'LAMP_CHANNEL_TAKEN', `Канал лампы «${channel}» уже занят: ${clash.name}`);
  }

  #assertTariffActive(club: string, tariffId: string): void {
    const t = one<{ id: string }>(
      this.deps.db,
      'SELECT id FROM tariffs WHERE id = ? AND club_id = ? AND is_active = 1',
      tariffId,
      club,
    );
    if (!t) throw new HubError(422, 'TARIFF_NOT_AVAILABLE', 'Тариф недоступен: он выключен или не найден');
  }

  #assertTariffNameFree(club: string, name: string, exceptId: string | null): void {
    const clash = one<{ id: string }>(
      this.deps.db,
      'SELECT id FROM tariffs WHERE club_id = ? AND is_active = 1 AND name = ? AND id IS NOT ?',
      club,
      name,
      exceptId,
    );
    if (clash) throw new HubError(409, 'TARIFF_NAME_TAKEN', `Тариф «${name}» уже есть`);
  }
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
