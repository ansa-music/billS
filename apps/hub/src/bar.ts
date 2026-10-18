import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import type { HubEvents } from './events.ts';

export interface BarServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

/** Service for catalog and orders: see api.ts (CatalogView, CreateOrderRequest, …). Every command is one transaction with an audit record. */
export class BarService {
  readonly deps: BarServiceDeps;

  constructor(deps: BarServiceDeps) {
    this.deps = deps;
  }
}
