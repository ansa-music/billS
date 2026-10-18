/** Source of "now" for billing. The HUB clock is the truth; tablets may be off. */
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
