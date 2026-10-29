import { useEffect, useState } from 'react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import type { Action, BusinessType } from '@bills/domain';
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
  /** Only for this kind of venue (settings.business.type); both when absent. */
  only?: BusinessType;
  /** Title in a coffee shop when it differs («Бар и меню» → «Меню»). */
  cafeTitle?: string;
  cafeShort?: string;
}

/**
 * Every page of the app, in navigation order. Components are attached in
 * App.tsx so this table stays importable by anything (tests, the nav) without
 * pulling React pages.
 */
export const ROUTES: RouteDef[] = [
  // Coffee shop: the counter screens come first and «Касса» is the start page.
  { path: '/pos', title: 'Касса', icon: 'pos', action: 'counter.take', only: 'cafe' },
  { path: '/barista', title: 'Бариста', icon: 'cup', action: 'counter.stage', only: 'cafe' },
  // Guest screen for a TV: opens without a key too (App renders it before the login check).
  { path: '/board', title: 'Экран заказов', short: 'Экран', icon: 'tv', action: 'counter.stage', only: 'cafe' },
  { path: '/', title: 'Зал', icon: 'hall', action: 'hall.view', only: 'billiards' },
  { path: '/checks', title: 'Счета', icon: 'checks', action: 'checks.view' },
  { path: '/orders', title: 'Заказы', icon: 'orders', action: 'order.create', only: 'billiards' },
  { path: '/stats', title: 'Сводка', cafeTitle: 'Отчёты', icon: 'stats', action: 'stats.view' },
  { path: '/tariffs', title: 'Тарифы', icon: 'tariffs', action: 'tariffs.view', only: 'billiards' },
  { path: '/bar', title: 'Бар и меню', short: 'Бар', cafeTitle: 'Меню', cafeShort: 'Меню', icon: 'bar', action: 'catalog.edit' },
  { path: '/staff', title: 'Сотрудники', short: 'Персонал', icon: 'staff', action: 'staff.view' },
  { path: '/journal', title: 'Журнал', icon: 'journal', action: 'audit.view' },
  { path: '/equipment', title: 'Оборудование', short: 'Техника', icon: 'equipment', action: 'equipment.view', only: 'billiards' },
  { path: '/settings', title: 'Настройки клуба', short: 'Клуб', cafeTitle: 'Настройки', cafeShort: 'Настройки', icon: 'settings', action: 'settings.view' },
  { path: '/owner', title: 'Кабинет управляющего', short: 'Кабинет', cafeTitle: 'Выручка', cafeShort: 'Выручка', icon: 'owner', action: 'reports.view' },
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

/** Navigation order in a coffee shop (the table above keeps the billiard club's order). */
const CAFE_ORDER = ['/pos', '/barista', '/board', '/bar', '/checks', '/stats'];

/** Routes of this venue in navigation order, with its titles. */
export function routesOf(type: BusinessType): RouteDef[] {
  const list = ROUTES.map((r) => routeIn(r, type)).filter((r): r is RouteDef => r !== null);
  if (type !== 'cafe') return list;
  const rank = (r: RouteDef) => {
    const i = CAFE_ORDER.indexOf(r.path);
    return i < 0 ? CAFE_ORDER.length : i;
  };
  // Array.prototype.sort is stable: the rest keep the table's order.
  return list.sort((a, b) => rank(a) - rank(b));
}

/** Where a venue starts: the hall for billiards, the counter for a coffee shop. */
export function homeOf(type: BusinessType): string {
  return type === 'cafe' ? '/pos' : '/';
}

/** The route as this venue shows it: only its own pages, with the coffee shop's titles. */
export function routeIn(route: RouteDef, type: BusinessType): RouteDef | null {
  if (route.only && route.only !== type) return null;
  if (type !== 'cafe' || (!route.cafeTitle && !route.cafeShort)) return route;
  return { ...route, title: route.cafeTitle ?? route.title, short: route.cafeShort ?? route.cafeTitle ?? route.short };
}

/** Slug for data-section on the shell: '/' → 'hall', '/bar' → 'bar'. */
export function sectionOf(path: string): string {
  return path === '/' ? 'hall' : path.replace(/^\//, '').replace(/\//g, '-');
}
