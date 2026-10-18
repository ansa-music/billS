import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import type { HubEvents } from './events.ts';

export interface ReportServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

/** Service for owner summary: see api.ts (OwnerSummary). Every command is one transaction with an audit record. */
export class ReportService {
  readonly deps: ReportServiceDeps;

  constructor(deps: ReportServiceDeps) {
    this.deps = deps;
  }
}
