import type { FastifyInstance } from 'fastify';
import type { Hub } from '../../hub.ts';

/** Routes for catalog and orders: see api.ts (CatalogView, CreateOrderRequest, …). */
export function registerBarRoutes(app: FastifyInstance, hub: Hub): void {
  void app;
  void hub;
}
