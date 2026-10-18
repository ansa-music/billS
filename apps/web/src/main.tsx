import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { useAuth } from './auth.ts';
import { Layout } from './Layout.tsx';
import { LoginPage } from './Login.tsx';
import { AuditPage } from './pages/AuditLog.tsx';
import { BarMenuPage } from './pages/BarMenu.tsx';
import { ClubSettingsPage } from './pages/ClubSettings.tsx';
import { OrdersPage } from './pages/Orders.tsx';
import { OwnerPage } from './pages/Owner.tsx';
import { PlatformPage } from './pages/Platform.tsx';
import { StaffPage } from './pages/Staff.tsx';
import { Link, routeFor, useLocation } from './router.tsx';
import { Page } from './ui.tsx';
import { HubProvider } from './useHub.tsx';
import './styles.css';
import './app.css';

const PAGES: Record<string, () => ReactNode> = {
  '/': () => <App />,
  '/orders': () => <OrdersPage />,
  '/bar': () => <BarMenuPage />,
  '/settings': () => <ClubSettingsPage />,
  '/staff': () => <StaffPage />,
  '/audit': () => <AuditPage />,
  '/owner': () => <OwnerPage />,
  '/platform': () => <PlatformPage />,
};

function Router() {
  const { path, query } = useLocation();
  const { staff, can, login } = useAuth();

  if (path === '/login') return <LoginPage onLogin={login} next={query.get('next') ?? '/'} />;

  const route = routeFor(path);
  const render = PAGES[path];
  if (!route || !render) {
    return (
      <Page title="Страницы нет">
        <p>
          Такого раздела нет. <Link to="/">На экран зала</Link>
        </p>
      </Page>
    );
  }
  if (!staff) return <LoginPage onLogin={login} next={path} />;
  if (path === '/') document.title = 'Зал — billS';
  if (route.action && !can(route.action)) {
    return (
      <Page title="Нет доступа" subtitle={`Раздел «${route.title}» недоступен для вашей роли.`}>
        <p>
          <Link to="/">На экран зала</Link> или <Link to="/login">войти под другим сотрудником</Link>.
        </p>
      </Page>
    );
  }
  return <>{render()}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HubProvider>
      <Layout>
        <Router />
      </Layout>
    </HubProvider>
  </StrictMode>,
);
