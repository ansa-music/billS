import { useCallback, useEffect, useState } from 'react';
import type { Action } from '@bills/domain';
import { ACTION_MODULE, canNow, decide, licenseGateOf } from '@bills/domain';
import { LicenseBanner, blockedReason } from './license.tsx';
import type { ReactNode } from 'react';
import { setManualMode } from './api.ts';
import { useAuth } from './auth.ts';
import { ManualModeBanner } from './Hardware.tsx';
import { useWakeLock } from './kiosk.ts';
import { LoginPage } from './Login.tsx';
import { OfflineBanner } from './OfflineBanner.tsx';
import { PwaBanners } from './pwa.tsx';
import { DemoBanner } from './demo.tsx';
import { homeOf, Link, navigate, REDIRECTS, routeFor, routeIn, routesOf, sectionOf, useLocation } from './router.tsx';
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
import { AppsPage } from './pages/Apps.tsx';
import { BarMenuPage } from './pages/BarMenu.tsx';
import { ClubSettingsPage } from './pages/ClubSettings.tsx';
import { OrdersPage } from './pages/Orders.tsx';
import { OwnerPage } from './pages/Owner.tsx';
import { PlatformPage } from './pages/Platform.tsx';
import { StaffPage } from './pages/Staff.tsx';
import { BrandMark } from './BrandMark.tsx';
import type { BusinessType } from '@bills/domain';
import { businessOf } from './cafe/cafe.ts';
import { BaristaPage } from './cafe/Barista.tsx';
import { BoardPage } from './cafe/Board.tsx';
import { CafeReports } from './cafe/Reports.tsx';
import { PosPage } from './cafe/Pos.tsx';
import { ConnectPage } from './onboarding/Connect.tsx';
import { CafeNeedsCounterModule } from './onboarding/CafeLicense.tsx';
import { useSetupGate } from './onboarding/setup.ts';

/** Route path → page. The table of routes (titles, icons, permissions) lives in router.tsx. */
const PAGES: Record<string, (query: URLSearchParams, business: BusinessType) => ReactNode> = {
  '/': () => <HallSection />,
  '/pos': () => <PosPage />,
  '/barista': () => <BaristaPage />,
  '/checks': () => <ChecksSection />,
  '/orders': () => <OrdersPage />,
  // A coffee shop has no games to chart: its reports come from the cash shift and the counter.
  '/stats': (_query, business) => (business === 'cafe' ? <CafeReports /> : <StatsSection />),
  '/tariffs': () => <TariffsSection />,
  '/bar': () => <BarMenuPage />,
  '/staff': () => <StaffPage />,
  '/journal': (query) => <JournalSection params={query} />,
  '/equipment': () => <EquipmentSection />,
  '/settings': () => <ClubSettingsPage />,
  '/owner': () => <OwnerPage />,
  '/platform': () => <PlatformPage />,
  '/apps': () => <AppsPage />,
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
  const { staff, role, roles, can, logout } = useAuth();
  const now = useNow();
  const { theme, cycle } = useTheme();
  const [toast, setToast] = useState<string | null>(null);
  const actor = staff?.name ?? 'unknown';
  const commands = useHallCommands(actor, hub.refresh, setToast);
  useWakeLock();
  // A fresh club HUB, not connected to the cabinet yet: «Подключите кассу к кабинету» comes before the login.
  const setup = useSetupGate(!staff && path !== '/board');

  // Old addresses from bookmarks and notes.
  useEffect(() => {
    const to = REDIRECTS[path];
    if (to) navigate(to, Object.fromEntries(query));
  }, [path, query]);

  // A connection link (#code=…) opened on a HUB that is already connected: nothing to connect, go on.
  useEffect(() => {
    if (setup.gate === 'login' && path.startsWith('/code=')) navigate(staff ? '/' : '/login');
  }, [setup.gate, path, staff]);

  const state = hub.state;
  const display = state?.settings.display;
  const business = businessOf(state?.settings);
  const known = routeFor(path);
  const route = known ? routeIn(known, business) : undefined;
  const title = route?.title ?? known?.title ?? 'Страницы нет';

  // A page of the other kind of venue (the hall in a coffee shop, «Касса» in a billiard club,
  // bookmarks after the switch): go to this venue's start page.
  useEffect(() => {
    if (state && known && route === null) navigate(homeOf(business));
  }, [state, known, route, business]);

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
    // Only a plain waiter: a waiter who is also a cashier sees the money.
    const onlyWaiter = roles.length > 0 && roles.every((r) => r === 'waiter');
    if (onlyWaiter && display?.waiterSees === 'time') html.dataset.hideAmounts = '';
    else delete html.dataset.hideAmounts;
  }, [theme, display?.theme, display?.cardSize, display?.waiterSees, roles]);

  const license = hub.state?.license ?? null;
  const allowedNow = useCallback((action: Action) => canNow(roles, action, licenseGateOf(license)), [roles, license]);
  const whyBlocked = useCallback((action: Action) => blockedReason(roles, action, license), [roles, license]);

  const closeToast = useCallback(() => setToast(null), []);
  // Drops the session on the HUB (best effort), then shows the login page.
  const signOut = useCallback(() => {
    void logout().finally(() => navigate('/login'));
  }, [logout]);

  // The guest board for a TV in the coffee shop: read-only, full screen, works without a key.
  if (path === '/board') {
    const club = staff !== null && state !== null ? state : null;
    return (
      <BoardPage
        title={club ? (display?.title ?? club.club.name) : null}
        logoUrl={club ? (display?.logoUrl ?? null) : null}
        timeZone={club ? club.club.timezone : null}
        signedIn={staff !== null}
      />
    );
  }

  // Without a session the HUB answers 401 to /api/state, so the login page comes
  // before the boot screen; LoginPage signs in through useAuth and stores the token.
  if (!staff && setup.gate === 'checking') {
    return (
      <main className="boot">
        <BrandMark className="boot-mark" />
        <p>Загрузка…</p>
      </main>
    );
  }
  if (!staff && setup.gate === 'connect') {
    return (
      <div className="login-shell">
        <ConnectPage
          onDone={() => {
            setup.dismiss();
            navigate('/login');
          }}
          onSkip={() => {
            setup.dismiss();
            navigate('/login');
          }}
        />
      </div>
    );
  }
  if (path === '/login' || !staff) {
    const next = path === '/login' ? (query.get('next') ?? '/') : path.startsWith('/code=') ? '/' : path;
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
    roles,
    can,
    license,
    canNow: allowedNow,
    blockedReason: whyBlocked,
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

  // Pages follow the role; a module the license lacks hides its pages too. Read-only mode keeps every page.
  const pageAllowed = (action: Action) => {
    const d = decide(roles, action, licenseGateOf(license));
    return d === 'ok' || d === 'read_only';
  };
  const visible = routesOf(business).filter((r) => !r.hidden && r.action !== null && pageAllowed(r.action));
  const lampProblems = state.tables.filter((t) => t.lamp.reported === 'UNKNOWN').length;
  const powerProblem = state.power.configured && (!state.power.reachable || state.power.onBattery) ? 1 : 0;
  const badges: NavBadges = {
    '/checks': { count: state.unpaid.length + state.checks.length, tone: 'info' },
    '/equipment': { count: lampProblems + powerProblem + (state.manualMode.enabled ? 1 : 0), tone: 'danger' },
  };

  let content: ReactNode;
  const render = route ? PAGES[route.path] : undefined;
  const homeLink = <Link to={homeOf(business)}>{business === 'cafe' ? 'На кассу' : 'На экран зала'}</Link>;
  if (route === null) {
    // Redirecting to the start page (effect above).
    content = <Page title={title}><p className="empty">Этого раздела нет в режиме «{business === 'cafe' ? 'Кофейня' : 'Бильярдный клуб'}». {homeLink}</p></Page>;
  } else if (!route || !render) {
    content = (
      <Page title="Страницы нет">
        <p>
          Такого раздела нет. {homeLink}
        </p>
      </Page>
    );
  } else if (
    route.action &&
    business === 'cafe' &&
    ACTION_MODULE[route.action] === 'bar' &&
    decide(roles, route.action, licenseGateOf(license)) === 'module_off'
  ) {
    // A coffee shop is its counter: say once and plainly why it is closed instead of «Нет доступа».
    content = <CafeNeedsCounterModule canSeeLicense={can('license.view')} />;
  } else if (route.action && !pageAllowed(route.action)) {
    content = (
      <Page
        title="Нет доступа"
        subtitle={
          can(route.action)
            ? `Раздел «${route.title}» не входит в лицензию клуба.`
            : `Раздел «${route.title}» недоступен для вашей роли.`
        }
      >
        <p>
          {homeLink} или <Link to="/login">войти под другим сотрудником</Link>.
        </p>
      </Page>
    );
  } else {
    content = render(query, business);
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
            onLogout={signOut}
            theme={theme}
            onTheme={cycle}
            onResolveAlert={(id) => void commands.resolveAlert(id)}
            canResolveAlerts={can('alert.resolve')}
            busy={commands.anyBusy}
          />
          <LicenseBanner license={license} />
          <DemoBanner cafe={business === 'cafe'} />
          <OfflineBanner online={hub.online} />
          <PwaBanners />
          <ManualModeBanner
            mode={state.manualMode}
            timezone={state.club.timezone}
            busy={commands.isBusy('manual') || !hub.online}
            canDisable={can('lamps.manual_off')}
            onDisable={() => void commands.run('manual', () => setManualMode(actor, false))}
          />
          <main className="content" id="content">
            {content}
          </main>
        </div>
        <BottomNav routes={visible} active={path} badges={badges} staff={staff} onLogout={signOut} />
        {toast && <Toast message={toast} onClose={closeToast} />}
      </div>
    </HubContext.Provider>
  );
}
