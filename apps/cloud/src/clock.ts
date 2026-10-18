/** Source of "now" for reports and session expiry. Tests replace it. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class ManualClock implements Clock {
  #now: number;

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  set(ms: number): void {
    this.#now = ms;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
