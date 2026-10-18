import { useState } from 'react';
import type { HubState, ManualModeView, TableView } from '@bills/domain';
import { formatClock } from './format.ts';
import './hall.css';

/**
 * Yellow banner while the HUB is in manual (emergency) mode: the relay
 * controller is broken, staff switch lamps by hand, games start at the button.
 */
export function ManualModeBanner({
  mode,
  timezone,
  busy,
  onDisable,
}: {
  mode: ManualModeView;
  timezone: string;
  busy: boolean;
  onDisable: () => void;
}) {
  if (!mode.enabled) return null;
  return (
    <div className="hall-manual" role="status">
      <span className="hall-manual-icon" aria-hidden="true">
        ⚠
      </span>
      <p className="hall-manual-text">
        <strong>Ручной режим: свет включайте вручную.</strong> Время идёт с нажатия «Открыть», лампа не ждётся.
        {mode.reason && <> Причина: {mode.reason}.</>}
        {mode.since != null && (
          <span className="muted">
            {' '}
            С {formatClock(mode.since, timezone)}
            {mode.by ? `, включил ${mode.by}` : ''}.
          </span>
        )}
      </p>
      <button type="button" className="btn btn-small hall-manual-btn" disabled={busy} onClick={onDisable}>
        Выключить (управляющий)
      </button>
    </div>
  );
}

function SensorBadge({ lamp }: { lamp: TableView['lamp'] }) {
  if (lamp.currentOn === null) return <span className="muted">датчик: —</span>;
  const bad = lamp.currentOn !== (lamp.reported === 'ON');
  return (
    <span className={bad ? 'hw-sensor hw-sensor-bad' : 'hw-sensor'} title="Датчик тока на линии лампы">
      ток: {lamp.currentOn ? 'есть' : 'нет'}
    </span>
  );
}

/** Hardware checks for the installer and the emergency switch for staff. */
export function HardwarePanel({
  state,
  busy,
  onBlink,
  onManual,
  onAutoPause,
}: {
  state: HubState;
  busy: boolean;
  onBlink: (tableId: string) => void;
  onManual: (enabled: boolean, reason?: string) => void;
  onAutoPause: (enabled: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const mode = state.manualMode;
  const polled = state.tables.some((t) => t.lamp.polledAt != null);
  const power = state.power;

  return (
    <details className="panel hw">
      <summary>
        <h2>Оборудование</h2>
        {mode.enabled && <span className="tag tag-warn">ручной режим</span>}
      </summary>

      <p className="hint">
        «Мигнуть» — лампа над столом мигнёт три раза: так проверяют, что реле подключено к нужному столу.
        {polled ? ' Датчик тока показывает, горит ли свет на самом деле.' : ' Контроллер ещё не опрошен.'}
      </p>
      <ul className="hw-tables">
        {state.tables.map((t) => (
          <li key={t.id}>
            <span className="hw-name">{t.name}</span>
            <span className="lamp" data-lamp={t.lamp.reported.toLowerCase()}>
              <span className="lamp-dot" aria-hidden="true" />
              {t.lamp.reported === 'UNKNOWN' ? 'нет ответа' : t.lamp.reported === 'ON' ? 'вкл' : 'выкл'}
            </span>
            <SensorBadge lamp={t.lamp} />
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => onBlink(t.id)}>
              Мигнуть
            </button>
          </li>
        ))}
      </ul>

      {power.configured && (
        <div className="hw-manual">
          <h3>Электричество</h3>
          <p className="hint">
            {!power.reachable
              ? `ИБП не отвечает (${power.label ?? ''}).`
              : power.onBattery
                ? `Клуб работает от батареи ИБП${power.chargePercent !== null ? `, заряд ${Math.round(power.chargePercent)}%` : ''}.`
                : `Сеть в норме${power.model ? `, ИБП ${power.model}` : ''}${power.chargePercent !== null ? `, заряд ${Math.round(power.chargePercent)}%` : ''}.`}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={power.settings.autoPauseOnPowerLoss}
              disabled={busy}
              onChange={(e) => onAutoPause(e.target.checked)}
            />
            При отключении света ставить все игры на паузу, при возврате — продолжать
          </label>
        </div>
      )}

      <div className="hw-manual">
        <h3>Ручной режим</h3>
        {mode.enabled ? (
          <>
            <p className="hint">
              Включён{mode.since != null ? ` в ${formatClock(mode.since, state.club.timezone)}` : ''}
              {mode.by ? ` (${mode.by})` : ''}. Причина: {mode.reason}
            </p>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => onManual(false)}>
              Выключить — только управляющий
            </button>
          </>
        ) : (
          <>
            <p className="hint">
              Если контроллер сломан: игры открываются без ожидания лампы, свет включают ключом в щитке. Каждая такая игра
              помечается в аудите.
            </p>
            <label className="field">
              Причина
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Например: контроллер не отвечает"
                maxLength={300}
              />
            </label>
            <button
              type="button"
              className="btn btn-small btn-warn"
              disabled={busy || reason.trim().length < 3}
              onClick={() => {
                onManual(true, reason.trim());
                setReason('');
              }}
            >
              Включить ручной режим
            </button>
          </>
        )}
      </div>
    </details>
  );
}
