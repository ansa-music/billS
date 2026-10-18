import { useEffect, useMemo, useState } from 'react';
import type { AlertView, HubState, SessionView, TableView, TariffConfig } from '@bills/domain';
import { calculateCharge, formatMoney, nextPriceChange, priceAt } from '@bills/domain';
import { formatClock, formatDuration, KIND_LABEL } from './format.ts';
import { hasProblem, tablePhase } from './hall.ts';
import { DurationSelect, PrepaidButton } from './prepaid/OpenControls.tsx';
import { PrepaidBadge } from './prepaid/PrepaidBadge.tsx';

const HOUR = 60 * 60 * 1000;
/** After this long without a lamp confirmation staff are told the HUB is retrying. */
const SLOW_LAMP_MS = 4000;

interface Props {
  table: TableView;
  tariffs: HubState['tariffs'];
  timezone: string;
  currency: string;
  serverNow: number;
  busy: boolean;
  alert: AlertView | undefined;
  /** A cash shift is open: prepaid games can be paid. */
  shiftOpen: boolean;
  /** `prepaidMinutes` opens it for a fixed time (paid after); null — no limit. */
  onOpen: (tariffId: string, prepaidMinutes: number | null) => void;
  /** Opens the prepaid dialog with the tariff and time picked on the card. */
  onPrepaid: (tariffId: string, minutes: number | null) => void;
  onStop: (sessionId: string) => void;
}

const PHASE_LABEL = { free: 'Свободен', opening: 'Включаем свет', playing: 'Идёт игра' } as const;

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

/** Rate now and, if it changes within the hour, when and to what. Recomputed once a minute. */
function useRate(tariff: TariffConfig | undefined, timezone: string, at: number) {
  const minute = Math.floor(at / 60_000);
  return useMemo(() => {
    if (!tariff) return null;
    const t = minute * 60_000;
    return { now: priceAt(t, tariff, timezone), next: nextPriceChange(t, tariff, timezone, HOUR) };
  }, [tariff, timezone, minute]);
}

function RateLine(props: {
  tariffName: string;
  tariff: TariffConfig | undefined;
  timezone: string;
  currency: string;
  at: number;
  suffix?: string;
  /** A running game: the change affects its bill, so it stands out. */
  emphasizeNext?: boolean;
}) {
  const rate = useRate(props.tariff, props.timezone, props.at);
  if (!rate) return null;
  return (
    <>
      <p className="hint">
        {props.tariffName} · {rate.now.label} {formatMoney(rate.now.pricePerHour, props.currency)}/ч{props.suffix}
      </p>
      {rate.next && (
        <p className={props.emphasizeNext ? 'price-next' : 'hint'}>
          с {formatClock(rate.next.at, props.timezone)} — {rate.next.label}{' '}
          {formatMoney(rate.next.pricePerHour, props.currency)}/ч
        </p>
      )}
    </>
  );
}

export function TableCard(props: Props) {
  const { table, alert } = props;
  const phase = tablePhase(table);
  const problem = hasProblem(table, alert);
  const session = table.session;

  return (
    <article className="card" data-state={phase} data-problem={problem || undefined} aria-label={table.name}>
      <div className="felt">
        <div className="felt-title">
          <h2>{table.name}</h2>
          <span className="kind">{KIND_LABEL[table.kind]}</span>
        </div>
        <div className="felt-foot">
          <LampBadge lamp={table.lamp} />
          <span className="phase" data-phase={phase}>
            {PHASE_LABEL[phase]}
          </span>
        </div>
      </div>

      {problem && (
        <p className="card-alert" role="alert">
          {alert?.message ?? 'Лампа не ответила — проверьте свет на столе'}
        </p>
      )}

      {phase === 'free' && <FreeBody {...props} />}
      {phase === 'opening' && session && <OpeningBody {...props} session={session} />}
      {phase === 'playing' && session?.startedAt != null && (
        <PlayingBody {...props} session={session} startedAt={session.startedAt} />
      )}
    </article>
  );
}

function FreeBody({ table, tariffs, timezone, currency, serverNow, busy, shiftOpen, onOpen, onPrepaid }: Props) {
  const [tariffId, setTariffId] = useState(table.defaultTariffId);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const tariff = tariffs.find((t) => t.id === tariffId) ?? tariffs.find((t) => t.id === table.defaultTariffId);
  const custom = tariffId !== table.defaultTariffId;
  // An OFF command is on its way; a real "light without a game" alarm comes from the HUB as an alert.
  const switchingOff = table.lamp.reported === 'ON' && table.lamp.desired === 'OFF';

  return (
    <div className="card-body">
      {tariff && (
        <RateLine
          tariffName={tariff.name}
          tariff={tariff.config}
          timezone={timezone}
          currency={currency}
          at={serverNow}
          suffix=" сейчас"
        />
      )}
      {switchingOff && <p className="hint">Выключаем свет…</p>}

      {tariffs.length > 1 && picking && (
        <div className="tariff-chips" role="group" aria-label="Тариф">
          {tariffs.map((t) => (
            <button
              key={t.id}
              type="button"
              className="chip"
              aria-pressed={t.id === tariffId}
              onClick={() => {
                setTariffId(t.id);
                setPicking(false);
              }}
            >
              {t.name}
              {t.id === table.defaultTariffId && <span className="chip-note"> · обычный</span>}
            </button>
          ))}
        </div>
      )}

      <div className="actions">
        <DurationSelect value={minutes} onChange={setMinutes} disabled={busy} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onOpen(tariffId, minutes)}>
          {custom && tariff ? `Открыть · ${tariff.name}` : 'Открыть'}
        </button>
        <PrepaidButton shiftOpen={shiftOpen} disabled={busy} onClick={() => onPrepaid(tariffId, minutes)} />
        {tariffs.length > 1 && !picking && (
          <button type="button" className="link" onClick={() => setPicking(true)} disabled={busy}>
            {custom ? 'Сменить тариф' : 'Другой тариф'}
          </button>
        )}
      </div>
    </div>
  );
}

function OpeningBody({ session, serverNow, currency, busy, onStop }: Props & { session: SessionView }) {
  const waited = Math.max(0, serverNow - session.requestedAt);
  return (
    <div className="card-body">
      <p className="status">
        <span className="spinner" aria-hidden="true" /> Включаем свет… {Math.floor(waited / 1000)} с
      </p>
      {session.prepaid && (
        <PrepaidBadge prepaid={session.prepaid} serverNow={serverNow} timezone={session.timezone} currency={currency} />
      )}
      <p className="hint">
        {waited >= SLOW_LAMP_MS
          ? 'Контроллер отвечает медленно — HUB повторяет команду'
          : 'Время пойдёт, когда лампа подтвердит включение'}
      </p>
      <div className="actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onStop(session.id)}>
          Отменить
        </button>
      </div>
    </div>
  );
}

function PlayingBody({
  session,
  startedAt,
  serverNow,
  currency,
  busy,
  onStop,
}: Props & { session: SessionView; startedAt: number }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const prepaid = session.prepaid ?? null;
  // Paid upfront: the running amount is not what the guest owes.
  const paidUpfront = prepaid?.amount != null;
  // A timed game ends at its deadline even if the HUB's stop has not reached the screen yet.
  const end = Math.max(Math.min(serverNow, prepaid?.until ?? serverNow), startedAt);
  const charge = calculateCharge(startedAt, end, session.tariff, session.timezone);
  const { freeMinutes, minimumMinutes } = session.tariff;
  const inFreeMinutes = freeMinutes > 0 && charge.billedSeconds === 0;
  const freeLeft = freeMinutes * 60 - charge.playedSeconds;
  const note = inFreeMinutes
    ? `бесплатно ещё ${Math.floor(freeLeft / 60)}:${String(freeLeft % 60).padStart(2, '0')}`
    : minimumMinutes > 0 && charge.playedSeconds < minimumMinutes * 60
      ? `минимум ${minimumMinutes} мин`
      : null;
  const amount = formatMoney(charge.amount, currency);

  return (
    <div className="card-body">
      <p className="timer" aria-label="Время игры">
        {formatDuration(end - startedAt)}
      </p>
      {prepaid && (
        <PrepaidBadge prepaid={prepaid} serverNow={serverNow} timezone={session.timezone} currency={currency} />
      )}
      {!paidUpfront && (
        <p className="amount">
          {amount}
          {note && <span className="amount-note">{note}</span>}
        </p>
      )}
      <p className="card-meta">
        с {formatClock(startedAt, session.timezone)} · открыл {session.openedBy}
      </p>
      <RateLine
        tariffName={session.tariffName}
        tariff={session.tariff}
        timezone={session.timezone}
        currency={currency}
        at={end}
        emphasizeNext
      />
      {inFreeMinutes && !paidUpfront && <p className="tip">Ошиблись столом? «Стоп» сейчас — без оплаты.</p>}

      <div className="actions">
        {confirming ? (
          <>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => onStop(session.id)}>
              {paidUpfront ? 'Остановить досрочно' : `Остановить · ${amount}`}
            </button>
            <button type="button" className="btn btn-ghost btn-narrow" onClick={() => setConfirming(false)}>
              Нет
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-outline-danger" disabled={busy} onClick={() => setConfirming(true)}>
            Стоп
          </button>
        )}
      </div>
    </div>
  );
}
