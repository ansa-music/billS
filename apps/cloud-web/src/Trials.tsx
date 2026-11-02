/**
 * «Пробные версии» of the platform cabinet: browser coffee shops — watch, extend, end, download, and
 * «Сделать постоянной» (paid until a date or without an end) with «Продлить до…». Filters by plan and state.
 */
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CloudRequestError, endTrial, extendTrial, extendTrialUntil, fetchTrialSnapshot, listTrials, setTrialPlan } from './api.ts';
import { CopyButton } from './cabinet-ui.tsx';
import { formatDayLabel } from './format.ts';
import { usePoll } from './hooks.ts';
import { describeCabinetError } from './license-form.ts';
import { Section, loadingText } from './shared.tsx';
import type { TrialFilter, TrialSnapshot, TrialStats, TrialView } from './trials.ts';
import {
  DEFAULT_TRIAL_URL,
  PAID_MAX,
  TRIAL_FILTERS,
  TRIAL_PLAN_LABEL,
  filterTrials,
  paidLastDay,
  paidRequest,
  parseUntilDay,
  trialDay,
  EXTEND_MAX_DAYS,
  EXTEND_MIN_DAYS,
  TRIAL_STATUS_LABEL,
  agoText,
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

function PlanBadge({ trial }: { trial: TrialView }) {
  const plan = trial.plan === 'paid' ? 'paid' : 'trial';
  return (
    <span className="trial-plan" data-plan={plan}>
      {TRIAL_PLAN_LABEL[plan]}
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
          <span className="trial-chips">
            <PlanBadge trial={trial} />
            <TrialChip trial={trial} now={now} />
          </span>
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

/** The cabinet's copy file needs the plain SQLite: a gzip copy is unpacked in the browser. */
async function plainSnapshot(snap: TrialSnapshot): Promise<TrialSnapshot> {
  if (snap.encoding !== 'gzip') return snap;
  const bin = atob(snap.snapshot);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const out = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  let s = '';
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return { snapshot: btoa(s), snapshotAt: snap.snapshotAt, encoding: 'raw' };
}

function todayPlus(days: number, now: number): string {
  return trialDay(now + days * 86_400_000);
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
  const [makePaid, setMakePaid] = useState(false);
  const [paidDay, setPaidDay] = useState(() => todayPlus(30, now));
  const [forever, setForever] = useState(false);
  const [untilDay, setUntilDay] = useState('');
  const s = trial.stats;
  const status = effectiveStatus(trial, now);
  const paid = trial.plan === 'paid';

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

  function extendUntil(e: FormEvent) {
    e.preventDefault();
    const r = parseUntilDay(untilDay, now, paid ? PAID_MAX : EXTEND_MAX_DAYS);
    if ('error' in r) {
      setDone(null);
      setError(r.error);
      return;
    }
    void act(async () => {
      const next = await extendTrialUntil(trial.id, r.until);
      onChanged(next);
      setUntilDay('');
      return paid ? `Оплачено до ${trialDate(r.until - 1)}.` : `Продлено до ${trialDate(next.endsAt)}.`;
    });
  }

  function submitPaid(e: FormEvent) {
    e.preventDefault();
    const req = paidRequest(forever, paidDay, now);
    if ('error' in req) {
      setDone(null);
      setError(req.error);
      return;
    }
    void act(async () => {
      const next = await setTrialPlan(trial.id, req);
      onChanged(next);
      setMakePaid(false);
      return next.paidUntil ? `Постоянная версия: оплачено до ${trialDate(next.paidUntil - 1)}.` : 'Постоянная версия без срока.';
    });
  }

  function backToTrial() {
    if (!window.confirm(`Вернуть «${trial.venue}» в пробную версию на 14 дней?`)) return;
    void act(async () => {
      const next = await setTrialPlan(trial.id, { plan: 'trial', days: 14 });
      onChanged(next);
      return `Снова пробная: до ${trialDate(next.endsAt)}.`;
    });
  }

  function end() {
    void act(async () => {
      onChanged(await endTrial(trial.id));
      setConfirmEnd(false);
      return paid ? 'Доступ закрыт.' : 'Пробный период завершён.';
    });
  }

  function download() {
    void act(async () => {
      try {
        const snap = await plainSnapshot(await fetchTrialSnapshot(trial.id));
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
          <dt>Версия</dt>
          <dd className="lic-line">
            <PlanBadge trial={trial} />
          </dd>
        </div>
        <div>
          <dt>{paid ? 'Доступ' : 'Пробный период'}</dt>
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
              ? `${trialDate(trial.snapshotAt)} (${agoText(now - trial.snapshotAt)} назад)${trial.snapshotBytes ? ` · ${bytesText(trial.snapshotBytes)}` : ''}`
              : 'пока нет'}
          </dd>
        </div>
        <div>
          <dt>Телефон владельца</dt>
          <dd>{trial.viewLink ? 'ссылка включена' : 'ссылки нет'}</dd>
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

      {editable && makePaid && (
        <form className="sub-panel trial-paid-form" onSubmit={submitPaid} noValidate>
          <h3>{paid ? 'Срок постоянной версии' : 'Сделать постоянной'}</h3>
          <p className="hint">Кофейня продолжит работать в браузере. Касса узнает об этом сама в течение нескольких минут.</p>
          <div className="row wrap">
            <label className="field">
              <span>Оплачено до (включительно)</span>
              <input type="date" value={paidDay} disabled={forever} min={todayPlus(0, now)} onChange={(e) => setPaidDay(e.target.value)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={forever} onChange={(e) => setForever(e.target.checked)} /> без срока
            </label>
          </div>
          <div className="row wrap">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Сохраняем…' : paid ? 'Сохранить' : 'Сделать постоянной'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setMakePaid(false)}>
              Отмена
            </button>
          </div>
        </form>
      )}

      {editable && confirmEnd && (
        <div className="sub-panel">
          <h3>{paid ? 'Закрыть доступ?' : 'Завершить пробный период досрочно?'}</h3>
          <p className="hint">
            {paid ? `Касса «${trial.venue}» перейдёт в режим «только чтение».` : `Пробная версия «${trial.venue}» закончится сейчас.`} Данные клиента останутся — их можно скачать кнопкой «Скачать копию данных».
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

      {editable && !confirmEnd && !makePaid && (
        <div className="trial-actions">
          <div className="row wrap">
            {paid ? (
              <>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
                  setForever(!trial.paidUntil);
                  if (trial.paidUntil) setPaidDay(paidLastDay(trial.paidUntil));
                  setMakePaid(true);
                }}>
                  Изменить срок
                </button>
                <button type="button" className="btn" disabled={busy} onClick={backToTrial}>
                  Вернуть в пробную
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setMakePaid(true)}>
                Сделать постоянной
              </button>
            )}
          </div>
          {(!paid || trial.paidUntil) && (
            <form className="trial-custom" onSubmit={extendUntil} noValidate>
              <label className="field trial-custom-field">
                <span>Продлить до…</span>
                <input type="date" value={untilDay} min={todayPlus(1, now)} onChange={(e) => setUntilDay(e.target.value)} />
              </label>
              <button type="submit" className="btn" disabled={busy || untilDay === ''}>
                Продлить до даты
              </button>
            </form>
          )}
          {!paid && (
          <div className="row wrap">
            <button type="button" className="btn" disabled={busy} onClick={() => extend(7)}>
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
          <div className="row wrap">
            <button type="button" className="btn" disabled={busy} onClick={download}>
              Скачать копию данных
            </button>
            {status === 'active' && (
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setConfirmEnd(true)}>
                {paid ? 'Закрыть доступ' : 'Завершить досрочно'}
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
  const [filter, setFilter] = useState<TrialFilter>('all');
  // An action shows the cloud's answer at once; the next poll brings the same and drops it.
  useEffect(() => setOverrides({}), [data]);
  const now = Date.now();

  const trials = (data ?? []).map((t) => overrides[t.id] ?? t);
  const current = trials.find((t) => t.id === selected) ?? null;
  const working = trials.filter((t) => isWorkingNow(t.lastSeenAt, now)).length;
  const shown = filterTrials(trials, filter, now);

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
            <>
            <div className="seg seg-wrap trial-filters" role="tablist" aria-label="Какие показать">
              {TRIAL_FILTERS.map((f) => (
                <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label} <span className="muted">{filterTrials(trials, f.id, now).length}</span>
                </button>
              ))}
            </div>
            {shown.length === 0 && <p className="empty">Таких пока нет.</p>}
            <ul className="trial-list">
              {shown.map((t) => (
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
            </>
          )
        ) : (
          <p className="empty">{loadingText(error, 'пробные версии')}</p>
        )}
      </Section>
    </>
  );
}
