import type { LampDriver } from './driver.ts';

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
  lamps: Record<string, boolean>;
}

/** In-memory lamp controller for development, demos and tests. */
export class SimulatorLampDriver implements LampDriver {
  latencyMs: number;
  /** While true every command fails, like an unplugged controller. */
  offline = false;
  readonly calls: Array<{ channel: string; on: boolean }> = [];
  readonly #lamps = new Map<string, boolean>();
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

  status(): SimulatorStatus {
    return {
      latencyMs: this.latencyMs,
      offline: this.offline,
      faults: [...this.#faults],
      lamps: Object.fromEntries(this.#lamps),
    };
  }

  setLamp(channel: string, on: boolean, signal: AbortSignal): Promise<void> {
    this.calls.push({ channel, on });
    const fault: SimulatorFault | undefined = this.offline ? 'fail' : this.#faults.shift();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (fault === 'fail') {
          reject(new Error('Controller error'));
          return;
        }
        this.#lamps.set(channel, on);
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
}
