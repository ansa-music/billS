import { useCallback, useEffect, useState } from 'react';
import { useWakeLock } from './kiosk.ts';
import { OfflineBanner } from './OfflineBanner.tsx';
import { SECTION_TITLE, useRoute } from './router.ts';
import { BottomNav, Sidebar, Toast, Topbar } from './Shell.tsx';
import type { NavBadges } from './Shell.tsx';
import { useTheme } from './theme.ts';
import { HubContext, useCommands, useHubConnection, useNow } from './useHub.ts';
import type { HubContextValue } from './useHub.ts';
import { HallSection } from './sections/Hall.tsx';
import { ChecksSection } from './sections/Checks.tsx';
import { StatsSection } from './sections/Stats.tsx';
import { TariffsSection } from './sections/Tariffs.tsx';
import { JournalSection } from './sections/Journal.tsx';
import { EquipmentSection } from './sections/Equipment.tsx';

const ACTOR_KEY = 'bills.actor';

function readActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? 'Кассир';
  } catch {
    return 'Кассир';
  }
}

export function App() {
  const hub = useHubConnection();
  const route = useRoute();
  const now = useNow();
  const { theme, cycle } = useTheme();
  const [actor, setActor] = useState(readActor);
  const [toast, setToast] = useState<string | null>(null);
  const commands = useCommands(actor, hub.refresh, setToast);
  useWakeLock();

  useEffect(() => {
    try {
      localStorage.setItem(ACTOR_KEY, actor);
    } catch {
      // Storage may be blocked; the name just will not be remembered.
    }
  }, [actor]);

  useEffect(() => {
    document.title = `${SECTION_TITLE[route.section]} — Billiard Control`;
  }, [route.section]);

  const closeToast = useCallback(() => setToast(null), []);
  const state = hub.state;

  if (!state) {
    return (
      <main className="boot">
        <span className="ball boot-ball" aria-hidden="true">
          8
        </span>
        <p>{hub.online ? 'Загрузка…' : 'Подключаемся к HUB клуба…'}</p>
      </main>
    );
  }

  const ctx: HubContextValue = {
    state,
    serverNow: now + hub.offset,
    online: hub.online,
    version: hub.version,
    layoutVersion: hub.layoutVersion,
    actor,
    run: commands.run,
    isBusy: commands.isBusy,
    notify: setToast,
    openTable: commands.openTable,
    stopSession: commands.stopSession,
    resolveAlert: commands.resolveAlert,
  };

  const lampProblems = state.tables.filter((t) => t.lamp.reported === 'UNKNOWN').length;
  const badges: NavBadges = {
    checks: { count: state.unpaid.length, tone: 'info' },
    equipment: { count: lampProblems, tone: 'danger' },
  };

  return (
    <HubContext.Provider value={ctx}>
      <div className="shell" data-section={route.section}>
        <Sidebar club={state.club.name} active={route.section} badges={badges} online={hub.online} />
        <div className="shell-main">
          <Topbar
            title={SECTION_TITLE[route.section]}
            state={state}
            serverNow={ctx.serverNow}
            online={hub.online}
            actor={actor}
            onActor={setActor}
            theme={theme}
            onTheme={cycle}
            onResolveAlert={(id) => void commands.resolveAlert(id)}
            busy={commands.anyBusy}
          />
          <OfflineBanner online={hub.online} />
          <main className="content" id="content">
            {route.section === 'hall' && <HallSection />}
            {route.section === 'checks' && <ChecksSection />}
            {route.section === 'stats' && <StatsSection />}
            {route.section === 'tariffs' && <TariffsSection />}
            {route.section === 'journal' && <JournalSection params={route.params} />}
            {route.section === 'equipment' && <EquipmentSection />}
          </main>
        </div>
        <BottomNav active={route.section} badges={badges} />
        {toast && <Toast message={toast} onClose={closeToast} />}
      </div>
    </HubContext.Provider>
  );
}
