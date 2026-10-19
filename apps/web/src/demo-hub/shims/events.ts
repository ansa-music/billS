/** Browser stand-in for `node:events` (demo build only): the EventEmitter subset the HUB uses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

export class EventEmitter {
  readonly #listeners = new Map<string | symbol, Listener[]>();

  on(event: string | symbol, listener: Listener): this {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
    return this;
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }

  once(event: string | symbol, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string | symbol, listener: Listener): this {
    const list = this.#listeners.get(event);
    if (!list) return this;
    const i = list.lastIndexOf(listener);
    if (i >= 0) this.#listeners.set(event, [...list.slice(0, i), ...list.slice(i + 1)]);
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.#listeners.get(event);
    if (!list?.length) return false;
    for (const listener of list) listener(...args);
    return true;
  }

  listenerCount(event: string | symbol): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  setMaxListeners(_n: number): this {
    return this;
  }
}

export function once(): never {
  throw new Error('events.once is not available in the browser demo');
}

export default EventEmitter;
