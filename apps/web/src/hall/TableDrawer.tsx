import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
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
import { Drawer, StatusBadge } from '../components.tsx';
import { formatClock, formatDuration, formatPause, formatSpan, KIND_LABEL } from '../format.ts';
import { tablePhase } from '../hall.ts';
import { Icon } from '../icons.tsx';
import { ExtendDialog } from '../prepaid/ExtendDialog.tsx';
import { DurationSelect, PrepaidButton } from '../prepaid/OpenControls.tsx';
import { PrepaidBadge } from '../prepaid/PrepaidBadge.tsx';
import { hrefFor } from '../router.tsx';
import { LampBadge, PHASE_LABEL } from '../TableCard.tsx';
import { useHub } from '../useHub.tsx';

const HOUR = 60 * 60 * 1000;
const SLOW_LAMP_MS = 4000;

function rulesLine(t: TariffConfig): string {
  const parts = [t.stepMinutes === 1 ? 'поминутно' : `шаг ${t.stepMinutes} мин`];
  if (t.minimumMinutes > 0) parts.push(`мин. ${t.minimumMinutes} мин`);
  if (t.freeMinutes > 0) parts.push(`первые ${t.freeMinutes} мин бесплатно`);
  return parts.join(' · ');
}

function TariffPicker({
  tariffs,
  value,
  onChange,
  at,
  timezone,
  currency,
  defaultId,
}: {
  tariffs: HubState['tariffs'];
  value: string;
  onChange: (id: string) => void;
  at: number;
  timezone: string;
  currency: string;
  defaultId: string;
}) {
  const minute = Math.floor(at / 60_000);
  const rows = useMemo(
    () =>
      tariffs.map((t) => {
        const ms = minute * 60_000;
        return { t, now: priceAt(ms, t.config, timezone), next: nextPriceChange(ms, t.config, timezone, 3 * HOUR) };
      }),
    [tariffs, minute, timezone],
  );
  return (
    <div className="tariff-picker" role="radiogroup" aria-label="Тариф">
      {rows.map(({ t, now, next }) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={t.id === value}
          className="tariff-option"
          onClick={() => onChange(t.id)}
        >
          <span className="tariff-option-head">
            <strong>{t.name}</strong>
            {t.id === defaultId && <span className="tag">обычный для стола</span>}
            <span className="tariff-option-price">{formatMoney(now.pricePerHour, currency)}/ч</span>
          </span>
          <span className="tariff-option-meta">
            сейчас «{now.label}»
            {next && ` · с ${formatClock(next.at, timezone)} — ${formatMoney(next.pricePerHour, currency)}/ч`}
          </span>
          <span className="tariff-option-meta">{rulesLine(t.config)}</span>
        </button>
      ))}
    </div>
  );
}

function Breakdown({ session, end, currency }: { session: SessionView; end: number; currency: string }) {
  if (session.startedAt == null) return null;
  // Pauses are not billed (within the tariff budget); the segments show the rate per period.
  const charge = calculateChargeWithPauses(
    session.startedAt,
    end,
    unpaidSpans(session.pauses, session.tariff, end),
    session.tariff,
    session.timezone,
  );
  if (charge.segments.length === 0) {
    return <p className="hint">Пока бесплатно: первые {session.tariff.freeMinutes} мин не оплачиваются.</p>;
  }
  const billedPast = charge.billedSeconds > charge.playedSeconds;
  return (
    <div className="breakdown">
      <table>
        <thead>
          <tr>
            <th>Тариф</th>
            <th>Время</th>
            <th className="num">Цена</th>
          </tr>
        </thead>
        <tbody>
          {charge.segments.map((s) => (
            <tr key={s.from}>
              <td>{s.label}</td>
              <td>
                {formatClock(s.from, session.timezone)}–{formatClock(s.to, session.timezone)}
                <span className="muted"> · {formatSpan(s.to - s.from)}</span>
              </td>
              <td className="num">{formatMoney(s.pricePerHour, currency)}/ч</td>
            </tr>
          ))}
        </tbody>
      </table>
      {billedPast && (
        <p className="hint">
          Считается {formatSpan(charge.billedSeconds * 1000)}: {session.tariff.minimumMinutes > 0 ? `минимум ${session.tariff.minimumMinutes} мин` : ''}
          {session.tariff.stepMinutes > 1 ? `, шаг ${session.tariff.stepMinutes} мин` : ''}
        </p>
      )}
    </div>
  );
}

/** «Перенести» on a running game: pick a free table. */
function TransferPicker({
  tables,
  tableId,
  busy,
  onTransfer,
}: {
  tables: TableView[];
  tableId: string;
  busy: boolean;
  onTransfer: (toTableId: string) => void;
}) {
  const free = tables.filter((t) => t.id !== tableId && t.session === null);
  return (
    <div className="transfer">
      <p className="hint">Перенести игру на стол:</p>
      {free.length === 0 ? (
        <p className="hint">Свободных столов нет</p>
      ) : (
        <div className="tariff-chips transfer-chips" role="group" aria-label="Куда перенести">
          {free.map((t) => (
            <button key={t.id} type="button" className="chip" disabled={busy} onClick={() => onTransfer(t.id)}>
              {t.name}
              <span className="chip-note"> · {KIND_LABEL[t.kind]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PausedSection({
  table,
  session,
  charge,
  end,
  busy,
  serverNow,
  currency,
  timezone,
  stopButtons,
  extendButton,
}: {
  table: TableView;
  session: SessionView;
  charge: ReturnType<typeof calculateChargeWithPauses>;
  end: number;
  busy: boolean;
  serverNow: number;
  currency: string;
  timezone: string;
  stopButtons: (amount: number) => ReactNode;
  /** «Продлить» of a prepaid game, or null. */
  extendButton: ReactNode;
}) {
  const hub = useHub();
  const current = session.pauses.find((p) => p.to === null) ?? session.pauses.at(-1);
  const transferring = current?.reason === 'transfer';
  const powerLoss = current?.reason === 'power';
  const pausedAt = session.pausedAt ?? current?.from ?? end;
  const limits = pauseLimits(session.tariff);
  const usage = pauseUsage(session.pauses, end);
  const pausesLeft = Math.max(0, limits.maxPauses - usage.count);
  const budgetSeconds = limits.maxPauseMinutes * 60;
  const secondsLeft = Math.max(0, budgetSeconds - usage.seconds);
  // Only staff pauses spend the budget; a transfer or a power loss is never billed.
  const overBudget = !transferring && !powerLoss && usage.seconds >= budgetSeconds;
  const resuming = session.resumeRequestedAt != null;

  return (
    <section className="drawer-section">
      <div className="drawer-meter">
        <p className="drawer-timer">{formatDuration(charge.playedSeconds * 1000)}</p>
        <p className="drawer-amount">{formatMoney(charge.amount, currency)}</p>
      </div>
      <p className="status paused-status">
        {transferring ? 'Перенос' : powerLoss ? 'Пауза: нет электричества' : 'На паузе'} ·{' '}
        <span className="paused-for">{formatPause(Math.max(0, end - pausedAt))}</span>
      </p>
      <dl className="facts">
        <div>
          <dt>Начало</dt>
          <dd>{formatClock(session.startedAt ?? session.requestedAt, timezone)}</dd>
        </div>
        <div>
          <dt>Открыл</dt>
          <dd>{session.openedBy}</dd>
        </div>
        <div>
          <dt>Тариф</dt>
          <dd>{session.tariffName}</dd>
        </div>
        <div>
          <dt>Пауз</dt>
          <dd>{formatPause(charge.pausedSeconds * 1000)}</dd>
        </div>
      </dl>
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
        <p className="hint">
          <span className="spinner" aria-hidden="true" />{' '}
          {transferring ? 'Переносим игру — включаем свет на новом столе' : 'Включаем свет… время пойдёт, когда лампа подтвердит'}
        </p>
      )}
      <div className="drawer-actions">
        {!resuming && hub.canNow('table.continue') && (
          <button
            type="button"
            className="btn btn-primary btn-large"
            disabled={busy}
            onClick={() => void hub.resumeSession(table.id, session.id)}
          >
            <Icon name="play" />
            Продолжить
          </button>
        )}
        {extendButton}
        {stopButtons(charge.amount)}
      </div>
    </section>
  );
}

function DayHistory({ sessions, timezone, currency }: { sessions: SessionView[]; timezone: string; currency: string }) {
  const done = sessions.filter((s) => s.status !== 'ACTIVE' && s.status !== 'OPENING');
  const total = done.reduce((sum, s) => sum + (s.amount ?? 0), 0);
  return (
    <section className="drawer-section">
      <header className="drawer-section-head">
        <h3>Сегодня на этом столе</h3>
        {done.length > 0 && <span className="muted">{formatMoney(total, currency)}</span>}
      </header>
      {done.length === 0 ? (
        <p className="hint">Сегодня здесь ещё не играли.</p>
      ) : (
        <ul className="mini-history">
          {done.map((s) => (
            <li key={s.id}>
              <span className="mini-history-time">
                {formatClock(s.startedAt ?? s.requestedAt, timezone)}
                {s.stoppedAt != null && `–${formatClock(s.stoppedAt, timezone)}`}
              </span>
              <StatusBadge status={s.status} />
              <span className="mini-history-amount">
                {s.playedSeconds ? formatSpan(s.playedSeconds * 1000) : ''}
                {s.amount ? ` · ${formatMoney(s.amount, currency)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TableDrawer({
  table,
  alert,
  daySessions,
  onPrepaid,
  onClose,
}: {
  table: TableView;
  alert: AlertView | undefined;
  daySessions: SessionView[];
  /** Opens the prepaid dialog with the tariff and time picked here. */
  onPrepaid: (tariffId: string, minutes: number | null) => void;
  onClose: () => void;
}) {
  const hub = useHub();
  const { state, serverNow } = hub;
  const { timezone, currency } = state.club;
  const phase = tablePhase(table);
  const session = table.session;
  const busy = hub.isBusy(table.id) || !hub.online;
  const openBlocked = hub.blockedReason('table.open');
  const canContinue = hub.canNow('table.continue');
  const [tariffId, setTariffId] = useState(table.defaultTariffId);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [extending, setExtending] = useState(false);

  useEffect(() => {
    setTariffId(table.defaultTariffId);
    setMinutes(null);
    setConfirming(false);
    setMoving(false);
    setExtending(false);
  }, [table.id, table.defaultTariffId]);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);
  useEffect(() => {
    setConfirming(false);
    setMoving(false);
  }, [session?.id, session?.status]);

  const tariff = state.tariffs.find((t) => t.id === tariffId);
  const live = (phase === 'playing' || phase === 'paused') && session?.startedAt != null;
  const prepaid = session?.prepaid ?? null;
  // A timed game ends at its deadline even if the HUB's stop has not reached the screen yet.
  const cap = phase === 'playing' && prepaid?.until != null ? prepaid.until : serverNow;
  const end = session?.startedAt != null ? Math.max(Math.min(serverNow, cap), session.startedAt) : serverNow;
  const charge =
    live && session?.startedAt != null
      ? calculateChargeWithPauses(
          session.startedAt,
          end,
          unpaidSpans(session.pauses, session.tariff, end),
          session.tariff,
          session.timezone,
        )
      : null;
  const next =
    phase === 'playing' && session ? nextPriceChange(Math.floor(end / 60_000) * 60_000, session.tariff, timezone, HOUR) : null;
  const rate = phase === 'playing' && session ? priceAt(end, session.tariff, timezone) : null;
  const refusal = phase === 'playing' && session ? pauseRefusal(session.pauses, session.tariff, end) : null;
  // Paid upfront: the running amount is not what the guest owes.
  const paidUpfront = prepaid?.amount != null;
  // «Продлить» a game for N minutes: whoever may sell prepaid time may extend it.
  const extendButton =
    prepaid && !confirming && hub.canNow('table.open') ? (
      <button type="button" className="btn btn-ghost btn-large" disabled={busy} onClick={() => setExtending(true)}>
        <Icon name="clock" />
        Продлить
      </button>
    ) : null;

  const stopButtons = (amount: number) =>
    confirming ? (
      <>
        <button
          type="button"
          className="btn btn-danger btn-large"
          disabled={busy}
          onClick={() => session && void hub.stopSession(table.id, session.id)}
        >
          <Icon name="stop" />
          {paidUpfront ? 'Остановить досрочно' : `Остановить · ${formatMoney(amount, currency)}`}
        </button>
        <button type="button" className="btn btn-ghost btn-large btn-narrow" onClick={() => setConfirming(false)}>
          Нет
        </button>
      </>
    ) : (
      <button type="button" className="btn btn-outline-danger btn-large" disabled={busy} onClick={() => setConfirming(true)}>
        <Icon name="stop" />
        Стоп
      </button>
    );

  return (
    <Drawer
      title={table.name}
      onClose={onClose}
      subtitle={
        <>
          <span>{KIND_LABEL[table.kind]}</span>
          <span className="phase" data-phase={phase}>
            {PHASE_LABEL[phase]}
          </span>
          <LampBadge lamp={table.lamp} />
        </>
      }
    >
      {(alert || table.lamp.reported === 'UNKNOWN') && (
        <div className="drawer-alert" role="alert">
          <Icon name="alert" size={18} />
          <p>
            {alert?.message ?? 'Лампа не ответила — проверьте свет на столе'}
            {alert?.staff && <span className="muted"> Сотрудник: {alert.staff}</span>}
          </p>
          {alert && hub.can('alert.resolve') && (
            <button
              type="button"
              className="btn btn-small"
              disabled={hub.isBusy(`alert:${alert.id}`)}
              onClick={() => void hub.resolveAlert(alert.id)}
            >
              Принято
            </button>
          )}
        </div>
      )}

      {phase === 'free' && (
        <section className="drawer-section">
          <TariffPicker
            tariffs={state.tariffs}
            value={tariffId}
            onChange={setTariffId}
            at={serverNow}
            timezone={timezone}
            currency={currency}
            defaultId={table.defaultTariffId}
          />
          {openBlocked ? (
            <p className="blocked-note">{openBlocked}</p>
          ) : (
          <>
          <div className="drawer-actions">
            <DurationSelect value={minutes} onChange={setMinutes} disabled={busy} />
            <button
              type="button"
              className="btn btn-primary btn-large"
              disabled={busy}
              onClick={() => void hub.openTable(table.id, tariffId, minutes)}
            >
              <Icon name="lamp" />
              Открыть стол{tariff && state.tariffs.length > 1 ? ` · ${tariff.name}` : ''}
            </button>
            <PrepaidButton shiftOpen={state.shift !== null} disabled={busy} onClick={() => onPrepaid(tariffId, minutes)} />
          </div>
          <p className="hint">
            Свет включится сразу, время пойдёт, когда лампа подтвердит включение.
            {minutes != null && ' Игра на время: HUB остановит её сам, оплата после.'}
          </p>
          </>
          )}
        </section>
      )}

      {phase === 'opening' && session && (
        <section className="drawer-section drawer-opening">
          <span className="big-spinner" aria-hidden="true" />
          <p className="drawer-opening-title">Включаем свет… {Math.max(0, Math.floor((serverNow - session.requestedAt) / 1000))} с</p>
          <p className="hint">
            {serverNow - session.requestedAt >= SLOW_LAMP_MS
              ? 'Контроллер отвечает медленно — HUB повторяет команду. Если свет не включится, игра не начнётся.'
              : 'Время пойдёт с момента, когда лампа подтвердит включение.'}
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-large"
            disabled={busy}
            onClick={() => void hub.stopSession(table.id, session.id)}
          >
            Отменить
          </button>
        </section>
      )}

      {phase === 'playing' && session?.startedAt != null && charge && (
        <section className="drawer-section">
          <div className="drawer-meter">
            <p className="drawer-timer">{formatDuration(charge.playedSeconds * 1000)}</p>
            {!paidUpfront && <p className="drawer-amount">{formatMoney(charge.amount, currency)}</p>}
          </div>
          {prepaid && <PrepaidBadge prepaid={prepaid} serverNow={serverNow} timezone={session.timezone} currency={currency} />}
          <dl className="facts">
            <div>
              <dt>Начало</dt>
              <dd>{formatClock(session.startedAt, timezone)}</dd>
            </div>
            <div>
              <dt>Открыл</dt>
              <dd>{session.openedBy}</dd>
            </div>
            <div>
              <dt>Тариф</dt>
              <dd>{session.tariffName}</dd>
            </div>
            {charge.pausedSeconds > 0 && (
              <div>
                <dt>Пауз</dt>
                <dd>{formatPause(charge.pausedSeconds * 1000)}</dd>
              </div>
            )}
            {rate && (
              <div>
                <dt>Сейчас</dt>
                <dd>
                  {rate.label} · {formatMoney(rate.pricePerHour, currency)}/ч
                </dd>
              </div>
            )}
          </dl>
          {next && (
            <p className="price-next drawer-next">
              <Icon name="clock" size={16} /> с {formatClock(next.at, timezone)} — «{next.label}»{' '}
              {formatMoney(next.pricePerHour, currency)}/ч. Предупредите гостей.
            </p>
          )}
          <Breakdown session={session} end={end} currency={currency} />
          {moving && (
            <TransferPicker
              tables={state.tables}
              tableId={table.id}
              busy={busy}
              onTransfer={(to) => {
                setMoving(false);
                void hub.transferSession(table.id, session.id, to);
              }}
            />
          )}
          <div className="drawer-actions">
            {!confirming && canContinue && (
              <button
                type="button"
                className="btn btn-ghost btn-large"
                disabled={busy || refusal !== null}
                title={refusal ?? undefined}
                onClick={() => void hub.pauseSession(table.id, session.id)}
              >
                Пауза
              </button>
            )}
            {extendButton}
            {stopButtons(charge.amount)}
            {!confirming && canContinue && (
              <button type="button" className="btn btn-ghost btn-large" disabled={busy} onClick={() => setMoving((v) => !v)}>
                {moving ? 'Не переносить' : 'Перенести'}
              </button>
            )}
          </div>
          {refusal && !confirming && canContinue && <p className="hint">{refusal}</p>}
        </section>
      )}

      {phase === 'paused' && session?.startedAt != null && charge && (
        <PausedSection
          table={table}
          session={session}
          charge={charge}
          end={end}
          busy={busy}
          serverNow={serverNow}
          currency={currency}
          timezone={timezone}
          stopButtons={stopButtons}
          extendButton={extendButton}
        />
      )}

      {extending && session?.prepaid && (
        <ExtendDialog target={{ sessionId: session.id, tableName: table.name }} onClose={() => setExtending(false)} />
      )}

      <DayHistory sessions={daySessions} timezone={timezone} currency={currency} />

      <a className="drawer-link" href={hrefFor('/journal', { table: table.id })}>
        <Icon name="journal" size={18} />
        Журнал действий этого стола
        <Icon name="chevron" size={16} />
      </a>
    </Drawer>
  );
}
