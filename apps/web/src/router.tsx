import { useEffect, useState } from 'react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { Action } from '@bills/domain';
import type { IconName } from './icons.tsx';

/**
 * Hash router: #/settings?tab=tables, #/journal?table=…. No dependency, works
 * from file:// and behind any proxy — the HUB may serve the built app itself one day.
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
  /** Shown in the navigation and the top bar. */
  title: string;
  /** Short label for narrow screens. */
  short?: string;
  /** Icon in the sidebar and the phone tab bar. */
  icon: IconName;
  /** Permission needed to see the page; the nav hides it otherwise. */
  action: Action | null;
  /** Hidden from the nav (login, …). */
  hidden?: boolean;
}

/**
 * Every page of the app, in navigation order. Components are attached in
 * App.tsx so this table stays importable by anything (tests, the nav) without
 * pulling React pages.
 */
export const ROUTES: RouteDef[] = [
  { path: '/', title: 'Зал', icon: 'hall', action: 'hall.view' },
  { path: '/checks', title: 'Счета', icon: 'checks', action: 'checks.view' },
  { path: '/orders', title: 'Заказы', icon: 'orders', action: 'order.create' },
  { path: '/stats', title: 'Сводка', icon: 'stats', action: 'stats.view' },
  { path: '/tariffs', title: 'Тарифы', icon: 'tariffs', action: 'tariffs.view' },
  { path: '/bar', title: 'Бар и меню', short: 'Бар', icon: 'bar', action: 'catalog.edit' },
  { path: '/staff', title: 'Сотрудники', short: 'Персонал', icon: 'staff', action: 'staff.view' },
  { path: '/journal', title: 'Журнал', icon: 'journal', action: 'audit.view' },
  { path: '/equipment', title: 'Оборудование', short: 'Техника', icon: 'equipment', action: 'equipment.view' },
  { path: '/settings', title: 'Настройки клуба', short: 'Клуб', icon: 'settings', action: 'settings.view' },
  { path: '/owner', title: 'Кабинет управляющего', short: 'Кабинет', icon: 'owner', action: 'reports.view' },
  { path: '/platform', title: 'Платформа', icon: 'platform', action: 'platform.view' },
  // Installers for the owner phone and the cash-desk computer; linked from the staff menu in the top bar.
  { path: '/apps', title: 'Приложения', icon: 'download', action: null, hidden: true },
  { path: '/login', title: 'Вход', icon: 'user', action: null, hidden: true },
];

/** Old addresses that still arrive from bookmarks and notes. */
export const REDIRECTS: Record<string, string> = {
  '/audit': '/journal',
  '/hall': '/',
};

export function routeFor(path: string): RouteDef | undefined {
  return ROUTES.find((r) => r.path === path);
}

/** Slug for data-section on the shell: '/' → 'hall', '/bar' → 'bar'. */
export function sectionOf(path: string): string {
  return path === '/' ? 'hall' : path.replace(/^\//, '').replace(/\//g, '-');
}
