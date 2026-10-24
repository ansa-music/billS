import { useState } from 'react';
import type { ManualModeView, TableView } from '@bills/domain';
import { blinkTable, setManualMode, setPowerSettings } from './api.ts';
import { SectionCard } from './components.tsx';
import { formatClock } from './format.ts';
import { Icon } from './icons.tsx';
import { useHub } from './useHub.tsx';
import './hall.css';

/**
 * Yellow banner while the HUB is in manual (emergency) mode: the relay
 * controller is broken, staff switch lamps by hand, games start at the button.
 * Shown by the shell on every page.
 */
export function ManualModeBanner({
  mode,
  timezone,
  busy,
  canDisable,
  onDisable,
}: {
  mode: ManualModeView;
  timezone: string;
  busy: boolean;
  /** `lamps.manual_off`: manager, administrator or senior shift; others see who can. */
  canDisable: boolean;
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
      {canDisable ? (
        <button type="button" className="btn btn-small hall-manual-btn" disabled={busy} onClick={onDisable}>
          Выключить ручной режим
        </button>
      ) : (
        <span className="hall-manual-who">{MANUAL_OFF_WHO}</span>
      )}
    </div>
  );
}

/** Who may switch manual mode off (`lamps.manual_off` in packages/domain/src/permissions.ts). */
const MANUAL_OFF_WHO = 'Выключить может управляющий, администратор или старший смены';

function SensorBadge({ lamp }: { lamp: TableView['lamp'] }) {
  if (lamp.currentOn === null) return <span className="muted">датчик: —</span>;
  const bad = lamp.currentOn !== (lamp.reported === 'ON');
  return (
    <span className={bad ? 'hw-sensor hw-sensor-bad' : 'hw-sensor'} title="Датчик тока на линии лампы">
      ток: {lamp.currentOn ? 'есть' : 'нет'}
    </span>
  );
}

/**
 * Hardware checks for the installer and the emergency switch for staff:
 * «Мигнуть» per table, the UPS and its auto-pause setting, manual mode.
 * Lives on the «Оборудование» page; commands go through the hub context.
 */
export function HardwarePanel() {
  const hub = useHub();
  const { state, actor } = hub;
  const canTurnOff = hub.canNow('lamps.manual_off');
  const canTurnOn = hub.canNow('lamps.manual');
  const [reason, setReason] = useState('');
  const mode = state.manualMode;
  const polled = state.tables.some((t) => t.lamp.polledAt != null);
  const power = state.power;
  const busy = hub.isBusy('manual') || !hub.online;

  const blink = (tableId: string) => void hub.run(`blink:${tableId}`, () => blinkTable(tableId, actor));
  const manual = (enabled: boolean, why?: string) => void hub.run('manual', () => setManualMode(actor, enabled, why));
  const autoPause = (enabled: boolean) =>
    void hub.run('manual', () => setPowerSettings(actor, { autoPauseOnPowerLoss: enabled }));

  return (
    <SectionCard
      title={
        <>
          <Icon name="equipment" size={18} /> Проверка и аварийный режим
        </>
      }
      actions={mode.enabled ? <span className="tag tag-warn">ручной режим</span> : undefined}
    >
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
            <button
              type="button"
              className="btn btn-small"
              disabled={!hub.online || hub.isBusy(`blink:${t.id}`)}
              onClick={() => blink(t.id)}
            >
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
            {power.autoPausedSessions > 0 && ` Игр на автопаузе: ${power.autoPausedSessions}.`}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={power.settings.autoPauseOnPowerLoss}
              disabled={busy}
              onChange={(e) => autoPause(e.target.checked)}
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
            {canTurnOff ? (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => manual(false)}>
                Выключить ручной режим
              </button>
            ) : (
              <p className="hint">{MANUAL_OFF_WHO}.</p>
            )}
          </>
        ) : (
          <>
            <p className="hint">
              Если контроллер света сломан: игры открываются без ожидания лампы, свет включают ключом в щитке. Каждая такая
              игра отмечается в журнале.
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
              disabled={busy || !canTurnOn || reason.trim().length < 3}
              onClick={() => {
                manual(true, reason.trim());
                setReason('');
              }}
            >
              Включить ручной режим
            </button>
          </>
        )}
      </div>
    </SectionCard>
  );
}
