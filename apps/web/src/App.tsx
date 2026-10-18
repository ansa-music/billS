import { useCallback, useEffect, useRef, useState } from 'react';
import type { HubState } from '@bills/domain';
import { blinkTable, command, fetchState, setManualMode } from './api.ts';
import { CardBoundary } from './CardBoundary.tsx';
import { formatClock } from './format.ts';
import { alertsByTable, matchesFilter } from './hall.ts';
import { HallToolbar, useHallFilter } from './HallToolbar.tsx';
import { HardwarePanel, ManualModeBanner } from './Hardware.tsx';
import { useWakeLock } from './kiosk.ts';
import { OfflineBanner } from './OfflineBanner.tsx';
import { ShiftPanel } from './cash/ShiftPanel.tsx';
import { UnpaidPanel } from './cash/UnpaidPanel.tsx';
import { AlertsBar, SimulatorPanel } from './Panels.tsx';
import { TableCard } from './TableCard.tsx';

const ACTOR_KEY = 'bills.actor';

function readActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? 'Кассир';
  } catch {
    return 'Кассир';
  }
}

function useHubState() {
  const [state, setState] = useState<HubState | null>(null);
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState(false);
  const inFlight = useRef(false);
  const again = useRef(false);

  // Coalesces bursts of change events into one request at a time.
  const refresh = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      do {
        again.current = false;
        const s = await fetchState();
        setState(s);
        setOffset(s.serverNow - Date.now());
        setOnline(true);
      } while (again.current);
    } catch {
      setOnline(false);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => void refresh();
    events.addEventListener('changed', () => void refresh());
    events.onerror = () => setOnline(false);
    const poll = setInterval(() => void refresh(), 15_000);
    return () => {
      events.close();
      clearInterval(poll);
    };
  }, [refresh]);

  return { state, offset, online, refresh };
}

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function App() {
  const { state, offset, online, refresh } = useHubState();
  const now = useNow();
  const [actor, setActor] = useState(readActor);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useHallFilter();
  useWakeLock();

  useEffect(() => {
    try {
      localStorage.setItem(ACTOR_KEY, actor);
    } catch {
      // Storage may be blocked; the name just will not be remembered.
    }
  }, [actor]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy((b) => new Set(b).add(key));
      try {
        await fn();
      } catch (e) {
        setToast((e as Error).message);
      } finally {
        setBusy((b) => {
          const next = new Set(b);
          next.delete(key);
          return next;
        });
        void refresh();
      }
    },
    [refresh],
  );

  if (!state) {
    return (
      <main className="boot">
        <p>{online ? 'Загрузка…' : 'Подключаемся к HUB клуба…'}</p>
      </main>
    );
  }

  const serverNow = now + offset;
  const tableAlerts = alertsByTable(state.alerts);
  const shown = state.tables.filter((t) => matchesFilter(t, filter, tableAlerts.get(t.id)));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="ball" aria-hidden="true">
            8
          </span>
          <div>
            <h1>{state.club.name}</h1>
            <p className="muted">Экран зала</p>
          </div>
        </div>
        <div className="topbar-right">
          <label className="actor">
            <span className="muted">Сотрудник</span>
            <input value={actor} onChange={(e) => setActor(e.target.value)} maxLength={60} />
          </label>
          <span className="clock">{formatClock(serverNow, state.club.timezone)}</span>
          <span className="conn" data-online={online || undefined}>
            {online ? 'HUB на связи' : 'Нет связи с HUB'}
          </span>
        </div>
      </header>

      <OfflineBanner online={online} />

      <ManualModeBanner
        mode={state.manualMode}
        timezone={state.club.timezone}
        busy={busy.has('manual') || !online}
        onDisable={() => run('manual', () => setManualMode(actor, false))}
      />

      <AlertsBar
        alerts={state.alerts}
        timezone={state.club.timezone}
        busy={busy.size > 0}
        onResolve={(id) => run(`alert:${id}`, () => command(`/api/alerts/${id}/resolve`, actor))}
      />

      <div className="layout">
        <div className="hall">
          <HallToolbar tables={state.tables} alerts={tableAlerts} filter={filter} onFilter={setFilter} />
          {shown.length === 0 && <p className="empty">В этом фильтре столов нет</p>}
          <main className="tables" aria-label="Столы">
            {shown.map((table) => (
              <CardBoundary key={table.id} name={table.name} resetKey={table}>
                <TableCard
                  table={table}
                  tariffs={state.tariffs}
                  timezone={state.club.timezone}
                  alert={tableAlerts.get(table.id)}
                  currency={state.club.currency}
                  serverNow={serverNow}
                  busy={busy.has(table.id) || !online}
                  onOpen={(tariffId) =>
                    run(table.id, () => command(`/api/tables/${table.id}/open`, actor, { tariffId }))
                  }
                  onStop={(sessionId) => run(table.id, () => command(`/api/sessions/${sessionId}/stop`, actor))}
                />
              </CardBoundary>
            ))}
          </main>
        </div>
        <aside className="side">
          <ShiftPanel state={state} actor={actor} refresh={refresh} notify={setToast} />
          <UnpaidPanel state={state} actor={actor} refresh={refresh} notify={setToast} />
          <HardwarePanel
            state={state}
            busy={busy.has('manual') || !online}
            onBlink={(id) => run(`blink:${id}`, () => blinkTable(id, actor))}
            onManual={(enabled, reason) => run('manual', () => setManualMode(actor, enabled, reason))}
          />
          <SimulatorPanel onError={setToast} />
        </aside>
      </div>

      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
