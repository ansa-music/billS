import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import type { HubEvents } from './events.ts';

export interface SettingsServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

/** Service for club, tables, tariffs: see api.ts (ClubAdminView, UpdateClubRequest, CreateTableRequest, …). Every command is one transaction with an audit record. */
export class SettingsService {
  readonly deps: SettingsServiceDeps;

  constructor(deps: SettingsServiceDeps) {
    this.deps = deps;
  }
}
