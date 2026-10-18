import { useEffect, useMemo, useState } from 'react';
import type { AlertView, HubState, SessionView, TableView, TariffConfig } from '@bills/domain';
import { calculateCharge, formatMoney, nextPriceChange, priceAt } from '@bills/domain';
import { Drawer, StatusBadge } from '../components.tsx';
import { formatClock, formatDuration, formatSpan, KIND_LABEL } from '../format.ts';
import { tablePhase } from '../hall.ts';
import { Icon } from '../icons.tsx';
import { href } from '../router.ts';
import { LampBadge, PHASE_LABEL } from '../TableCard.tsx';
import { useHub } from '../useHub.ts';

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
  const charge = calculateCharge(session.startedAt, end, session.tariff, session.timezone);
  if (charge.segments.length === 0) {
    return <p className="hint">Пока бесплатно: первые {session.tariff.freeMinutes} мин не оплачиваются.</p>;
  }
  const billedPast = charge.billedSeconds * 1000 > end - session.startedAt;
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
  onClose,
}: {
  table: TableView;
  alert: AlertView | undefined;
  daySessions: SessionView[];
  onClose: () => void;
}) {
  const hub = useHub();
  const { state, serverNow } = hub;
  const { timezone, currency } = state.club;
  const phase = tablePhase(table);
  const session = table.session;
  const busy = hub.isBusy(table.id) || !hub.online;
  const [tariffId, setTariffId] = useState(table.defaultTariffId);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setTariffId(table.defaultTariffId);
    setConfirming(false);
  }, [table.id, table.defaultTariffId]);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);
  useEffect(() => setConfirming(false), [session?.id]);

  const tariff = state.tariffs.find((t) => t.id === tariffId);
  const end = session?.startedAt != null ? Math.max(serverNow, session.startedAt) : serverNow;
  const charge =
    phase === 'playing' && session?.startedAt != null
      ? calculateCharge(session.startedAt, end, session.tariff, session.timezone)
      : null;
  const next =
    phase === 'playing' && session ? nextPriceChange(Math.floor(end / 60_000) * 60_000, session.tariff, timezone, HOUR) : null;
  const rate = phase === 'playing' && session ? priceAt(end, session.tariff, timezone) : null;

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
          <p>{alert?.message ?? 'Лампа не ответила — проверьте свет на столе'}</p>
          {alert && (
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
          <button
            type="button"
            className="btn btn-primary btn-large"
            disabled={busy}
            onClick={() => void hub.openTable(table.id, tariffId)}
          >
            <Icon name="lamp" />
            Открыть стол{tariff && state.tariffs.length > 1 ? ` · ${tariff.name}` : ''}
          </button>
          <p className="hint">Свет включится сразу, время пойдёт, когда лампа подтвердит включение.</p>
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
            <p className="drawer-timer">{formatDuration(end - session.startedAt)}</p>
            <p className="drawer-amount">{formatMoney(charge.amount, currency)}</p>
          </div>
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
          <div className="drawer-actions">
            {confirming ? (
              <>
                <button
                  type="button"
                  className="btn btn-danger btn-large"
                  disabled={busy}
                  onClick={() => void hub.stopSession(table.id, session.id)}
                >
                  <Icon name="stop" />
                  Остановить · {formatMoney(charge.amount, currency)}
                </button>
                <button type="button" className="btn btn-ghost btn-large btn-narrow" onClick={() => setConfirming(false)}>
                  Нет
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-outline-danger btn-large"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                <Icon name="stop" />
                Стоп
              </button>
            )}
          </div>
        </section>
      )}

      <DayHistory sessions={daySessions} timezone={timezone} currency={currency} />

      <a className="drawer-link" href={href('journal', { table: table.id })}>
        <Icon name="journal" size={18} />
        Журнал действий этого стола
        <Icon name="chevron" size={16} />
      </a>
    </Drawer>
  );
}
