import type { ApiError, HubState, ManualModeView } from '@bills/domain';

export class HubRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** crypto.randomUUID needs a secure context; tablets reach the HUB over plain http on the LAN. */
function newKey(): string {
  if (typeof crypto.randomUUID === 'function' && window.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function toError(res: Response): Promise<HubRequestError> {
  try {
    const body = (await res.json()) as ApiError;
    return new HubRequestError(res.status, body.error.code, body.error.message);
  } catch {
    return new HubRequestError(res.status, 'HTTP_ERROR', `HUB ответил ошибкой ${res.status}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchState(): Promise<HubState> {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as HubState;
}

/**
 * Sends a command. On a lost connection or a server error it retries with the
 * same idempotency key, so a command that did reach the HUB is not repeated.
 */
export async function command<T>(path: string, actor: string, body: object = {}): Promise<T> {
  const key = newKey();
  let lastError: Error = new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    let res: Response;
    try {
      res = await fetch(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': key,
          'x-actor': encodeURIComponent(actor.trim() || 'unknown'),
        },
        body: JSON.stringify(body),
      });
    } catch {
      lastError = new HubRequestError(0, 'OFFLINE', 'Нет связи с HUB');
      continue;
    }
    if (res.status >= 500) {
      lastError = await toError(res);
      continue;
    }
    if (!res.ok) throw await toError(res);
    return (await res.json()) as T;
  }
  throw lastError;
}

/** Flashes the lamp of a table: checks that the relay is wired to the right table. */
export function blinkTable(tableId: string, actor: string, times = 3): Promise<{ commandId: string }> {
  return command(`/api/tables/${tableId}/blink`, actor, { times });
}

export function setManualMode(actor: string, enabled: boolean, reason?: string): Promise<ManualModeView> {
  return command('/api/lamps/manual', actor, reason === undefined ? { enabled } : { enabled, reason });
}

export interface SimulatorStatus {
  latencyMs: number;
  offline: boolean;
  faults: Array<'fail' | 'drop-ack'>;
  lamps: Record<string, boolean>;
  /** Current-sensor overrides: true — light on by hand, false — dead bulb. */
  lights: Record<string, boolean>;
  blinks: Record<string, number>;
}

export interface SimulatorPatch {
  latencyMs?: number;
  offline?: boolean;
  faults?: Array<'fail' | 'drop-ack'>;
  clearFaults?: boolean;
  light?: { channel: string; on: boolean | null };
  /** Poll the sensors right now instead of waiting for the next tick. */
  poll?: boolean;
}

export async function fetchSimulator(): Promise<SimulatorStatus | null> {
  const res = await fetch('/api/dev/lamps', { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw await toError(res);
  return (await res.json()) as SimulatorStatus;
}

export async function updateSimulator(patch: SimulatorPatch): Promise<SimulatorStatus> {
  const res = await fetch('/api/dev/lamps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as SimulatorStatus;
}
