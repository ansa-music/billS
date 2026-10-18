import { useCallback, useEffect, useState } from 'react';
import type { HubState } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import type { SimulatorStatus } from './api.ts';
import { fetchSimulator, updateSimulator } from './api.ts';
import { formatClock, formatMinutes } from './format.ts';

export function AlertsBar({
  alerts,
  timezone,
  busy,
  onResolve,
}: {
  alerts: HubState['alerts'];
  timezone: string;
  busy: boolean;
  onResolve: (id: string) => void;
}) {
  if (alerts.length === 0) return null;
  return (
    <section className="alerts" aria-label="Тревоги">
      {alerts.map((a) => (
        <div key={a.id} className="alert" role="alert">
          <span className="alert-time">{formatClock(a.at, timezone)}</span>
          <span className="alert-text">{a.message}</span>
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => onResolve(a.id)}>
            Принято
          </button>
        </div>
      ))}
    </section>
  );
}

export function UnpaidPanel({ state }: { state: HubState }) {
  const names = new Map(state.tables.map((t) => [t.id, t.name]));
  const total = state.unpaid.reduce((sum, s) => sum + (s.amount ?? 0), 0);
  return (
    <section className="panel" aria-labelledby="unpaid-title">
      <header className="panel-head">
        <h2 id="unpaid-title">Ожидают оплаты</h2>
        <span className="panel-total">{formatMoney(total, state.club.currency)}</span>
      </header>
      {state.unpaid.length === 0 ? (
        <p className="empty">Неоплаченных игр нет</p>
      ) : (
        <ul className="unpaid">
          {state.unpaid.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{names.get(s.tableId) ?? 'Стол'}</strong>
                <span className="muted">
                  {s.startedAt != null && formatClock(s.startedAt, state.club.timezone)}–
                  {s.stoppedAt != null && formatClock(s.stoppedAt, state.club.timezone)} ·{' '}
                  {formatMinutes(s.playedSeconds ?? 0)}
                </span>
              </div>
              <span className="unpaid-amount">{formatMoney(s.amount ?? 0, state.club.currency)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">Приём оплаты и кассовая смена — следующий этап.</p>
    </section>
  );
}

/** Development only: drives the lamp simulator in the HUB. Hidden when the HUB has no simulator. */
export function SimulatorPanel({ onError }: { onError: (message: string) => void }) {
  const [sim, setSim] = useState<SimulatorStatus | null | undefined>(undefined);

  const load = useCallback(() => {
    fetchSimulator()
      .then(setSim)
      .catch(() => setSim(null));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  if (!sim) return null;

  const patch = (p: Parameters<typeof updateSimulator>[0]) =>
    updateSimulator(p)
      .then(setSim)
      .catch((e: Error) => onError(e.message));

  return (
    <details className="panel sim">
      <summary>
        <h2>Симулятор ламп</h2>
        {sim.offline && <span className="tag tag-danger">контроллер отключён</span>}
      </summary>
      <label className="check">
        <input type="checkbox" checked={sim.offline} onChange={(e) => patch({ offline: e.target.checked })} />
        Контроллер отключён (нет связи)
      </label>
      <label className="field">
        Задержка ответа, мс
        <input
          type="number"
          min={0}
          max={60000}
          step={100}
          value={sim.latencyMs}
          onChange={(e) => patch({ latencyMs: Number(e.target.value) })}
        />
      </label>
      <div className="row wrap">
        <button type="button" className="btn btn-small" onClick={() => patch({ faults: ['fail'] })}>
          Сбой следующей команды
        </button>
        <button type="button" className="btn btn-small" onClick={() => patch({ faults: ['drop-ack'] })}>
          Потерять подтверждение
        </button>
        {sim.faults.length > 0 && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => patch({ clearFaults: true })}>
            Сбросить ({sim.faults.length})
          </button>
        )}
      </div>
      <p className="hint">
        Датчик тока: «руками» — свет включили мимо реле (через минуту тревога «свет без игры»), «сгорела» — ток не
        течёт при игре (тревога «лампа не горит»). «Опросить» — не ждать 10 секунд.
      </p>
      <ul className="relays relays-wide">
        {Object.entries(sim.lamps)
          .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
          .map(([channel, on]) => {
            const light = sim.lights[channel];
            return (
              <li key={channel} data-on={on || undefined}>
                <span className="lamp-dot" aria-hidden="true" />
                {channel}
                <span className="sim-light" role="group" aria-label={`Датчик тока ${channel}`}>
                  <button
                    type="button"
                    aria-pressed={light === undefined}
                    title="Датчик следует за реле"
                    onClick={() => patch({ light: { channel, on: null } })}
                  >
                    авто
                  </button>
                  <button
                    type="button"
                    aria-pressed={light === true}
                    title="Свет включили руками, мимо реле"
                    onClick={() => patch({ light: { channel, on: true } })}
                  >
                    руками
                  </button>
                  <button
                    type="button"
                    aria-pressed={light === false}
                    title="Лампа сгорела: тока нет"
                    onClick={() => patch({ light: { channel, on: false } })}
                  >
                    сгорела
                  </button>
                </span>
              </li>
            );
          })}
      </ul>
      <div className="row wrap">
        <button type="button" className="btn btn-small btn-ghost" onClick={() => patch({ poll: true })}>
          Опросить датчики сейчас
        </button>
      </div>
    </details>
  );
}
