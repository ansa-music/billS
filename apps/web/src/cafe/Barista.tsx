import { useEffect, useMemo, useRef, useState } from 'react';
import type { AllDayLine, CounterOrderView, CounterStage } from '@bills/domain';
import {
  allDayCounts,
  canMoveStage,
  canRecallOrder,
  COUNTER_SERVICE_LABEL,
  COUNTER_STAGE_LABEL,
  counterItemName,
  isAttentionOption,
  nextStage,
  previousStage,
} from '@bills/domain';
import { Modal } from '../cash/Modal.tsx';
import { formatClock } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useFullscreen } from '../kiosk.ts';
import { hrefFor } from '../router.tsx';
import { Toast, useToast } from '../ui.tsx';
import { useHub, useServerNow } from '../useHub.tsx';
import { chime, COUNTER_POLL_MS, fetchCounterOrders, formatAge, moveCounterStage, usePolling, useSoundSetting } from './cafe.ts';
import type { CancelTarget } from './CounterCancelDialog.tsx';
import { CounterCancelDialog } from './CounterCancelDialog.tsx';
import { useAudioUnlock, useFillHeight, useScreenAwake } from './staff-device.ts';
import { StopListDialog } from './StopList.tsx';
import './cafe.css';

const COLUMNS: Array<{ stage: CounterStage; title: string; empty: string }> = [
  { stage: 'NEW', title: 'Новые', empty: 'Новых заказов нет' },
  { stage: 'PREPARING', title: 'Готовятся', empty: 'Ничего не готовится' },
  { stage: 'READY', title: 'Готовы', empty: 'Готовых нет' },
];

/** The big button: where the order goes next. */
const NEXT_LABEL: Record<CounterStage, string> = {
  NEW: 'Начать',
  PREPARING: 'Готово',
  READY: 'Выдан',
  ISSUED: '',
};

/** Orders older than this turn amber, then red (the timer and the whole card). */
const WARN_MS = 5 * 60_000;
const LATE_MS = 10 * 60_000;
/** How long a new card flashes. */
const FRESH_MS = 8000;
/** How long «Вернуть» stays offered after a move. */
const UNDO_MS = 10_000;
const WAKE_HINT_KEY = 'bills.cafe.wakeHint';

interface LastMove {
  orderId: string;
  number: number;
  from: CounterStage;
  to: CounterStage;
  at: number;
}

const itemsSummary = (o: CounterOrderView) =>
  o.items.map((it) => (it.qty > 1 ? `${counterItemName(it)} ×${it.qty}` : counterItemName(it))).join(', ');

/**
 * #/barista — the KDS at the coffee machine: new orders, being made, ready. Big cards readable
 * from a step or two away, one big button per card, colour by waiting time, «Всего в работе»
 * over the queue, «Вернуть» for the last step (an issued order too, for a while), a beep on a
 * new order (the first tap anywhere unlocks the sound), the screen kept awake, fullscreen.
 * Three columns on a landscape tablet and a PC (a portrait tablet keeps «Готовы» narrow, as small
 * tickets), tabs on a phone; from a tablet up the KDS fills the window and the columns scroll.
 * Live: HUB change events (`version`, which also bumps on a reconnect), a poll, a re-read when
 * the network comes back; the last list stays on screen while the HUB is out of reach.
 */
export function BaristaPage() {
  const { actor, online, version, blockedReason, canNow, state, notify } = useHub();
  const serverNow = useServerNow();
  const { toast, show, clear } = useToast();
  // HUB change events (version) refresh at once; the poll covers a HUB without counter events.
  const { data, error, reload } = usePolling(fetchCounterOrders, COUNTER_POLL_MS, version);
  const [soundOn, setSoundOn] = useSoundSetting();
  const audio = useAudioUnlock(soundOn);
  const awake = useScreenAwake();
  const fullscreen = useFullscreen();
  const blocked = blockedReason('counter.stage');
  // Cancelling an order is the manager's and the administrator's; the stop list is for the bar.
  const canCancel = canNow('counter.cancel');
  const canStop = canNow('catalog.stop');
  const [cancelling, setCancelling] = useState<CancelTarget | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [issuedOpen, setIssuedOpen] = useState(false);
  const [tab, setTab] = useState<CounterStage>('NEW');
  const [last, setLast] = useState<LastMove | null>(null);
  const [wakeHint, setWakeHint] = useState(() => {
    try {
      return localStorage.getItem(WAKE_HINT_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const root = useRef<HTMLElement>(null);
  useFillHeight(root);

  // Back on the network (Wi-Fi dropped, the tablet slept): read the queue at once.
  useEffect(() => {
    const onOnline = () => void reload();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [reload]);

  // Optimistic stage while the command is in flight: the card moves at once.
  const [moving, setMoving] = useState<ReadonlyMap<string, CounterStage>>(new Map());
  const orders = useMemo(
    () => (data?.orders ?? []).map((o) => (moving.has(o.id) ? { ...o, stage: moving.get(o.id)! } : o)),
    [data, moving],
  );

  // New orders → beep and flash. The first load only remembers what is there.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!data) return;
    const ids = data.orders.map((o) => o.id);
    if (seen.current) {
      const added = data.orders.filter((o) => o.stage === 'NEW' && !seen.current!.has(o.id));
      if (added.length > 0) {
        const now = Date.now();
        setFresh((prev) => {
          const next = new Map(prev);
          for (const o of added) next.set(o.id, now);
          return next;
        });
        if (soundOn) chime('new');
      }
      for (const id of ids) seen.current.add(id);
    } else {
      seen.current = new Set(ids);
    }
  }, [data, soundOn]);
  useEffect(() => {
    if (fresh.size === 0) return;
    const t = setTimeout(() => {
      const now = Date.now();
      setFresh((prev) => new Map([...prev].filter(([, at]) => now - at < FRESH_MS)));
    }, 1000);
    return () => clearTimeout(t);
  }, [fresh]);

  // «Вернуть» is offered for a few seconds after a move.
  useEffect(() => {
    if (!last) return;
    const t = setTimeout(() => setLast((l) => (l === last ? null : l)), UNDO_MS);
    return () => clearTimeout(t);
  }, [last]);

  /** Moves the order; `undo` — a step back from «Вернуть», which is not offered back again. */
  const move = async (order: CounterOrderView, to: CounterStage, undo = false): Promise<boolean> => {
    if (!canMoveStage(order.stage, to, { issuedAt: order.issuedAt, now: serverNow }) || moving.has(order.id)) return false;
    const from = order.stage;
    setMoving((m) => new Map(m).set(order.id, to));
    try {
      await moveCounterStage(actor, order.id, to);
      setLast(undo ? null : { orderId: order.id, number: order.number, from, to, at: Date.now() });
      await reload();
      return true;
    } catch (e) {
      show((e as Error).message);
      return false;
    } finally {
      setMoving((m) => {
        const next = new Map(m);
        next.delete(order.id);
        return next;
      });
    }
  };

  const undoLast = () => {
    if (!last) return;
    const order = orders.find((o) => o.id === last.orderId);
    if (!order || order.stage !== last.to) {
      setLast(null);
      return;
    }
    void move(order, last.from, true);
  };

  const active = orders.filter((o) => o.stage !== 'ISSUED' && o.status !== 'CANCELLED');
  const byStage = (stage: CounterStage) => active.filter((o) => o.stage === stage).sort((a, b) => a.createdAt - b.createdAt);
  const allDay = useMemo(() => allDayCounts(orders), [orders]);
  const recallable = orders
    .filter((o) => o.stage === 'ISSUED' && o.status !== 'CANCELLED' && canRecallOrder(o.issuedAt, serverNow))
    .sort((a, b) => (b.issuedAt ?? 0) - (a.issuedAt ?? 0));
  const newCount = byStage('NEW').length;
  const freshNew = active.some((o) => o.stage === 'NEW' && fresh.has(o.id));
  const busyAll = !online || blocked !== null;

  const dismissWakeHint = () => {
    setWakeHint(false);
    try {
      localStorage.setItem(WAKE_HINT_KEY, 'off');
    } catch {
      // Private mode: the hint comes back next time.
    }
  };

  return (
    <section ref={root} className="page kds" data-sound-locked={(soundOn && !audio.unlocked) || undefined}>
      <header className="kds-bar">
        <div className="kds-load" aria-live="polite">
          <strong className="kds-load-num">{data ? active.length : '…'}</strong>
          <span className="kds-load-label">в работе</span>
        </div>
        <AllDay lines={allDay} />
        <div className="kds-tools">
          {!online || (data && error) ? (
            <span className="kds-offline" role="status" title={error ?? undefined}>
              <span className="conn-dot" aria-hidden="true" /> Нет связи
            </span>
          ) : null}
          <button
            type="button"
            className="kds-tool"
            onClick={() => setIssuedOpen(true)}
            disabled={recallable.length === 0}
            aria-label={`Выданные: ${recallable.length}`}
            title="Выданные за последние 15 минут: вернуть в «Готовы»"
          >
            <Icon name="rotate" size={20} />
            <span className="kds-tool-label">Выданные</span>
            {recallable.length > 0 && <span className="kds-tool-count">{recallable.length}</span>}
          </button>
          {canStop && (
            <button type="button" className="kds-tool" onClick={() => setStopOpen(true)} aria-label="Стоп-лист" title="Стоп-лист: что закончилось">
              <Icon name="stop" size={20} />
              <span className="kds-tool-label">Стоп-лист</span>
            </button>
          )}
          <a className="kds-tool" href={hrefFor('/board')} aria-label="Экран заказов для гостей" title="Экран заказов для гостей">
            <Icon name="tv" size={20} />
            <span className="kds-tool-label">Экран гостей</span>
          </a>
          <button
            type="button"
            className="kds-tool"
            aria-pressed={soundOn}
            aria-label="Звук нового заказа"
            onClick={() => setSoundOn(!soundOn)}
            title={soundOn ? 'Звук нового заказа включён — выключить' : 'Звук выключен — включить'}
          >
            <Icon name={soundOn ? 'volume' : 'mute'} size={20} />
            <span className="kds-tool-label">{soundOn ? 'Звук' : 'Без звука'}</span>
          </button>
          {fullscreen.supported && (
            <button
              type="button"
              className="kds-tool kds-tool-fs"
              onClick={fullscreen.toggle}
              title={fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран'}
              aria-label={fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран'}
            >
              <Icon name={fullscreen.active ? 'fullscreen-exit' : 'fullscreen'} size={20} />
            </button>
          )}
        </div>
      </header>

      {soundOn && !audio.unlocked && (
        <button
          type="button"
          className="kds-hint kds-hint-sound"
          onClick={() => void audio.unlock().then((ok) => ok && chime('new'))}
        >
          <Icon name="volume" size={22} />
          <span>
            <strong>Звук новых заказов ещё не включён.</strong> Коснитесь экрана в любом месте — или здесь.
          </span>
        </button>
      )}
      {awake === 'unsupported' && wakeHint && (
        <p className="kds-hint kds-hint-wake">
          <Icon name="alert" size={20} />
          <span>Экран может гаснуть: этот браузер не держит его включённым. В настройках планшета выключите автоблокировку.</span>
          <button type="button" className="kds-hint-close" onClick={dismissWakeHint} aria-label="Понятно, скрыть">
            <Icon name="close" size={18} />
          </button>
        </p>
      )}
      {blocked && <p className="blocked-note">{blocked}</p>}
      {!data && error && <p className="kds-hint kds-hint-wake">Нет данных: {error}</p>}

      <div className="kds-tabs" role="tablist" aria-label="Этапы">
        {COLUMNS.map((col) => (
          <button
            key={col.stage}
            type="button"
            role="tab"
            className="kds-tab"
            data-stage={col.stage}
            aria-selected={tab === col.stage}
            data-alert={(col.stage === 'NEW' && tab !== 'NEW' && freshNew) || undefined}
            onClick={() => setTab(col.stage)}
          >
            {col.title}
            <span className="kds-tab-count">{col.stage === 'NEW' ? newCount : byStage(col.stage).length}</span>
          </button>
        ))}
      </div>

      <div className="kds-board">
        {COLUMNS.map((col) => {
          const list = byStage(col.stage);
          return (
            <section
              key={col.stage}
              className="kds-col"
              data-stage={col.stage}
              data-active={tab === col.stage || undefined}
              aria-labelledby={`kds-col-${col.stage}`}
            >
              <header className="kds-col-head">
                <h2 id={`kds-col-${col.stage}`}>{col.title}</h2>
                <span className="kds-col-count">{list.length}</span>
              </header>
              {list.length === 0 ? (
                <p className="kds-empty">{data ? col.empty : 'Загрузка…'}</p>
              ) : (
                <ul className="kds-cards">
                  {list.map((o) => (
                    <OrderCard
                      key={o.id}
                      order={o}
                      now={serverNow}
                      fresh={fresh.has(o.id)}
                      busy={moving.has(o.id) || busyAll}
                      onMove={(to) => void move(o, to)}
                      onCancel={
                        canCancel && o.status === 'OPEN'
                          ? () => setCancelling({ orderId: o.id, number: o.number, total: o.total, summary: itemsSummary(o) })
                          : undefined
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      {last && (
        <div className="kds-undo" role="status">
          <span className="kds-undo-text">
            Заказ <strong>{last.number}</strong> → «{COUNTER_STAGE_LABEL[last.to]}»
          </span>
          <button type="button" className="kds-undo-btn" onClick={undoLast} disabled={busyAll || moving.has(last.orderId)}>
            <Icon name="rotate" size={20} /> Вернуть
          </button>
          <button type="button" className="kds-undo-close" onClick={() => setLast(null)} aria-label="Скрыть">
            <Icon name="close" size={18} />
          </button>
        </div>
      )}

      {issuedOpen && (
        <Modal
          title="Выданные"
          onClose={() => setIssuedOpen(false)}
          className="kds-issued-modal"
          footer={
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setIssuedOpen(false)}>
                Готово
              </button>
            </div>
          }
        >
          <p className="hint">Выдали не тот заказ или гость вернулся — верните заказ в «Готовы». Можно в течение 15 минут.</p>
          {recallable.length === 0 ? (
            <p className="empty">За последние 15 минут ничего не выдавали.</p>
          ) : (
            <ul className="kds-issued">
              {recallable.map((o) => (
                <li key={o.id} className="kds-issued-row">
                  <span className="kds-issued-num">{o.number}</span>
                  <span className="kds-issued-text">
                    <strong>{o.guestName ?? itemsSummary(o)}</strong>
                    <span className="muted">
                      {o.guestName ? `${itemsSummary(o)} · ` : ''}выдан в {formatClock(o.issuedAt ?? serverNow, state.club.timezone)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={busyAll || moving.has(o.id)}
                    onClick={() => void move(o, 'READY', true).then((ok) => ok && show(`Заказ ${o.number} снова в «Готовы»`))}
                  >
                    Вернуть
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
      {cancelling && (
        <CounterCancelDialog
          target={cancelling}
          actor={actor}
          currency={state.club.currency}
          onClose={() => setCancelling(null)}
          onDone={(message) => {
            setCancelling(null);
            show(message);
            void reload();
          }}
        />
      )}
      {stopOpen && <StopListDialog actor={actor} onClose={() => setStopOpen(false)} notify={notify} />}
      <Toast message={toast} onClose={clear} />
    </section>
  );
}

/** «Всего в работе»: what to make over the new and the preparing orders, most first. */
function AllDay({ lines }: { lines: AllDayLine[] }) {
  if (lines.length === 0) return <p className="kds-allday kds-allday-empty">Всего в работе: пусто</p>;
  return (
    <div className="kds-allday" aria-label="Всего в работе">
      <span className="kds-allday-title">Всего в работе</span>
      <ul className="kds-allday-list">
        {lines.map((l) => (
          <li key={l.name} className="kds-allday-item">
            <strong className="kds-allday-qty">{l.qty}</strong> {l.name}
            {l.attention.map((a) => (
              <span key={a.option} className="kds-attn">
                {a.option} {a.qty}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrderCard({
  order: o,
  now,
  fresh,
  busy,
  onMove,
  onCancel,
}: {
  order: CounterOrderView;
  now: number;
  fresh: boolean;
  busy: boolean;
  onMove: (to: CounterStage) => void;
  /** Only for the manager and the administrator, on an unpaid order. */
  onCancel?: () => void;
}) {
  const next = nextStage(o.stage);
  const back = o.stage === 'NEW' ? null : previousStage(o.stage);
  const age = now - o.createdAt;
  // Ready orders wait for the guest: their timer counts from «Готово» and is not the barista's problem.
  const ready = o.stage === 'READY';
  const shown = ready ? now - (o.readyAt ?? o.createdAt) : age;
  const level = ready ? 'ready' : age >= LATE_MS ? 'late' : age >= WARN_MS ? 'warn' : 'ok';
  return (
    <li className="kds-card" data-stage={o.stage} data-age={level} data-fresh={fresh || undefined}>
      <div className="kds-card-head">
        <span className="kds-num">{o.number}</span>
        <span className="kds-service" data-service={o.service}>
          {COUNTER_SERVICE_LABEL[o.service]}
        </span>
        <span className="kds-timer" title={ready ? 'Ждёт гостя с момента «Готово»' : 'С момента заказа'}>
          <Icon name="clock" size={18} />
          {formatAge(shown)}
        </span>
      </div>
      {(o.guestName || o.status === 'OPEN') && (
        <p className="kds-guest">
          {o.guestName && <span className="kds-guest-name">{o.guestName}</span>}
          {o.status === 'OPEN' && <span className="kds-unpaid">не оплачен</span>}
        </p>
      )}
      <ul className="kds-items">
        {o.items.map((it) => (
          <li key={it.id} className="kds-item" data-many={it.qty > 1 || undefined}>
            <span className="kds-qty">{it.qty}×</span>
            <span className="kds-item-text">
              <strong className="kds-item-name">{counterItemName(it)}</strong>
              {it.optionNames.length > 0 && (
                <span className="kds-opts">
                  {it.optionNames.map((name, i) => (
                    <span key={`${name}-${i}`} className="kds-opt" data-attn={isAttentionOption(name) || undefined}>
                      {name}
                    </span>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {ready && <p className="kds-summary">{itemsSummary(o)}</p>}
      {o.note && (
        <p className="kds-note">
          <Icon name="alert" size={18} />
          {o.note}
        </p>
      )}
      <div className="kds-actions">
        {onCancel && (
          <button type="button" className="kds-cancel" disabled={busy} onClick={onCancel}>
            Отменить
          </button>
        )}
        {back && (
          <button
            type="button"
            className="kds-back"
            disabled={busy}
            onClick={() => onMove(back)}
            aria-label={`Назад в «${COLUMNS.find((c) => c.stage === back)?.title ?? COUNTER_STAGE_LABEL[back]}»`}
            title={`Назад в «${COLUMNS.find((c) => c.stage === back)?.title ?? COUNTER_STAGE_LABEL[back]}»`}
          >
            <Icon name="back" size={22} />
          </button>
        )}
        {next && (
          <button type="button" className="kds-next" data-to={next} disabled={busy} onClick={() => onMove(next)}>
            {NEXT_LABEL[o.stage]}
          </button>
        )}
      </div>
    </li>
  );
}
