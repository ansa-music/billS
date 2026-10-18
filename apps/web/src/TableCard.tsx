import { useEffect, useState } from 'react';
import type { HubState, TableView } from '@bills/domain';
import { calculateCharge, formatMoney, priceAt } from '@bills/domain';
import { formatDuration, KIND_LABEL } from './format.ts';

interface Props {
  table: TableView;
  tariffs: HubState['tariffs'];
  currency: string;
  serverNow: number;
  busy: boolean;
  onOpen: (tariffId: string) => void;
  onStop: (sessionId: string) => void;
}

function LampBadge({ lamp }: { lamp: TableView['lamp'] }) {
  const switching = lamp.reported !== lamp.desired;
  const label =
    lamp.reported === 'UNKNOWN' ? 'Свет: нет ответа' : lamp.reported === 'ON' ? 'Свет включён' : 'Свет выключен';
  return (
    <span className="lamp" data-lamp={lamp.reported.toLowerCase()} data-switching={switching || undefined} title={label}>
      <span className="lamp-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function TableCard({ table, tariffs, currency, serverNow, busy, onOpen, onStop }: Props) {
  const session = table.session;
  const state = session?.status === 'ACTIVE' ? 'active' : session?.status === 'OPENING' ? 'opening' : 'free';
  const [tariffId, setTariffId] = useState(table.defaultTariffId);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);
  useEffect(() => setConfirming(false), [session?.id]);

  // A real "light without a game" alarm comes from the HUB as an alert; here the OFF command is on its way.
  const switchingOff = state === 'free' && table.lamp.reported === 'ON' && table.lamp.desired === 'OFF';

  return (
    <article className="card" data-state={state} aria-label={table.name}>
      <div className="felt">
        <div className="felt-title">
          <h2>{table.name}</h2>
          <span className="kind">{KIND_LABEL[table.kind]}</span>
        </div>
        <LampBadge lamp={table.lamp} />
      </div>

      {state === 'free' && (
        <div className="card-body">
          <p className="status">Свободен</p>
          {switchingOff && <p className="hint">Выключаем свет…</p>}
          <div className="row">
            {tariffs.length > 1 && (
              <select
                aria-label="Тариф"
                value={tariffId}
                onChange={(e) => setTariffId(e.target.value)}
                disabled={busy}
              >
                {tariffs.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onOpen(tariffId)}>
              Открыть
            </button>
          </div>
        </div>
      )}

      {state === 'opening' && session && (
        <div className="card-body">
          <p className="status">
            <span className="spinner" aria-hidden="true" /> Включаем свет…
          </p>
          <p className="hint">Время пойдёт, когда лампа подтвердит включение</p>
          <div className="row">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onStop(session.id)}>
              Отменить
            </button>
          </div>
        </div>
      )}

      {state === 'active' && session?.startedAt != null && (
        <ActiveBody
          startedAt={session.startedAt}
          serverNow={serverNow}
          session={session}
          currency={currency}
          busy={busy}
          confirming={confirming}
          onStop={() => (confirming ? onStop(session.id) : setConfirming(true))}
        />
      )}
    </article>
  );
}

function ActiveBody(props: {
  startedAt: number;
  serverNow: number;
  session: NonNullable<TableView['session']>;
  currency: string;
  busy: boolean;
  confirming: boolean;
  onStop: () => void;
}) {
  const { startedAt, serverNow, session, currency } = props;
  const end = Math.max(serverNow, startedAt);
  const charge = calculateCharge(startedAt, end, session.tariff, session.timezone);
  const rate = priceAt(end, session.tariff, session.timezone);
  const { freeMinutes, minimumMinutes } = session.tariff;
  const note =
    freeMinutes > 0 && charge.billedSeconds === 0
      ? `Первые ${freeMinutes} мин бесплатно`
      : minimumMinutes > 0 && charge.playedSeconds < minimumMinutes * 60
        ? `Минимум ${minimumMinutes} мин`
        : null;
  return (
    <div className="card-body">
      <p className="timer" aria-label="Время игры">
        {formatDuration(end - startedAt)}
      </p>
      <p className="amount">
        {formatMoney(charge.amount, currency)}
        {note && <span className="amount-note">{note}</span>}
      </p>
      <p className="hint">
        {session.tariffName} · {rate.label} {formatMoney(rate.pricePerHour, currency)}/ч
      </p>
      <div className="row">
        <button
          type="button"
          className={`btn ${props.confirming ? 'btn-danger' : 'btn-outline-danger'}`}
          disabled={props.busy}
          onClick={props.onStop}
        >
          {props.confirming ? 'Точно остановить?' : 'Стоп'}
        </button>
      </div>
    </div>
  );
}
