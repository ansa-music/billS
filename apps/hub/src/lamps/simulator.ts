import type { LampDriver, LampSetOptions, LampState } from './driver.ts';
import { blinkByToggling } from './driver.ts';

/**
 * fail      the controller answers with an error, the lamp does not change
 * drop-ack  the lamp switches, but the confirmation is lost (caller times out)
 */
export type SimulatorFault = 'fail' | 'drop-ack';
export const SIMULATOR_FAULTS: readonly SimulatorFault[] = ['fail', 'drop-ack'];

export interface SimulatorStatus {
  latencyMs: number;
  offline: boolean;
  faults: SimulatorFault[];
  /** Relay state per channel. */
  lamps: Record<string, boolean>;
  /** Channels asked to keep blinking (paused game); always a subset of lamps that are on. */
  blink: Record<string, boolean>;
  /**
   * Current-sensor overrides per channel: `true` — someone switched the light on
   * by hand (bypassing the relay), `false` — the bulb is dead. Absent: the
   * sensor follows the relay.
   */
  lights: Record<string, boolean>;
  /** One-off blink commands accepted, per channel. */
  blinks: Record<string, number>;
}

/** In-memory lamp controller for development, demos and tests. */
export class SimulatorLampDriver implements LampDriver {
  latencyMs: number;
  /** While true every command fails, like an unplugged controller. */
  offline = false;
  readonly calls: Array<{ channel: string; on: boolean; blink: boolean }> = [];
  readonly #lamps = new Map<string, boolean>();
  readonly #blink = new Map<string, boolean>();
  readonly #lights = new Map<string, boolean>();
  readonly #blinks = new Map<string, number>();
  #faults: SimulatorFault[] = [];

  constructor(options: { latencyMs?: number } = {}) {
    this.latencyMs = options.latencyMs ?? 300;
  }

  /** Faults are consumed one per command, in order. */
  injectFaults(...faults: SimulatorFault[]): void {
    this.#faults.push(...faults);
  }

  clearFaults(): void {
    this.#faults = [];
  }

  isOn(channel: string): boolean {
    return this.#lamps.get(channel) ?? false;
  }

  isBlinking(channel: string): boolean {
    return this.#blink.get(channel) ?? false;
  }

  /**
   * Forces what the current sensor of a channel reports, regardless of the
   * relay: `true` = light on by hand, `false` = bulb dead, `null` = follow the relay.
   */
  setLight(channel: string, on: boolean | null): void {
    if (on === null) this.#lights.delete(channel);
    else this.#lights.set(channel, on);
  }

  blinkCount(channel: string): number {
    return this.#blinks.get(channel) ?? 0;
  }

  status(): SimulatorStatus {
    return {
      latencyMs: this.latencyMs,
      offline: this.offline,
      faults: [...this.#faults],
      lamps: Object.fromEntries(this.#lamps),
      blink: Object.fromEntries(this.#blink),
      lights: Object.fromEntries(this.#lights),
      blinks: Object.fromEntries(this.#blinks),
    };
  }

  setLamp(channel: string, on: boolean, signal: AbortSignal, options: LampSetOptions = {}): Promise<void> {
    const blink = on && (options.blink ?? false);
    this.calls.push({ channel, on, blink });
    const fault: SimulatorFault | undefined = this.offline ? 'fail' : this.#faults.shift();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (fault === 'fail') {
          reject(new Error('Controller error'));
          return;
        }
        this.#lamps.set(channel, on);
        this.#blink.set(channel, blink);
        if (fault !== 'drop-ack') resolve();
      }, this.latencyMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  readState(channel: string, signal: AbortSignal): Promise<LampState> {
    return this.#answer(signal, () => {
      const on = this.isOn(channel);
      return { on, currentOn: this.#lights.get(channel) ?? on };
    });
  }

  /** Flashes `times` times (quickly) and leaves the relay as it was. */
  async blink(channel: string, times: number, signal: AbortSignal): Promise<void> {
    await this.#answer(signal, () => undefined);
    this.#blinks.set(channel, this.blinkCount(channel) + 1);
    const current = this.isOn(channel);
    await blinkByToggling(
      async (on) => {
        this.#lamps.set(channel, on);
      },
      current,
      times,
      signal,
      Math.min(this.latencyMs, 50),
    );
  }

  /** Answers after `latencyMs`, or fails while offline. */
  #answer<T>(signal: AbortSignal, produce: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.offline) reject(new Error('Controller error'));
        else resolve(produce());
      }, this.latencyMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }
}
