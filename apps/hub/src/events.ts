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
    | 'license';
  tableId?: string;
}

/** In-process notifications; the HTTP layer forwards them to screens over SSE. */
export class HubEvents extends EventEmitter<{ changed: [ChangeEvent] }> {
  changed(event: ChangeEvent): void {
    this.emit('changed', event);
  }
}
