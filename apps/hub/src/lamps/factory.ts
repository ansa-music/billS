import type { HubConfig } from '../config.ts';
import type { LampDriver } from './driver.ts';
import { Esp32HttpLampDriver } from './esp32-http.ts';
import { ModbusTcpLampDriver } from './modbus-tcp.ts';
import { SimulatorLampDriver } from './simulator.ts';

export interface LampDrivers {
  driver: LampDriver;
  /** Set only for the simulator: exposes /api/dev/lamps. */
  simulator: SimulatorLampDriver | undefined;
  close(): void;
}

/** Picks the relay controller driver from HUB_LAMP_DRIVER. */
export function createLampDriver(config: HubConfig): LampDrivers {
  switch (config.lampDriver) {
    case 'simulator': {
      const simulator = new SimulatorLampDriver({ latencyMs: config.simulatorLatencyMs });
      return { driver: simulator, simulator, close: () => undefined };
    }
    case 'esp32-http': {
      const driver = new Esp32HttpLampDriver({ defaultHost: config.esp32.host, token: config.esp32.token });
      return { driver, simulator: undefined, close: () => undefined };
    }
    case 'modbus-tcp': {
      const driver = new ModbusTcpLampDriver({
        defaultHost: config.modbus.host,
        unitId: config.modbus.unitId,
        coilBase: config.modbus.coilBase,
        currentInputs: config.modbus.currentInputs,
        currentInputOffset: config.modbus.currentInputOffset,
      });
      return { driver, simulator: undefined, close: () => driver.close() };
    }
  }
}
