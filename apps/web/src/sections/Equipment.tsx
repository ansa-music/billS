import { useCallback, useEffect, useState } from 'react';
import type { LampDetail } from '@bills/domain';
import type { SimulatorStatus } from '../api.ts';
import { fetchLamps, fetchSimulator, updateSimulator } from '../api.ts';
import { EmptyState, SectionCard, StatTile } from '../components.tsx';
import { formatAgo, lampErrorText } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useHub, useLive } from '../useHub.ts';

const COMMAND_STATUS: Record<NonNullable<LampDetail['lastCommand']>['status'], string> = {
  PENDING: 'отправляется',
  ACKED: 'подтверждена',
  FAILED: 'не выполнена',
  SUPERSEDED: 'заменена новой',
};

function LampCard({ l, now }: { l: LampDetail; now: number }) {
  const problem = l.reported === 'UNKNOWN';
  const cmd = l.lastCommand;
  return (
    <article className="lamp-card" data-problem={problem || undefined}>
      <header className="lamp-card-head">
        <span className="bulb" data-state={l.reported.toLowerCase()} aria-hidden="true">
          <Icon name="lamp" size={20} />
        </span>
        <div className="lamp-card-title">
          <strong>{l.tableName}</strong>
          <span>{l.channel}</span>
        </div>
      </header>
      <dl className="lamp-facts">
        <dt>Должна</dt>
        <dd>{l.desired === 'ON' ? 'гореть' : 'быть выключена'}</dd>
        <dt>На деле</dt>
        <dd>
          {l.reported === 'ON' ? 'горит' : l.reported === 'OFF' ? 'выключена' : 'нет ответа'}
          {l.reportedAt && l.reported !== 'UNKNOWN' ? ` · ${formatAgo(now - l.reportedAt)}` : ''}
        </dd>
        {cmd && (
          <>
            <dt>Команда</dt>
            <dd>
              {cmd.action === 'ON' ? 'включить' : 'выключить'} — {COMMAND_STATUS[cmd.status]}
              {cmd.status === 'ACKED' && cmd.attempts > 1 ? ` с ${cmd.attempts}-й попытки` : ''}
              {cmd.status === 'FAILED' ? ` после ${cmd.attempts} попыток` : ''}
              {cmd.status === 'PENDING' && cmd.attempts > 0 ? ` · попытка ${cmd.attempts + 1}` : ''}
            </dd>
            {cmd.lastError && cmd.status !== 'ACKED' && (
              <>
                <dt>Ошибка</dt>
                <dd>{lampErrorText(cmd.lastError)}</dd>
              </>
            )}
          </>
        )}
      </dl>
    </article>
  );
}

function SimulatorCard() {
  const { notify, version } = useHub();
  const [sim, setSim] = useState<SimulatorStatus | null | undefined>(undefined);
  const load = useCallback(() => {
    fetchSimulator()
      .then(setSim)
      .catch(() => setSim(null));
  }, []);
  useEffect(load, [load, version]);
  useEffect(() => {
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  if (sim === undefined) return null;
  if (sim === null) {
    return (
      <SectionCard title="Контроллер ламп">
        <p className="hint">Подключён настоящий контроллер. Его настройки появятся на этапе 5.</p>
      </SectionCard>
    );
  }

  const patch = (p: Parameters<typeof updateSimulator>[0]) =>
    updateSimulator(p)
      .then(setSim)
      .catch((e: Error) => notify(e.message));

  return (
    <SectionCard
      title={
        <>
          <Icon name="plug" size={18} /> Симулятор контроллера
        </>
      }
      actions={
        <span className="status-badge" data-tone={sim.offline ? 'danger' : 'good'}>
          <Icon name={sim.offline ? 'alert' : 'check'} size={14} />
          {sim.offline ? 'отключён' : 'на связи'}
        </span>
      }
    >
      <p className="hint">
        Вместо настоящего реле работает симулятор: так можно проверить отказы без железа. На этапе 5 его заменит контроллер
        ESP32/Modbus.
      </p>
      <div className="sim-controls">
        <label className="check">
          <input type="checkbox" checked={sim.offline} onChange={(e) => void patch({ offline: e.target.checked })} />
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
            onChange={(e) => void patch({ latencyMs: Number(e.target.value) })}
          />
        </label>
        <div className="row wrap">
          <button type="button" className="btn btn-small" onClick={() => void patch({ faults: ['fail'] })}>
            Сбой следующей команды
          </button>
          <button type="button" className="btn btn-small" onClick={() => void patch({ faults: ['drop-ack'] })}>
            Потерять подтверждение
          </button>
          {sim.faults.length > 0 && (
            <button type="button" className="btn btn-small btn-ghost" onClick={() => void patch({ clearFaults: true })}>
              Сбросить ({sim.faults.length})
            </button>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

export function EquipmentSection() {
  const hub = useHub();
  const lamps = useLive(fetchLamps, [], hub.version);
  const list = lamps.data ?? [];
  const on = list.filter((l) => l.reported === 'ON').length;
  const unknown = list.filter((l) => l.reported === 'UNKNOWN').length;
  const pending = list.filter((l) => l.lastCommand?.status === 'PENDING').length;
  const loaded = lamps.data !== null;
  const show = (n: number) => (loaded ? n : '…');

  return (
    <div className="page">
      <div className="stat-row">
        <StatTile label="Ламп" value={show(list.length)} detail="по одной на стол" />
        <StatTile label="Горят" value={show(on)} detail={loaded ? `из ${list.length}` : undefined} />
        <StatTile
          label="Без ответа"
          value={show(unknown)}
          detail={!loaded ? undefined : unknown ? 'HUB повторяет команду раз в минуту' : 'все отвечают'}
          tone={unknown ? 'danger' : undefined}
        />
        <StatTile label="Команд в пути" value={show(pending)} detail={!loaded ? undefined : pending ? 'ждём подтверждения' : 'очередь пуста'} />
      </div>
      <div className="two-col">
        <SectionCard title="Лампы столов">
          {lamps.data === null ? (
            <p className="hint">{lamps.error ?? 'Загрузка…'}</p>
          ) : list.length === 0 ? (
            <EmptyState icon="lamp" title="Столов нет" />
          ) : (
            <div className="lamp-grid">
              {list.map((l) => (
                <LampCard key={l.tableId} l={l} now={hub.serverNow} />
              ))}
            </div>
          )}
        </SectionCard>
        <SimulatorCard />
      </div>
    </div>
  );
}
