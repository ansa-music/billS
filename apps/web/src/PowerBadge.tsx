import type { PowerView } from '@bills/domain';
import './hall.css';

function minutes(seconds: number | null): string | null {
  if (seconds === null) return null;
  return `${Math.max(1, Math.round(seconds / 60))} мин`;
}

/**
 * Small UPS indicator for the top bar. Hidden when no UPS is configured.
 * Green: on mains. Yellow: on battery. Red: battery critical or UPS unreachable.
 */
export function PowerBadge({ power }: { power: PowerView }) {
  if (!power.configured) return null;
  let state: 'mains' | 'battery' | 'critical' | 'unknown';
  let text: string;
  if (!power.reachable) {
    state = 'unknown';
    text = 'ИБП не отвечает';
  } else if (power.onBattery) {
    state = power.critical ? 'critical' : 'battery';
    const parts = [power.chargePercent !== null ? `${Math.round(power.chargePercent)}%` : null, minutes(power.runtimeSeconds)].filter(
      Boolean,
    );
    text = `От батареи${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
  } else {
    state = 'mains';
    text = power.chargePercent !== null && power.chargePercent < 100 ? `Сеть · ИБП ${Math.round(power.chargePercent)}%` : 'Сеть · ИБП';
  }
  const title = [power.model, power.status, power.label].filter(Boolean).join(' · ');
  return (
    <span className="power" data-state={state} title={title} aria-label={`Питание: ${text}`}>
      <span className="power-icon" aria-hidden="true">
        {state === 'mains' ? '⚡' : '🔋'}
      </span>
      {text}
    </span>
  );
}
