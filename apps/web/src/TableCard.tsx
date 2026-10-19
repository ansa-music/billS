import { useEffect, useMemo, useState } from 'react';
import type { AlertView, HubState, SessionView, TableView, TariffConfig } from '@bills/domain';
import {
  calculateChargeWithPauses,
  formatMoney,
  nextPriceChange,
  pauseLimits,
  pauseRefusal,
  pauseUsage,
  priceAt,
  unpaidSpans,
} from '@bills/domain';
import { formatClock, formatDuration, formatPause, KIND_LABEL } from './format.ts';
import { hasProblem, tablePhase } from './hall.ts';
import { DurationSelect, PrepaidButton } from './prepaid/OpenControls.tsx';
import { PrepaidBadge } from './prepaid/PrepaidBadge.tsx';

const HOUR = 60 * 60 * 1000;
/** After this long without a lamp confirmation staff are told the HUB is retrying. */
const SLOW_LAMP_MS = 4000;

interface Props {
  table: TableView;
  /** Every table of the hall: a game can be moved to a free one. */
  tables: TableView[];
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
  onPause: (sessionId: string) => void;
  onResume: (sessionId: string) => void;
  onTransfer: (sessionId: string, toTableId: string) => void;
  /** Opens the table's details panel. */
  onDetails?: () => void;
  /**
   * Why a new game cannot be opened right now (no right, read-only license);
   * the open buttons are replaced by this note. null/undefined — they work.
   */
  openBlocked?: string | null;
  /** Pause, resume and transfer (`table.continue`); default true. */
  canContinue?: boolean;
}

export type TableCardProps = Props;

export const PHASE_LABEL = {
  free: 'Свободен',
  opening: 'Включаем свет',
  playing: 'Идёт игра',
  paused: 'На паузе',
} as const;

export function LampBadge({ lamp }: { lamp: TableView['lamp'] }) {
  const switching = !lamp.blink && lamp.reported !== lamp.desired;
  // The current sensor disagrees with the relay: a dead bulb or a bypassed relay.
  // A blinking lamp (paused game) is never judged by its sensor.
  const sensorOff =
    !lamp.blink && lamp.currentOn !== null && !switching && lamp.currentOn !== (lamp.reported === 'ON');
  const label = lamp.blink
    ? 'Свет мигает'
    : lamp.reported === 'UNKNOWN'
      ? 'Свет: нет ответа'
      : sensorOff
        ? lamp.reported === 'ON'
          ? 'Свет включён, тока нет'
          : 'Свет горит без команды'
        : lamp.reported === 'ON'
          ? 'Свет включён'
          : 'Свет выключен';
  return (
    <span
      className="lamp"
      data-lamp={lamp.reported.toLowerCase()}
      data-switching={switching || undefined}
      data-blink={lamp.blink || undefined}
      title={label}
    >
      <span className="lamp-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Rate now and, if it changes within the hour, when and to what. Recomputed once a minute. */
export function useRate(tariff: TariffConfig | undefined, timezone: string, at: number) {
  const minute = Math.floor(at / 60_000);
  return useMemo(() => {
    if (!tariff) return null;
    const t = minute * 60_000;
    return { now: priceAt(t, tariff, timezone), next: nextPriceChange(t, tariff, timezone, HOUR) };
  }, [tariff, timezone, minute]);
}

export function RateLine(props: {
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

/**
 * The bill of a live game as of `serverNow`: play minus pauses, an open pause
 * running until now. Pause time over the tariff budget counts as play.
 */
/** `until` (a prepaid deadline) caps the clock: the game ends there even before the HUB's stop reaches the screen. */
function useLiveCharge(session: SessionView, startedAt: number, serverNow: number, until: number | null = null) {
  const end = Math.max(Math.min(serverNow, until ?? serverNow), startedAt);
  const charge = calculateChargeWithPauses(
    startedAt,
    end,
    unpaidSpans(session.pauses, session.tariff, end),
    session.tariff,
    session.timezone,
  );
  const { freeMinutes, minimumMinutes } = session.tariff;
  const inFreeMinutes = freeMinutes > 0 && charge.billedSeconds === 0;
  const freeLeft = freeMinutes * 60 - charge.playedSeconds;
  const note = inFreeMinutes
    ? `бесплатно ещё ${Math.floor(freeLeft / 60)}:${String(freeLeft % 60).padStart(2, '0')}`
    : minimumMinutes > 0 && charge.playedSeconds < minimumMinutes * 60
      ? `минимум ${minimumMinutes} мин`
      : null;
  return { end, charge, inFreeMinutes, note };
}

/** «Стоп» arms a confirmation that disarms itself after a few seconds. */
function useStopConfirm() {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(t);
  }, [confirming]);
  return { confirming, arm: () => setConfirming(true), disarm: () => setConfirming(false) };
}

function StopControls({
  confirm,
  amount,
  busy,
  label,
  onStop,
}: {
  confirm: ReturnType<typeof useStopConfirm>;
  amount: string;
  busy: boolean;
  /** Replaces «Остановить · сумма» (a game paid upfront owes nothing more). */
  label?: string | undefined;
  onStop: () => void;
}) {
  if (confirm.confirming) {
    return (
      <>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={onStop}>
          {label ?? `Остановить · ${amount}`}
        </button>
        <button type="button" className="btn btn-ghost btn-narrow" onClick={confirm.disarm}>
          Нет
        </button>
      </>
    );
  }
  return (
    <button type="button" className="btn btn-outline-danger" disabled={busy} onClick={confirm.arm}>
      Стоп
    </button>
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
          {props.onDetails && (
            <button type="button" className="felt-more" onClick={props.onDetails} aria-label={`${table.name}: подробнее`}>
              Подробнее
            </button>
          )}
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
      {phase === 'paused' && session?.startedAt != null && (
        <PausedBody {...props} session={session} startedAt={session.startedAt} />
      )}
    </article>
  );
}

function FreeBody({ table, tariffs, timezone, currency, serverNow, busy, shiftOpen, onOpen, onPrepaid, openBlocked }: Props) {
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

      {openBlocked ? (
        <p className="blocked-note">{openBlocked}</p>
      ) : (
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
      )}
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
  table,
  tables,
  session,
  startedAt,
  serverNow,
  currency,
  busy,
  onStop,
  onPause,
  onTransfer,
  canContinue = true,
}: Props & { session: SessionView; startedAt: number }) {
  const confirm = useStopConfirm();
  const [movePicking, setMovePicking] = useState(false);
  const prepaid = session.prepaid ?? null;
  // Paid upfront: the running amount is not what the guest owes.
  const paidUpfront = prepaid?.amount != null;
  // A timed game ends at its deadline even if the HUB's stop has not reached the screen yet.
  const { end, charge, inFreeMinutes, note } = useLiveCharge(session, startedAt, serverNow, prepaid?.until ?? null);
  const amount = formatMoney(charge.amount, currency);
  const refusal = pauseRefusal(session.pauses, session.tariff, end);
  const freeTables = tables.filter((t) => t.id !== table.id && t.session === null);

  return (
    <div className="card-body">
      <p className="timer" aria-label="Сыграно">
        {formatDuration(charge.playedSeconds * 1000)}
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
        {charge.pausedSeconds > 0 && ` · пауз ${formatPause(charge.pausedSeconds * 1000)}`}
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

      {movePicking && (
        <div className="transfer">
          <p className="hint">Перенести игру на стол:</p>
          {freeTables.length === 0 ? (
            <p className="hint">Свободных столов нет</p>
          ) : (
            <div className="tariff-chips transfer-chips" role="group" aria-label="Куда перенести">
              {freeTables.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="chip"
                  disabled={busy}
                  onClick={() => {
                    setMovePicking(false);
                    onTransfer(session.id, t.id);
                  }}
                >
                  {t.name}
                  <span className="chip-note"> · {KIND_LABEL[t.kind]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="actions">
        {!confirm.confirming && canContinue && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || refusal !== null}
            title={refusal ?? undefined}
            onClick={() => onPause(session.id)}
          >
            Пауза
          </button>
        )}
        <StopControls
          confirm={confirm}
          amount={amount}
          busy={busy}
          label={paidUpfront ? 'Остановить досрочно' : undefined}
          onStop={() => onStop(session.id)}
        />
        {!confirm.confirming && canContinue && (
          <button type="button" className="link" disabled={busy} onClick={() => setMovePicking((v) => !v)}>
            {movePicking ? 'Не переносить' : 'Перенести'}
          </button>
        )}
      </div>
      {refusal && !confirm.confirming && canContinue && <p className="hint">{refusal}</p>}
    </div>
  );
}

function PausedBody({
  session,
  startedAt,
  serverNow,
  currency,
  busy,
  onStop,
  onResume,
  canContinue = true,
}: Props & { session: SessionView; startedAt: number }) {
  const confirm = useStopConfirm();
  const { end, charge, note } = useLiveCharge(session, startedAt, serverNow);
  const amount = formatMoney(charge.amount, currency);

  const current = session.pauses.find((p) => p.to === null) ?? session.pauses.at(-1);
  const transferring = current?.reason === 'transfer';
  const powerLoss = current?.reason === 'power';
  const pausedAt = session.pausedAt ?? current?.from ?? end;
  const pausedFor = Math.max(0, end - pausedAt);

  const limits = pauseLimits(session.tariff);
  const usage = pauseUsage(session.pauses, end);
  const pausesLeft = Math.max(0, limits.maxPauses - usage.count);
  const budgetSeconds = limits.maxPauseMinutes * 60;
  const secondsLeft = Math.max(0, budgetSeconds - usage.seconds);
  // Only staff pauses spend the budget; a transfer or a power loss is never billed.
  const overBudget = !transferring && !powerLoss && usage.seconds >= budgetSeconds;
  const resuming = session.resumeRequestedAt != null;

  return (
    <div className="card-body">
      <p className="timer" aria-label="Сыграно">
        {formatDuration(charge.playedSeconds * 1000)}
      </p>
      <p className="status paused-status">
        {transferring ? 'Перенос' : powerLoss ? 'Пауза: нет электричества' : 'На паузе'} ·{' '}
        <span className="paused-for">{formatPause(pausedFor)}</span>
      </p>
      <p className="amount">
        {amount}
        {note && <span className="amount-note">{note}</span>}
      </p>
      <p className="card-meta">
        с {formatClock(startedAt, session.timezone)} · открыл {session.openedBy}
      </p>
      {session.prepaid && (
        <PrepaidBadge
          prepaid={session.prepaid}
          serverNow={serverNow}
          pausedAt={pausedAt}
          timezone={session.timezone}
          currency={currency}
        />
      )}
      {overBudget ? (
        <p className="warn-note" role="status">
          Лимит паузы исчерпан — время снова идёт
        </p>
      ) : (
        <p className="hint">
          осталось пауз: {pausesLeft} · времени: {Math.ceil(secondsLeft / 60)} мин
        </p>
      )}

      {resuming && (
        <>
          <p className="status">
            <span className="spinner" aria-hidden="true" /> Включаем свет…
          </p>
          <p className="hint">
            {transferring
              ? 'Переносим игру — включаем свет на новом столе'
              : 'Время пойдёт, когда лампа подтвердит включение'}
          </p>
        </>
      )}

      <div className="actions">
        {!resuming && !confirm.confirming && canContinue && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onResume(session.id)}>
            Продолжить
          </button>
        )}
        <StopControls confirm={confirm} amount={amount} busy={busy} onStop={() => onStop(session.id)} />
      </div>
    </div>
  );
}
