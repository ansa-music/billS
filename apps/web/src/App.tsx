import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { setManualMode } from './api.ts';
import { useAuth } from './auth.ts';
import { ManualModeBanner } from './Hardware.tsx';
import { useWakeLock } from './kiosk.ts';
import { LoginPage } from './Login.tsx';
import { OfflineBanner } from './OfflineBanner.tsx';
import { Link, navigate, REDIRECTS, ROUTES, routeFor, sectionOf, useLocation } from './router.tsx';
import { BottomNav, Sidebar, Toast, Topbar } from './Shell.tsx';
import type { NavBadges } from './Shell.tsx';
import { applyTheme, useTheme } from './theme.ts';
import { Page } from './ui.tsx';
import { HubContext, useHallCommands, useHubConnection, useNow } from './useHub.tsx';
import type { HubContextValue } from './useHub.tsx';
import { HallSection } from './sections/Hall.tsx';
import { ChecksSection } from './sections/Checks.tsx';
import { StatsSection } from './sections/Stats.tsx';
import { TariffsSection } from './sections/Tariffs.tsx';
import { JournalSection } from './sections/Journal.tsx';
import { EquipmentSection } from './sections/Equipment.tsx';
import { BarMenuPage } from './pages/BarMenu.tsx';
import { ClubSettingsPage } from './pages/ClubSettings.tsx';
import { OrdersPage } from './pages/Orders.tsx';
import { OwnerPage } from './pages/Owner.tsx';
import { PlatformPage } from './pages/Platform.tsx';
import { StaffPage } from './pages/Staff.tsx';
import { BrandMark } from './BrandMark.tsx';

/** Route path → page. The table of routes (titles, icons, permissions) lives in router.tsx. */
const PAGES: Record<string, (query: URLSearchParams) => ReactNode> = {
  '/': () => <HallSection />,
  '/checks': () => <ChecksSection />,
  '/orders': () => <OrdersPage />,
  '/stats': () => <StatsSection />,
  '/tariffs': () => <TariffsSection />,
  '/bar': () => <BarMenuPage />,
  '/staff': () => <StaffPage />,
  '/journal': (query) => <JournalSection params={query} />,
  '/equipment': () => <EquipmentSection />,
  '/settings': () => <ClubSettingsPage />,
  '/owner': () => <OwnerPage />,
  '/platform': () => <PlatformPage />,
};

/**
 * The app shell: one HUB connection, the logged-in staff member and their
 * permissions, the sidebar / top bar / phone tabs, and the page for the
 * current hash route inside. The hall-tablet helpers (screen wake lock,
 * fullscreen) live here too, so every page gets them.
 */
export function App() {
  const hub = useHubConnection();
  const { path, query } = useLocation();
  const { staff, role, can, logout } = useAuth();
  const now = useNow();
  const { theme, cycle } = useTheme();
  const [toast, setToast] = useState<string | null>(null);
  const actor = staff?.name ?? 'unknown';
  const commands = useHallCommands(actor, hub.refresh, setToast);
  useWakeLock();

  // Old addresses from bookmarks and notes.
  useEffect(() => {
    const to = REDIRECTS[path];
    if (to) navigate(to, Object.fromEntries(query));
  }, [path, query]);

  const state = hub.state;
  const display = state?.settings.display;
  const route = routeFor(path);
  const title = route?.title ?? 'Страницы нет';

  useEffect(() => {
    document.title = `${title} — ${display?.title ?? state?.club.name ?? 'TS'}`;
  }, [title, display?.title, state?.club.name]);

  // Hall screen settings from the club → <html>, where the CSS picks them up.
  // The theme chosen on this device wins over the club's; `auto` follows the club.
  useEffect(() => {
    applyTheme(theme, display?.theme ?? 'auto');
    const html = document.documentElement;
    const cards = display?.cardSize ?? 'normal';
    if (cards === 'normal') delete html.dataset.cards;
    else html.dataset.cards = cards;
    if (role === 'waiter' && display?.waiterSees === 'time') html.dataset.hideAmounts = '';
    else delete html.dataset.hideAmounts;
  }, [theme, display?.theme, display?.cardSize, display?.waiterSees, role]);

  const closeToast = useCallback(() => setToast(null), []);

  // Without a session the HUB answers 401 to /api/state, so the login page comes
  // before the boot screen; LoginPage signs in through useAuth and stores the token.
  if (path === '/login' || !staff) {
    const next = path === '/login' ? (query.get('next') ?? '/') : path;
    return (
      <div className="login-shell">
        <LoginPage next={next} />
      </div>
    );
  }

  if (!state) {
    return (
      <main className="boot">
        <BrandMark className="boot-mark" />
        <p>{hub.online ? 'Загрузка…' : 'Подключаемся к HUB клуба…'}</p>
      </main>
    );
  }

  const ctx: HubContextValue = {
    state,
    serverNow: now + hub.offset,
    offset: hub.offset,
    online: hub.online,
    version: hub.version,
    layoutVersion: hub.layoutVersion,
    refresh: hub.refresh,
    actor,
    role,
    can,
    run: commands.run,
    isBusy: commands.isBusy,
    notify: setToast,
    openTable: commands.openTable,
    stopSession: commands.stopSession,
    pauseSession: commands.pauseSession,
    resumeSession: commands.resumeSession,
    transferSession: commands.transferSession,
    resolveAlert: commands.resolveAlert,
  };

  const visible = ROUTES.filter((r) => !r.hidden && r.action !== null && can(r.action));
  const lampProblems = state.tables.filter((t) => t.lamp.reported === 'UNKNOWN').length;
  const powerProblem = state.power.configured && (!state.power.reachable || state.power.onBattery) ? 1 : 0;
  const badges: NavBadges = {
    '/checks': { count: state.unpaid.length + state.checks.length, tone: 'info' },
    '/equipment': { count: lampProblems + powerProblem + (state.manualMode.enabled ? 1 : 0), tone: 'danger' },
  };

  let content: ReactNode;
  const render = route ? PAGES[route.path] : undefined;
  if (!route || !render) {
    content = (
      <Page title="Страницы нет">
        <p>
          Такого раздела нет. <Link to="/">На экран зала</Link>
        </p>
      </Page>
    );
  } else if (route.action && !can(route.action)) {
    content = (
      <Page title="Нет доступа" subtitle={`Раздел «${route.title}» недоступен для вашей роли.`}>
        <p>
          <Link to="/">На экран зала</Link> или <Link to="/login">войти под другим сотрудником</Link>.
        </p>
      </Page>
    );
  } else {
    content = render(query);
  }

  return (
    <HubContext.Provider value={ctx}>
      <div className="shell" data-section={sectionOf(path)}>
        <Sidebar
          title={display?.title ?? state.club.name}
          logoUrl={display?.logoUrl ?? null}
          routes={visible}
          active={path}
          badges={badges}
          online={hub.online}
        />
        <div className="shell-main">
          <Topbar
            title={title}
            state={state}
            serverNow={ctx.serverNow}
            online={hub.online}
            staff={staff}
            onLogout={() => {
              // Drops the session on the HUB (best effort), then shows the login page.
              void logout().finally(() => navigate('/login'));
            }}
            theme={theme}
            onTheme={cycle}
            onResolveAlert={(id) => void commands.resolveAlert(id)}
            canResolveAlerts={can('alert.resolve')}
            busy={commands.anyBusy}
          />
          <OfflineBanner online={hub.online} />
          <ManualModeBanner
            mode={state.manualMode}
            timezone={state.club.timezone}
            busy={commands.isBusy('manual') || !hub.online}
            canDisable={can('equipment.view')}
            onDisable={() => void commands.run('manual', () => setManualMode(actor, false))}
          />
          <main className="content" id="content">
            {content}
          </main>
        </div>
        <BottomNav routes={visible} active={path} badges={badges} />
        {toast && <Toast message={toast} onClose={closeToast} />}
      </div>
    </HubContext.Provider>
  );
}
