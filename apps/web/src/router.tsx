import { useEffect, useState } from 'react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { Action } from '@bills/domain';

/**
 * Hash router: #/settings?tab=tables. No dependency, works from file:// and
 * behind any proxy — the HUB may serve the built app itself one day.
 */

export interface Location {
  path: string;
  query: URLSearchParams;
}

export function parseHash(hash: string): Location {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [p = '', q = ''] = raw.split('?', 2);
  const path = p.startsWith('/') ? p : `/${p}`;
  return { path: path.length > 1 ? path.replace(/\/+$/, '') : path, query: new URLSearchParams(q) };
}

export function currentLocation(): Location {
  return parseHash(window.location.hash);
}

export function hrefFor(path: string, query?: Record<string, string>): string {
  const q = query ? new URLSearchParams(query).toString() : '';
  return `#${path}${q ? `?${q}` : ''}`;
}

export function navigate(path: string, query?: Record<string, string>): void {
  window.location.hash = hrefFor(path, query);
}

export function useLocation(): Location {
  const [loc, setLoc] = useState(currentLocation);
  useEffect(() => {
    const onChange = () => setLoc(currentLocation());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return loc;
}

export function Link({
  to,
  query,
  children,
  ...rest
}: { to: string; query?: Record<string, string>; children: ReactNode } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
>) {
  return (
    <a href={hrefFor(to, query)} {...rest}>
      {children}
    </a>
  );
}

export interface RouteDef {
  path: string;
  /** Shown in the navigation. */
  title: string;
  /** Short label for narrow screens. */
  short?: string;
  /** Permission needed to see the page; the nav hides it otherwise. */
  action: Action | null;
  /** Hidden from the nav (login, …). */
  hidden?: boolean;
}

/**
 * Every page of the app. Components are attached in main.tsx so this table
 * stays importable by anything (tests, the nav) without pulling React pages.
 */
export const ROUTES: RouteDef[] = [
  { path: '/', title: 'Зал', action: 'hall.view' },
  { path: '/orders', title: 'Заказы', action: 'order.create' },
  { path: '/bar', title: 'Бар и меню', short: 'Бар', action: 'catalog.edit' },
  { path: '/settings', title: 'Настройки клуба', short: 'Клуб', action: 'settings.view' },
  { path: '/staff', title: 'Сотрудники', action: 'staff.view' },
  { path: '/audit', title: 'Журнал', action: 'audit.view' },
  { path: '/owner', title: 'Кабинет владельца', short: 'Кабинет', action: 'reports.view' },
  { path: '/platform', title: 'Платформа', action: 'platform.view' },
  { path: '/login', title: 'Вход', action: null, hidden: true },
];

export function routeFor(path: string): RouteDef | undefined {
  return ROUTES.find((r) => r.path === path);
}
