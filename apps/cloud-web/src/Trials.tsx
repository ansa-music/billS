/**
 * «Пробные версии» of the platform cabinet: browser trials of coffee shops. New requests come first with
 * «Подтвердить» / «Отклонить»; each trial can be watched, extended, dated, ended, made permanent, downloaded
 * or deleted; «Уведомления о заявках» (Telegram, this device) at the bottom.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { trialZoneCity } from '@bills/domain';
import {
  CloudRequestError,
  approveTrial,
  deleteTrial,
  endTrial,
  extendTrial,
  fetchTrialSnapshot,
  listTrials,
  makeTrialPermanent,
  rejectTrial,
  setTrialEndDate,
} from './api.ts';
import { CopyButton } from './cabinet-ui.tsx';
import { formatDayLabel } from './format.ts';
import { usePoll } from './hooks.ts';
import { describeCabinetError } from './license-form.ts';
import { Section, loadingText } from './shared.tsx';
import { TrialAlerts } from './TrialAlerts.tsx';
import type { TrialStats, TrialView } from './trials.ts';
import {
  DEFAULT_TRIAL_URL,
  EXTEND_MAX_DAYS,
  EXTEND_MIN_DAYS,
  REJECT_MESSAGE_MAX,
  TRIAL_STATUS_LABEL,
  bytesText,
  canChangeTerm,
  canDeleteTrial,
  daysText,
  duplicateText,
  effectiveStatus,
  endDateDefault,
  endDateRange,
  endDateText,
  isRequest,
  isWorkingNow,
  lastDays,
  lastOrderText,
  lastSeenText,
  ordersText,
  parseEndDate,
  parseExtendDays,
  parseRejectMessage,
  pendingCount,
  requestSeenText,
  sortTrials,
  trialBackup,
  trialBackupFileName,
  trialDate,
  trialEndText,
  trialMoney,
  trialTermText,
  trialTone,
} from './trials.ts';

/** The list, polled every minute: Platform.tsx owns it so the tab shows how many requests wait. */
export function useTrialsPoll(enabled: boolean) {
  const load = useCallback(() => (enabled ? listTrials() : Promise.resolve([] as TrialView[])), [enabled]);
  return usePoll(load, 60_000);
}

export type TrialsPoll = ReturnType<typeof useTrialsPoll>;

const CHART_DAYS = 14;

function trialUrl(): string {
  return (import.meta.env.VITE_TRIAL_URL ?? '').trim() || DEFAULT_TRIAL_URL;
}

function TrialChip({ trial, now }: { trial: TrialView; now: number }) {
  return (
    <span className="lic-chip" data-tone={trialTone(trial, now)}>
      {TRIAL_STATUS_LABEL[effectiveStatus(trial, now)]}
    </span>
  );
}

function LastSeen({ trial, now }: { trial: TrialView; now: number }) {
  return (
    <span className="trial-seen" data-live={isWorkingNow(trial.lastSeenAt, now) || undefined}>
      <span className="trial-seen-dot" aria-hidden="true" />
      {isRequest(trial) ? requestSeenText(trial.lastSeenAt, now) : lastSeenText(trial.lastSeenAt, now)}
    </span>
  );
}

/** «Аиша · Алматы» — who asked and where (the city of the browser's zone). */
function whoText(trial: TrialView): string {
  return [trial.managerName || 'управляющий не указан', trialZoneCity(trial.timezone)].filter(Boolean).join(' · ');
}

function DuplicateLine({ trial }: { trial: TrialView }) {
  const text = duplicateText(trial.duplicateOf, trial.timezone);
  return text ? <span className="trial-dup">⚠ {text}</span> : null;
}

/**
 * A request waiting for TS: who, where, when, whether its page is open now, «похоже на повтор», and the
 * two answers right on the card. «Отклонить» first asks for an optional message to the coffee shop.
 */
function RequestCard({
  trial,
  now,
  editable,
  selected,
  onOpen,
  onChanged,
}: {
  trial: TrialView;
  now: number;
  editable: boolean;
  selected: boolean;
  onOpen: () => void;
  onChanged: (t: TrialView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function act(fn: () => Promise<TrialView>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onChanged(await fn());
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  function reject(e: FormEvent) {
    e.preventDefault();
    const text = parseRejectMessage(message);
    if (text === undefined) {
      setError(`Сообщение — не длиннее ${REJECT_MESSAGE_MAX} символов`);
      return;
    }
    void act(() => rejectTrial(trial.id, text));
  }

  return (
    <li>
      <div className="trial-card trial-request" aria-current={selected || undefined}>
        <span className="trial-card-head">
          <strong className="trial-venue">{trial.venue || 'Без названия'}</strong>
          <TrialChip trial={trial} now={now} />
        </span>
        <span className="muted trial-line">{whoText(trial)}</span>
        <span className="trial-line">{trialTermText(trial, now)}</span>
        <span className="trial-line">
          <LastSeen trial={trial} now={now} />
        </span>
        <DuplicateLine trial={trial} />
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        {editable && rejecting ? (
          <form className="trial-reject" onSubmit={reject} noValidate>
            <label className="field">
              <span>Сообщение кофейне (необязательно)</span>
              <textarea
                rows={2}
                maxLength={REJECT_MESSAGE_MAX}
                placeholder="Например: у вас уже есть пробная версия — откройте её там, где начинали"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <span className="row wrap">
              <button type="submit" className="btn btn-danger" disabled={busy}>
                {busy ? 'Отклоняем…' : 'Отклонить заявку'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setRejecting(false)}>
                Отмена
              </button>
            </span>
          </form>
        ) : (
          <span className="row wrap">
            {editable && (
              <>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => approveTrial(trial.id))}>
                  {busy ? 'Подтверждаем…' : 'Подтвердить'}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => setRejecting(true)}>
                  Отклонить
                </button>
              </>
            )}
            <button type="button" className="btn" onClick={onOpen}>
              Подробнее
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

function TrialCard({ trial, now, selected, onOpen }: { trial: TrialView; now: number; selected: boolean; onOpen: () => void }) {
  const s = trial.stats;
  const status = effectiveStatus(trial, now);
  return (
    <li>
      <button type="button" className="trial-card" aria-current={selected || undefined} onClick={onOpen}>
        <span className="trial-card-head">
          <strong className="trial-venue">{trial.venue || 'Без названия'}</strong>
          <TrialChip trial={trial} now={now} />
        </span>
        <span className="muted trial-line">
          {status === 'rejected'
            ? whoText(trial)
            : `${trial.managerName || 'управляющий не указан'} · начал(а) ${trialDate(trial.startedAt, trial.timezone)}`}
        </span>
        <span className="trial-line">{trialTermText(trial, now)}</span>
        <span className="trial-line">
          <LastSeen trial={trial} now={now} />
          {s?.shiftOpen && <span className="trial-badge">смена открыта</span>}
        </span>
        {status === 'rejected' && <DuplicateLine trial={trial} />}
        {s ? (
          <span className="trial-nums">
            <span>
              <span className="muted">Сегодня</span> {ordersText(s.ordersToday)} · {trialMoney(s.revenueToday)}
            </span>
            <span>
              <span className="muted">Всего</span> {ordersText(s.ordersTotal)} · {trialMoney(s.revenueTotal)}
            </span>
          </span>
        ) : (
          <span className="muted trial-line">Касса ещё не прислала цифры</span>
        )}
      </button>
    </li>
  );
}

type ChartKind = 'orders' | 'revenue';

/** The last 14 days as CSS bars (text stays readable at any width); the last bar is today. */
function TrialChart({ stats, now }: { stats: TrialStats; now: number }) {
  const [kind, setKind] = useState<ChartKind>('orders');
  const days = lastDays(stats.days, CHART_DAYS, now);
  const value = (d: TrialStats['days'][number]) => (kind === 'orders' ? d.orders : d.revenue);
  const label = (v: number) => (kind === 'orders' ? ordersText(v) : trialMoney(v));
  const max = Math.max(...days.map(value));
  const total = days.reduce((sum, d) => sum + value(d), 0);
  return (
    <figure className="chart trial-chart">
      <div className="trial-chart-head">
        <span className="muted">За {daysText(CHART_DAYS)}{max > 0 ? ` · макс. ${label(max)}` : ''}</span>
        <span className="seg trial-seg" role="tablist" aria-label="Что показать">
          <button type="button" role="tab" aria-selected={kind === 'orders'} onClick={() => setKind('orders')}>
            Заказы
          </button>
          <button type="button" role="tab" aria-selected={kind === 'revenue'} onClick={() => setKind('revenue')}>
            Выручка
          </button>
        </span>
      </div>
      <div className="trial-bars" role="img" aria-label={`${kind === 'orders' ? 'Заказы' : 'Выручка'} по дням за ${daysText(CHART_DAYS)}`}>
        {days.map((d, i) => {
          const v = value(d);
          const last = i === days.length - 1;
          return (
            <div key={d.day} className="trial-bar" data-today={last || undefined} title={`${formatDayLabel(d.day)}: ${ordersText(d.orders)}, ${trialMoney(d.revenue)}`}>
              <span className="trial-bar-track">
                <span className="trial-bar-fill" style={{ height: max > 0 ? `${Math.max((v / max) * 100, v > 0 ? 2 : 0)}%` : 0 }} />
              </span>
              <span className="trial-bar-label">{last ? 'сег.' : i % 2 === 0 ? formatDayLabel(d.day, true) : ''}</span>
            </div>
          );
        })}
      </div>
      <figcaption className="muted">Итого за {daysText(CHART_DAYS)}: {label(total)}</figcaption>
    </figure>
  );
}

function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function TrialDetail({
  trial,
  now,
  editable,
  onChanged,
  onDeleted,
  onClose,
}: {
  trial: TrialView;
  now: number;
  editable: boolean;
  onChanged: (t: TrialView) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [endDate, setEndDate] = useState(() => endDateDefault(trial, now));
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectMessage, setRejectMessage] = useState('');
  const s = trial.stats;
  const status = effectiveStatus(trial, now);
  const endRange = endDateRange(now, trial.timezone);
  const termEditable = canChangeTerm(trial);
  const dup = duplicateText(trial.duplicateOf, trial.timezone);
  const confirming = confirmEnd || confirmDelete || rejecting;
  // After «Продлить» (or a poll that brings another end) the picker shows the new last day.
  useEffect(() => setEndDate(endDateDefault(trial, Date.now())), [trial.endsAt, trial.timezone]);

  async function act(fn: () => Promise<string | null>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
    } catch (err) {
      setError(describeCabinetError(err));
    } finally {
      setBusy(false);
    }
  }

  function extend(days: number) {
    void act(async () => {
      const next = await extendTrial(trial.id, days);
      onChanged(next);
      return `Продлено на ${daysText(days)}: теперь до ${trialDate(next.endsAt)}.`;
    });
  }

  function extendCustom(e: FormEvent) {
    e.preventDefault();
    const days = parseExtendDays(custom);
    if (days === null) {
      setDone(null);
      setError(`Укажите целое число дней от ${EXTEND_MIN_DAYS} до ${EXTEND_MAX_DAYS}`);
      return;
    }
    setCustom('');
    extend(days);
  }

  function saveEndDate(e: FormEvent) {
    e.preventDefault();
    const date = parseEndDate(endDate, Date.now(), trial.timezone);
    if (date === null) {
      setDone(null);
      setError(`Выберите дату с ${endDateText(endRange.min)} по ${endDateText(endRange.max)}`);
      return;
    }
    void act(async () => {
      const next = await setTrialEndDate(trial.id, date);
      onChanged(next);
      return `Пробный период до ${endDateText(date)} включительно.`;
    });
  }

  function end() {
    void act(async () => {
      onChanged(await endTrial(trial.id));
      setConfirmEnd(false);
      return 'Пробный период завершён.';
    });
  }

  function approve() {
    void act(async () => {
      const next = await approveTrial(trial.id);
      onChanged(next);
      return `Заявка подтверждена: пробный период до ${trialDate(next.endsAt, next.timezone)}. Касса кофейни откроется сама в течение минуты.`;
    });
  }

  function reject(e: FormEvent) {
    e.preventDefault();
    const message = parseRejectMessage(rejectMessage);
    if (message === undefined) {
      setDone(null);
      setError(`Сообщение — не длиннее ${REJECT_MESSAGE_MAX} символов`);
      return;
    }
    void act(async () => {
      onChanged(await rejectTrial(trial.id, message));
      setRejecting(false);
      return 'Заявка отклонена. Кофейня увидит это на своей странице.';
    });
  }

  function makePermanent() {
    void act(async () => {
      onChanged(await makeTrialPermanent(trial.id));
      return 'Теперь это постоянная версия: без срока. Касса узнает об этом сама в течение нескольких минут.';
    });
  }

  function remove() {
    void act(async () => {
      await deleteTrial(trial.id);
      setConfirmDelete(false);
      onDeleted(trial.id);
      return null;
    });
  }

  function download() {
    void act(async () => {
      try {
        const snap = await fetchTrialSnapshot(trial.id);
        downloadText(trialBackupFileName(trial.venue, snap.snapshotAt), JSON.stringify(trialBackup(trial, snap)));
        return null;
      } catch (err) {
        if (err instanceof CloudRequestError && err.status === 404) {
          throw new Error('Копии данных пока нет: касса пришлёт её при следующей связи с облаком.');
        }
        throw err;
      }
    });
  }

  return (
    <Section
      title={trial.venue || 'Без названия'}
      aside={
        <button type="button" className="btn btn-small" onClick={onClose}>
          Закрыть
        </button>
      }
    >
      <dl className="facts">
        <div>
          <dt>{status === 'permanent' ? 'Версия' : isRequest(trial) || status === 'rejected' ? 'Заявка' : 'Пробный период'}</dt>
          <dd className="lic-line">
            <TrialChip trial={trial} now={now} />
            <span className="muted">{trialTermText(trial, now)}</span>
          </dd>
        </div>
        {dup && (
          <div>
            <dt>Повтор?</dt>
            <dd className="trial-dup">⚠ {dup}</dd>
          </div>
        )}
        <div>
          <dt>Управляющий</dt>
          <dd>{trial.managerName || '—'}</dd>
        </div>
        {trialZoneCity(trial.timezone) && (
          <div>
            <dt>Город (по часовому поясу)</dt>
            <dd>{trialZoneCity(trial.timezone)}</dd>
          </div>
        )}
        {trial.requestedAt !== null && (
          <div>
            <dt>Заявка пришла</dt>
            <dd>{trialDate(trial.requestedAt, trial.timezone)}</dd>
          </div>
        )}
        {status === 'rejected' && (
          <div>
            <dt>Сообщение кофейне</dt>
            <dd>{trial.ownerMessage || 'без сообщения'}</dd>
          </div>
        )}
        <div>
          <dt>Начало</dt>
          <dd>{isRequest(trial) || status === 'rejected' ? 'после подтверждения' : trialDate(trial.startedAt, trial.timezone)}</dd>
        </div>
        <div>
          <dt>Окончание</dt>
          <dd>
            {status === 'permanent'
              ? 'без срока — постоянная'
              : isRequest(trial) || status === 'rejected'
                ? `через ${daysText(14)} после подтверждения`
                : status === 'ended'
                  ? `завершена ${trialDate(trial.endsAt, trial.timezone)}`
                  : trialEndText(trial)}
          </dd>
        </div>
        <div>
          <dt>Последняя связь</dt>
          <dd>
            <LastSeen trial={trial} now={now} />
          </dd>
        </div>
        {s?.appVersion && (
          <div>
            <dt>Версия TS</dt>
            <dd>{s.appVersion}</dd>
          </div>
        )}
        <div>
          <dt>Копия данных</dt>
          <dd>
            {trial.snapshotAt
              ? `${trialDate(trial.snapshotAt)}${trial.snapshotBytes ? ` · ${bytesText(trial.snapshotBytes)}` : ''}`
              : 'пока нет'}
          </dd>
        </div>
      </dl>

      {s ? (
        <>
          <div className="stats trial-stats">
            <div className="stat">
              <span className="stat-label">Сегодня</span>
              <span className="stat-value">{trialMoney(s.revenueToday)}</span>
              <span className="stat-sub">{ordersText(s.ordersToday)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Всего</span>
              <span className="stat-value">{trialMoney(s.revenueTotal)}</span>
              <span className="stat-sub">{ordersText(s.ordersTotal)}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Смена</span>
              <span className="stat-value">{s.shiftOpen ? 'открыта' : 'закрыта'}</span>
              <span className="stat-sub">
                {lastOrderText(s.lastOrderAt, now)}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Меню и люди</span>
              <span className="stat-value">{s.productsCount} в меню</span>
              <span className="stat-sub">сотрудников: {s.staffCount}</span>
            </div>
          </div>
          <TrialChart stats={s} now={now} />
        </>
      ) : isRequest(trial) || status === 'rejected' ? (
        <p className="empty">
          {isRequest(trial)
            ? 'Касса кофейни ждёт подтверждения: заказы начнутся после «Подтвердить». Если страница кофейни открыта, она откроется сама в течение минуты.'
            : 'Заявка отклонена: касса кофейни так и не открылась.'}
        </p>
      ) : (
        <p className="empty">Касса ещё не прислала цифры — они появятся после первой связи с облаком.</p>
      )}

      {done && (
        <p className="saved" role="status">
          {done}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {editable && confirmEnd && (
        <div className="sub-panel">
          <h3>{status === 'permanent' ? 'Завершить постоянную версию?' : 'Завершить пробный период досрочно?'}</h3>
          <p className="hint">
            {status === 'permanent' ? 'Касса' : 'Пробная версия'} «{trial.venue}» перейдёт в режим «только чтение» сейчас. Данные клиента останутся — их можно
            скачать кнопкой «Скачать копию данных».
          </p>
          <div className="row wrap">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={end}>
              {busy ? 'Завершаем…' : 'Да, завершить'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmEnd(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {editable && confirmDelete && (
        <div className="sub-panel">
          <h3>Удалить «{trial.venue}»?</h3>
          <p className="hint">
            {isRequest(trial)
              ? 'Заявка исчезнет из списка; на странице кофейни появится «Заявка удалена».'
              : 'Запись, её копия данных и ссылки «Смотреть с телефона» удалятся без возврата. Касса кофейни останется в режиме «только чтение».'}
          </p>
          <div className="row wrap">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
              {busy ? 'Удаляем…' : 'Да, удалить'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {editable && rejecting && (
        <form className="sub-panel trial-reject" onSubmit={reject} noValidate>
          <h3>Отклонить заявку «{trial.venue}»?</h3>
          <label className="field">
            <span>Сообщение кофейне (необязательно) — его покажет их страница</span>
            <textarea
              rows={2}
              maxLength={REJECT_MESSAGE_MAX}
              placeholder="Например: у вас уже есть пробная версия — откройте её там, где начинали"
              value={rejectMessage}
              onChange={(e) => setRejectMessage(e.target.value)}
            />
          </label>
          <div className="row wrap">
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? 'Отклоняем…' : 'Отклонить заявку'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setRejecting(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {editable && !confirming && (
        <div className="trial-actions">
          {!termEditable && (
            <div className="row wrap">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={approve}>
                {status === 'rejected' ? 'Всё-таки подтвердить' : 'Подтвердить'}
              </button>
              {isRequest(trial) && (
                <button type="button" className="btn" disabled={busy} onClick={() => setRejecting(true)}>
                  Отклонить
                </button>
              )}
            </div>
          )}
          {termEditable && status !== 'permanent' && (
            <div className="row wrap">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => extend(7)}>
                Продлить на 7 дней
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => extend(14)}>
                +14 дней
              </button>
              <form className="trial-custom" onSubmit={extendCustom} noValidate>
                <label className="field trial-custom-field">
                  <span className="visually-hidden">Сколько дней добавить</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={EXTEND_MIN_DAYS}
                    max={EXTEND_MAX_DAYS}
                    placeholder="дней"
                    value={custom}
                    onChange={(e) => setCustom(e.target.value)}
                  />
                </label>
                <button type="submit" className="btn" disabled={busy || custom.trim() === ''}>
                  Продлить
                </button>
              </form>
            </div>
          )}
          {termEditable && (
            <form className="row wrap" onSubmit={saveEndDate} noValidate>
              <label className="day-pick">
                <span className="muted">Дата окончания</span>
                <input type="date" min={endRange.min} max={endRange.max} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </label>
              <button type="submit" className="btn" disabled={busy || endDate === ''}>
                Установить дату
              </button>
              <span className="hint">
                {status === 'permanent'
                  ? 'Снова пробная: касса работает до конца этого дня по времени кофейни.'
                  : 'Касса работает до конца этого дня по времени кофейни.'}
              </span>
            </form>
          )}
          <div className="row wrap">
            {status !== 'permanent' && (
              <button type="button" className="btn" disabled={busy} onClick={makePermanent}>
                Сделать постоянной
              </button>
            )}
            {!isRequest(trial) && status !== 'rejected' && (
              <button type="button" className="btn" disabled={busy} onClick={download}>
                Скачать копию данных
              </button>
            )}
            {(status === 'active' || status === 'permanent') && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirmEnd(true)}>
                {status === 'permanent' ? 'Завершить' : 'Завершить досрочно'}
              </button>
            )}
            {canDeleteTrial(trial, now) && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Удалить
              </button>
            )}
          </div>
          {status === 'permanent' && <p className="hint">Постоянная: без срока, касса работает всегда. Удалить можно после «Завершить».</p>}
        </div>
      )}
      {!editable && (
        <div className="row wrap">
          <button type="button" className="btn" disabled={busy} onClick={download}>
            Скачать копию данных
          </button>
        </div>
      )}
      <p className="hint">
        Чтобы посмотреть кассу клиента: откройте пробную версию в режиме инкогнито → «Восстановить из копии» → этот файл.
      </p>
    </Section>
  );
}

function TrialsEmpty() {
  const url = trialUrl();
  return (
    <div className="empty trial-empty">
      <p>Пока нет ни заявок, ни пробных версий.</p>
      <p className="trial-empty-link">
        Ссылка для клиентов:{' '}
        <a href={url} target="_blank" rel="noreferrer">
          {url}
        </a>{' '}
        <CopyButton text={url}>Скопировать</CopyButton>
      </p>
    </div>
  );
}

/**
 * The «Пробные версии» tab: new requests first (with «Подтвердить» / «Отклонить» on the card), then the
 * trials, refreshed every minute (Platform.tsx polls, so the tab can show how many requests wait); the
 * opened trial above them; where the requests are announced (Telegram, this device) at the bottom.
 */
export function TrialsSection({ editable, poll }: { editable: boolean; poll: TrialsPoll }) {
  const { data, error, reload } = poll;
  const [selected, setSelected] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, TrialView>>({});
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());
  // An action shows the cloud's answer at once; the next poll brings the same and drops it.
  useEffect(() => {
    setOverrides({});
    setDeleted(new Set());
  }, [data]);
  const now = Date.now();

  const trials = sortTrials((data ?? []).filter((t) => !deleted.has(t.id)).map((t) => overrides[t.id] ?? t));
  const requests = trials.filter(isRequest);
  const others = trials.filter((t) => !isRequest(t));
  const current = trials.find((t) => t.id === selected) ?? null;
  const working = others.filter((t) => isWorkingNow(t.lastSeenAt, now)).length;
  const changed = (t: TrialView) => {
    setOverrides((o) => ({ ...o, [t.id]: t }));
    void reload();
  };
  const open = (id: string) => {
    setSelected(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      {current && (
        <TrialDetail
          key={current.id}
          trial={current}
          now={now}
          editable={editable}
          onChanged={changed}
          onDeleted={(id) => {
            setDeleted((d) => new Set(d).add(id));
            setSelected(null);
            void reload();
          }}
          onClose={() => setSelected(null)}
        />
      )}
      {requests.length > 0 && (
        <Section
          title="Новые заявки"
          aside={
            <span className="panel-aside">
              <span className="panel-total">{pendingCount(requests)}</span>
            </span>
          }
        >
          <p className="hint">Касса кофейни ждёт ответа: после «Подтвердить» она откроется сама, пробный период — 14 дней с этой минуты.</p>
          <ul className="trial-list">
            {requests.map((t) => (
              <RequestCard key={t.id} trial={t} now={now} editable={editable} selected={t.id === selected} onOpen={() => open(t.id)} onChanged={changed} />
            ))}
          </ul>
        </Section>
      )}
      <Section
        title="Пробные версии"
        aside={
          <span className="panel-aside">
            {working > 0 && <span className="muted">сейчас работают: {working}</span>}
            <span className="panel-total">{data ? others.length : ''}</span>
          </span>
        }
      >
        {data ? (
          trials.length === 0 ? (
            <TrialsEmpty />
          ) : others.length === 0 ? (
            <p className="empty">Пока только заявки — подтвердите их выше.</p>
          ) : (
            <ul className="trial-list">
              {others.map((t) => (
                <TrialCard key={t.id} trial={t} now={now} selected={t.id === selected} onOpen={() => open(t.id)} />
              ))}
            </ul>
          )
        ) : (
          <p className="empty">{loadingText(error, 'пробные версии')}</p>
        )}
      </Section>
      <TrialAlerts />
    </>
  );
}
