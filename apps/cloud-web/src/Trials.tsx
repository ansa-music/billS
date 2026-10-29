/** «Пробные версии» of the platform cabinet: browser trials of coffee shops — watch, extend, end, download. */
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CloudRequestError, endTrial, extendTrial, fetchTrialSnapshot, listTrials } from './api.ts';
import { CopyButton } from './cabinet-ui.tsx';
import { formatDayLabel } from './format.ts';
import { usePoll } from './hooks.ts';
import { describeCabinetError } from './license-form.ts';
import { Section, loadingText } from './shared.tsx';
import type { TrialStats, TrialView } from './trials.ts';
import {
  DEFAULT_TRIAL_URL,
  EXTEND_MAX_DAYS,
  EXTEND_MIN_DAYS,
  TRIAL_STATUS_LABEL,
  bytesText,
  daysText,
  effectiveStatus,
  isWorkingNow,
  lastDays,
  lastOrderText,
  lastSeenText,
  ordersText,
  parseExtendDays,
  trialBackup,
  trialBackupFileName,
  trialDate,
  trialMoney,
  trialTermText,
  trialTone,
} from './trials.ts';

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
      {lastSeenText(trial.lastSeenAt, now)}
    </span>
  );
}

function TrialCard({ trial, now, selected, onOpen }: { trial: TrialView; now: number; selected: boolean; onOpen: () => void }) {
  const s = trial.stats;
  return (
    <li>
      <button type="button" className="trial-card" aria-current={selected || undefined} onClick={onOpen}>
        <span className="trial-card-head">
          <strong className="trial-venue">{trial.venue || 'Без названия'}</strong>
          <TrialChip trial={trial} now={now} />
        </span>
        <span className="muted trial-line">
          {trial.managerName || 'управляющий не указан'} · начал(а) {trialDate(trial.startedAt)}
        </span>
        <span className="trial-line">{trialTermText(trial, now)}</span>
        <span className="trial-line">
          <LastSeen trial={trial} now={now} />
          {s?.shiftOpen && <span className="trial-badge">смена открыта</span>}
        </span>
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

const CHART_W = 560;
const CHART_H = 160;
const PAD_TOP = 24;
const PAD_BOTTOM = 22;

type ChartKind = 'orders' | 'revenue';

/** The last 14 days, bars of orders or revenue; the last bar is today. */
function TrialChart({ stats, now }: { stats: TrialStats; now: number }) {
  const [kind, setKind] = useState<ChartKind>('orders');
  const days = lastDays(stats.days, CHART_DAYS, now);
  const value = (d: TrialStats['days'][number]) => (kind === 'orders' ? d.orders : d.revenue);
  const label = (v: number) => (kind === 'orders' ? ordersText(v) : trialMoney(v));
  const max = Math.max(1, ...days.map(value));
  const total = days.reduce((sum, d) => sum + value(d), 0);
  const slot = CHART_W / days.length;
  const barW = Math.max(6, slot * 0.62);
  const plotH = CHART_H - PAD_TOP - PAD_BOTTOM;
  const baseY = CHART_H - PAD_BOTTOM;
  return (
    <figure className="chart trial-chart">
      <div className="trial-chart-head">
        <span className="muted">За {daysText(CHART_DAYS)}</span>
        <span className="seg trial-seg" role="tablist" aria-label="Что показать">
          <button type="button" role="tab" aria-selected={kind === 'orders'} onClick={() => setKind('orders')}>
            Заказы
          </button>
          <button type="button" role="tab" aria-selected={kind === 'revenue'} onClick={() => setKind('revenue')}>
            Выручка
          </button>
        </span>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label={`${kind === 'orders' ? 'Заказы' : 'Выручка'} по дням за ${daysText(CHART_DAYS)}`}>
        <line className="chart-axis" x1={0} x2={CHART_W} y1={baseY} y2={baseY} />
        <text className="chart-max" x={0} y={PAD_TOP - 10}>
          макс. {label(max === 1 && total === 0 ? 0 : max)}
        </text>
        {days.map((d, i) => {
          const v = value(d);
          const h = (v / max) * plotH;
          const x = i * slot + (slot - barW) / 2;
          const last = i === days.length - 1;
          const showLabel = last || i % 2 === 0;
          return (
            <g key={d.day} className="chart-bar" data-today={last || undefined}>
              <title>
                {formatDayLabel(d.day)}: {ordersText(d.orders)}, {trialMoney(d.revenue)}
              </title>
              <rect x={x} y={baseY - h} width={barW} height={Math.max(h, v > 0 ? 2 : 0)} rx={2} />
              {showLabel && (
                <text className="chart-label" x={x + barW / 2} y={CHART_H - 6} textAnchor="middle">
                  {formatDayLabel(d.day, !last)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
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
  onClose,
}: {
  trial: TrialView;
  now: number;
  editable: boolean;
  onChanged: (t: TrialView) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [custom, setCustom] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const s = trial.stats;
  const status = effectiveStatus(trial, now);

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

  function end() {
    void act(async () => {
      onChanged(await endTrial(trial.id));
      setConfirmEnd(false);
      return 'Пробный период завершён.';
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
          <dt>Пробный период</dt>
          <dd className="lic-line">
            <TrialChip trial={trial} now={now} />
            <span className="muted">{trialTermText(trial, now)}</span>
          </dd>
        </div>
        <div>
          <dt>Управляющий</dt>
          <dd>{trial.managerName || '—'}</dd>
        </div>
        <div>
          <dt>Начало</dt>
          <dd>{trialDate(trial.startedAt)}</dd>
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
              <span className="stat-label">Касса</span>
              <span className="stat-value">{s.shiftOpen ? 'Смена открыта' : 'Смена закрыта'}</span>
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
          <h3>Завершить пробный период досрочно?</h3>
          <p className="hint">
            Пробная версия «{trial.venue}» закончится сейчас. Данные клиента останутся — их можно скачать кнопкой «Скачать копию данных».
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

      {editable && !confirmEnd && (
        <div className="trial-actions">
          <div className="row wrap">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => extend(7)}>
              Продлить на 7 дней
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => extend(14)}>
              +14 дней
            </button>
            <form className="trial-custom" onSubmit={extendCustom}>
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
          <div className="row wrap">
            <button type="button" className="btn" disabled={busy} onClick={download}>
              Скачать копию данных
            </button>
            {status === 'active' && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirmEnd(true)}>
                Завершить досрочно
              </button>
            )}
          </div>
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
      <p>Пока никто не начал пробный период.</p>
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

/** The «Пробные версии» tab: the list, refreshed every minute, and the opened trial above it. */
export function TrialsSection({ editable }: { editable: boolean }) {
  const load = useCallback(() => listTrials(), []);
  const { data, error, reload } = usePoll(load, 60_000);
  const [selected, setSelected] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, TrialView>>({});
  // An action shows the cloud's answer at once; the next poll brings the same and drops it.
  useEffect(() => setOverrides({}), [data]);
  const now = Date.now();

  const trials = (data ?? []).map((t) => overrides[t.id] ?? t);
  const current = trials.find((t) => t.id === selected) ?? null;
  const working = trials.filter((t) => isWorkingNow(t.lastSeenAt, now)).length;

  return (
    <>
      {current && (
        <TrialDetail
          key={current.id}
          trial={current}
          now={now}
          editable={editable}
          onChanged={(t) => {
            setOverrides((o) => ({ ...o, [t.id]: t }));
            void reload();
          }}
          onClose={() => setSelected(null)}
        />
      )}
      <Section
        title="Пробные версии"
        aside={
          <span className="panel-aside">
            {working > 0 && <span className="muted">сейчас работают: {working}</span>}
            <span className="panel-total">{data?.length ?? ''}</span>
          </span>
        }
      >
        {data ? (
          trials.length === 0 ? (
            <TrialsEmpty />
          ) : (
            <ul className="trial-list">
              {trials.map((t) => (
                <TrialCard
                  key={t.id}
                  trial={t}
                  now={now}
                  selected={t.id === selected}
                  onOpen={() => {
                    setSelected(t.id);
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                />
              ))}
            </ul>
          )
        ) : (
          <p className="empty">{loadingText(error, 'пробные версии')}</p>
        )}
      </Section>
    </>
  );
}
