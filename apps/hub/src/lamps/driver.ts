/**
 * Talks to the relay controller of a club. Implementations: the simulator now,
 * ESP32/Modbus drivers in stage 5. A controller must keep the last state when
 * it loses the HUB — it never switches a lamp off on its own.
 */
export interface LampDriver {
  /** Resolves once the controller confirms the lamp is in the requested state. */
  setLamp(channel: string, on: boolean, signal: AbortSignal): Promise<void>;
}
