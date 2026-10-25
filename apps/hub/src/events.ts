import { EventEmitter } from 'node:events';

export interface ChangeEvent {
  kind:
    | 'session'
    | 'lamp'
    | 'alert'
    | 'check'
    | 'shift'
    | 'settings'
    | 'power'
    | 'layout'
    | 'order'
    | 'catalog'
    | 'club'
    | 'staff'
    | 'license'
    /** Counter orders of a coffee shop: taken, moved to a stage, cancelled (GET /api/counter/orders, /board). */
    | 'counter'
    /** Guest requests from the QR page (guest.ts): created, accepted, rejected; QR settings. */
    | 'guest';
  tableId?: string;
}

/** In-process notifications; the HTTP layer forwards them to screens over SSE. */
export class HubEvents extends EventEmitter<{ changed: [ChangeEvent] }> {
  changed(event: ChangeEvent): void {
    this.emit('changed', event);
  }
}
