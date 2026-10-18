export interface LampSetOptions {
  /** Blink instead of steady light (a paused game, soon: the last minutes of prepaid time). */
  blink?: boolean;
}

/**
 * Talks to the relay controller of a club. Implementations: the simulator now,
 * ESP32/Modbus drivers in stage 5. A controller must keep the last state when
 * it loses the HUB — it never switches a lamp off on its own.
 */
export interface LampDriver {
  /**
   * Resolves once the controller confirms the lamp is in the requested state.
   * `options.blink` is a hint for controllers that can blink; a driver that
   * cannot may ignore it and keep the lamp steady.
   */
  setLamp(channel: string, on: boolean, signal: AbortSignal, options?: LampSetOptions): Promise<void>;
}
