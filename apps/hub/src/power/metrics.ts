import type { PowerView } from '@bills/domain';

/** Prometheus lines for the UPS, appended to /metrics. Nothing when no UPS is configured. */
export function renderPowerMetrics(p: PowerView): string {
  if (!p.configured) return '';
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
  };
  gauge('bills_power_ups_reachable', 'The UPS daemon answered the last reading.', p.reachable ? 1 : 0);
  gauge('bills_power_on_battery', 'The club is running on the UPS battery.', p.onBattery ? 1 : 0);
  if (p.chargePercent !== null) gauge('bills_power_battery_charge_percent', 'UPS battery charge.', p.chargePercent);
  if (p.runtimeSeconds !== null) gauge('bills_power_battery_runtime_seconds', 'Estimated runtime left on battery.', p.runtimeSeconds);
  gauge('bills_power_critical', 'Battery charge fell below the critical level during this outage.', p.critical ? 1 : 0);
  return lines.join('\n') + '\n';
}
