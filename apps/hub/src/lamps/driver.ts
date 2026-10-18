export interface LampSetOptions {
  /** Blink steadily instead of a steady light (a paused game with `pauseLamp: 'blink'`). */
  blink?: boolean;
}

/**
 * Talks to the relay controller of a club. Implementations: the simulator,
 * an ESP32 relay board over HTTP (esp32-http.ts) and an industrial relay over
 * Modbus TCP (modbus-tcp.ts). A controller must keep the last state when it
 * loses the HUB — it never switches a lamp off on its own.
 *
 * Channels are the `lamp_channel` strings of tables, see address.ts.
 */
export interface LampState {
  /** The relay is closed (the lamp should be lit). */
  on: boolean;
  /** Current flows through the lamp line, when the channel has a current sensor. */
  currentOn?: boolean | undefined;
}

export interface LampDriver {
  /**
   * Resolves once the controller confirms the lamp is in the requested state.
   * `options.blink` is a hint for controllers that can blink steadily; a driver
   * that cannot may ignore it and keep the lamp steady.
   */
  setLamp(channel: string, on: boolean, signal: AbortSignal, options?: LampSetOptions): Promise<void>;
  /** Reads the relay and the current sensor of a channel. Used by the periodic monitor. */
  readState?(channel: string, signal: AbortSignal): Promise<LampState>;
  /**
   * Flashes the lamp `times` times and leaves it in the state it was in.
   * Resolves when the controller accepted the command (it may still be flashing).
   */
  blink?(channel: string, times: number, signal: AbortSignal): Promise<void>;
}

export const BLINK_PERIOD_MS = 400;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Blinks by switching the relay back and forth — for controllers without a
 * blink command. Ends in `current` (the state before the blink) even if a
 * step fails, as long as the controller still answers.
 */
export async function blinkByToggling(
  set: (on: boolean, signal: AbortSignal) => Promise<void>,
  current: boolean,
  times: number,
  signal: AbortSignal,
  periodMs = BLINK_PERIOD_MS,
): Promise<void> {
  try {
    for (let i = 0; i < times; i++) {
      await set(!current, signal);
      await sleep(periodMs, signal);
      await set(current, signal);
      if (i < times - 1) await sleep(periodMs, signal);
    }
  } catch (err) {
    if (!signal.aborted) {
      // One step failed: try once more to leave the lamp as it was.
      await set(current, signal).catch(() => undefined);
    }
    throw err;
  }
}
