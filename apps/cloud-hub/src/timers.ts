/**
 * The HUB's background intervals (lamp reconcile, «Сторож», prepaid games, bookings) inside a Durable Object.
 *
 * A real setInterval would keep the object from hibernating, and Cloudflare bills a café's Durable Object
 * for every second it stays awake (128 MB × 86 400 s ≈ 11 000 GB-s a day — almost the whole free 13 000).
 * So while the HUB starts, its intervals are captured here instead of being armed, and they run as catch-up
 * work at the start of the next request (`runDue`). A coffee shop has none that matter (they serve lamps,
 * billiard prepaid games and bookings); a billiard club in the cloud would arm a Durable Object alarm for
 * the next prepaid deadline instead (not done in this prototype).
 */

interface Captured {
  fn: () => void;
  everyMs: number;
  repeat: boolean;
  nextAt: number;
}

export class VirtualTimers {
  readonly #timers = new Map<number, Captured>();
  readonly #floorMs: number;
  #nextId = 1;

  /** `floorMs`: catch-up work runs at most this often per job, however short the HUB's interval. */
  constructor(floorMs = 10_000) {
    this.#floorMs = floorMs;
  }

  get size(): number {
    return this.#timers.size;
  }

  /** Runs `fn` (synchronous) with setInterval/setTimeout captured instead of armed. */
  capture<T>(now: number, fn: () => T): T {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { setInterval: g.setInterval, setTimeout: g.setTimeout, clearInterval: g.clearInterval, clearTimeout: g.clearTimeout };
    const add = (repeat: boolean) => (cb: () => void, ms?: number) => {
      const id = this.#nextId++;
      const everyMs = Math.max(this.#floorMs, ms ?? 0);
      this.#timers.set(id, { fn: cb, everyMs, repeat, nextAt: now + everyMs });
      return id;
    };
    const clear = (id: unknown) => {
      if (typeof id === 'number') this.#timers.delete(id);
    };
    g.setInterval = add(true);
    g.setTimeout = add(false);
    g.clearInterval = clear;
    g.clearTimeout = clear;
    try {
      return fn();
    } finally {
      Object.assign(g, saved);
    }
  }

  /** Runs every captured job that is due (once each, however long the object slept). Returns how many ran. */
  runDue(now: number): number {
    let ran = 0;
    for (const [id, t] of this.#timers) {
      if (t.nextAt > now) continue;
      if (t.repeat) t.nextAt = now + t.everyMs;
      else this.#timers.delete(id);
      try {
        t.fn();
        ran++;
      } catch (err) {
        console.warn('[cloud hub] background job failed', err);
      }
    }
    return ran;
  }
}
