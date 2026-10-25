import { useEffect, useMemo, useRef, useState } from 'react';
import type { CounterOrderView, CounterStage } from '@bills/domain';
import { canMoveStage, COUNTER_SERVICE_LABEL, nextStage } from '@bills/domain';
import { Icon } from '../icons.tsx';
import { OfflineBanner } from '../OfflineBanner.tsx';
import { hrefFor } from '../router.tsx';
import { Toast, useToast } from '../ui.tsx';
import { useHub, useServerNow } from '../useHub.tsx';
import {
  chime,
  COUNTER_POLL_MS,
  fetchCounterOrders,
  formatAge,
  moveCounterStage,
  productNameOf,
  usePolling,
  useSoundSetting,
} from './cafe.ts';
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

/** Orders older than this get a yellow timer, then a red one. */
const WARN_MS = 5 * 60_000;
const LATE_MS = 10 * 60_000;
/** How long a new card flashes. */
const FRESH_MS = 8000;

/**
 * #/barista — the queue at the coffee machine: new orders, being made, ready.
 * One big button per card moves it on; «назад» fixes a tap by mistake. A new
 * order beeps (can be muted on this device) and flashes.
 */
export function BaristaPage() {
  const { actor, online, version, blockedReason } = useHub();
  const serverNow = useServerNow();
  const { toast, show, clear } = useToast();
  // HUB change events (version) refresh at once; the poll covers a HUB without counter events.
  const { data, error, reload } = usePolling(fetchCounterOrders, COUNTER_POLL_MS, version);
  const [soundOn, setSoundOn] = useSoundSetting();
  const blocked = blockedReason('counter.stage');

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

  const move = async (order: CounterOrderView, to: CounterStage) => {
    if (!canMoveStage(order.stage, to) || moving.has(order.id)) return;
    setMoving((m) => new Map(m).set(order.id, to));
    try {
      await moveCounterStage(actor, order.id, to);
      await reload();
    } catch (e) {
      show((e as Error).message);
    } finally {
      setMoving((m) => {
        const next = new Map(m);
        next.delete(order.id);
        return next;
      });
    }
  };

  const byStage = (stage: CounterStage) =>
    orders.filter((o) => o.stage === stage && o.status !== 'CANCELLED').sort((a, b) => a.createdAt - b.createdAt);

  return (
    <section className="page barista">
      <OfflineBanner online={online} />
      <div className="barista-bar">
        <p className="hint">
          {data ? `В работе: ${orders.filter((o) => o.stage !== 'ISSUED' && o.status !== 'CANCELLED').length}` : error ? `Нет данных: ${error}` : 'Загрузка…'}
        </p>
        <div className="row">
          <a className="btn btn-small barista-board-link" href={hrefFor('/board')}>
            <Icon name="tv" size={18} /> Экран для гостей
          </a>
          <button
            type="button"
            className="btn btn-small"
            aria-pressed={soundOn}
            onClick={() => setSoundOn(!soundOn)}
            title={soundOn ? 'Звук нового заказа включён' : 'Звук выключен'}
          >
            <Icon name={soundOn ? 'volume' : 'mute'} size={18} /> {soundOn ? 'Звук' : 'Без звука'}
          </button>
        </div>
      </div>
      {blocked && <p className="blocked-note">{blocked}</p>}
      {data && error && <p className="hint hint-warn">Нет связи с кассой, показан последний список: {error}</p>}

      <div className="barista-cols">
        {COLUMNS.map((col) => {
          const list = byStage(col.stage);
          return (
            <section key={col.stage} className="barista-col" data-stage={col.stage} aria-labelledby={`col-${col.stage}`}>
              <header className="barista-col-head">
                <h2 id={`col-${col.stage}`}>{col.title}</h2>
                <span className="barista-count">{list.length}</span>
              </header>
              {list.length === 0 ? (
                <p className="empty barista-empty">{data ? col.empty : ''}</p>
              ) : (
                <ul className="barista-cards">
                  {list.map((o) => (
                    <OrderCard
                      key={o.id}
                      order={o}
                      age={serverNow - o.createdAt}
                      fresh={fresh.has(o.id)}
                      busy={moving.has(o.id) || !online || blocked !== null}
                      onMove={(to) => void move(o, to)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      <Toast message={toast} onClose={clear} />
    </section>
  );
}

function OrderCard({
  order: o,
  age,
  fresh,
  busy,
  onMove,
}: {
  order: CounterOrderView;
  age: number;
  fresh: boolean;
  busy: boolean;
  onMove: (to: CounterStage) => void;
}) {
  const next = nextStage(o.stage);
  const back: CounterStage | null = o.stage === 'PREPARING' ? 'NEW' : o.stage === 'READY' ? 'PREPARING' : null;
  // Ready orders wait for the guest: their timer is not the barista's problem.
  const late = o.stage === 'READY' ? undefined : age >= LATE_MS ? 'late' : age >= WARN_MS ? 'warn' : undefined;
  return (
    <li className="barista-card" data-fresh={fresh || undefined} data-stage={o.stage}>
      <div className="barista-card-head">
        <span className="barista-number">{o.number}</span>
        <span className="barista-meta">
          <span className="service-badge" data-service={o.service}>
            {COUNTER_SERVICE_LABEL[o.service]}
          </span>
          {o.status === 'OPEN' && <span className="tag tag-warn">не оплачен</span>}
          <span className="barista-age" data-late={late} title="С момента заказа">
            {formatAge(age)}
          </span>
        </span>
      </div>
      {o.guestName && <p className="barista-guest">{o.guestName}</p>}
      <ul className="barista-lines">
        {o.items.map((it) => (
          <li key={it.id}>
            <span className="barista-qty">{it.qty}×</span>
            <span>
              <strong>{productNameOf(it)}</strong>
              {it.optionNames.length > 0 && <span className="barista-options">{it.optionNames.join(' · ')}</span>}
            </span>
          </li>
        ))}
      </ul>
      {o.note && <p className="barista-note">{o.note}</p>}
      <div className="barista-actions">
        {back && (
          <button type="button" className="btn btn-small btn-ghost barista-back" disabled={busy} onClick={() => onMove(back)}>
            назад
          </button>
        )}
        {next && (
          <button type="button" className="btn btn-primary barista-next" data-to={next} disabled={busy} onClick={() => onMove(next)}>
            {NEXT_LABEL[o.stage]}
          </button>
        )}
      </div>
    </li>
  );
}
