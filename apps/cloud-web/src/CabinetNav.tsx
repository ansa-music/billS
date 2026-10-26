/**
 * The cabinet's sections: «Обзор · Заведения · Сотрудники · Уведомления · Скачать». A row of tabs
 * under the top bar on a computer, a bar at the bottom of the screen on a phone.
 */
import type { ReactNode } from 'react';
import type { Route } from './hooks.ts';

type Section = 'overview' | 'venues' | 'staff' | 'alerts' | 'download';

/** Which tab a page belongs to: venue reports open from «Обзор», a venue's staff — «Сотрудники». */
export function sectionOf(route: Route): Section | null {
  switch (route.kind) {
    case 'overview':
    case 'club':
    case 'shifts':
    case 'tariffs':
    case 'bookings':
    case 'start':
      return 'overview';
    case 'company':
      return 'venues';
    case 'staff':
    case 'staff-home':
      return 'staff';
    case 'phone':
      return 'alerts';
    case 'apps':
      return 'download';
    default:
      return null;
  }
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const ICONS: Record<Section, ReactNode> = {
  overview: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...stroke} d="M4 19V10M10 19V5M16 19v-7M22 19H2" />
    </svg>
  ),
  venues: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...stroke} d="M3 10l1.5-5h15L21 10M4 10v10h16V10M3 10h18M9 20v-5h6v5" />
    </svg>
  ),
  staff: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle {...stroke} cx="9" cy="8" r="3.5" />
      <path {...stroke} d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" />
    </svg>
  ),
  alerts: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...stroke} d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2ZM10 21h4" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path {...stroke} d="M12 3v12M7 10l5 5 5-5M4 20h16" />
    </svg>
  ),
};

const ITEMS: Array<{ id: Section; href: string; label: string }> = [
  { id: 'overview', href: '#/', label: 'Обзор' },
  { id: 'venues', href: '#/company', label: 'Заведения' },
  { id: 'staff', href: '#/staff', label: 'Сотрудники' },
  { id: 'alerts', href: '#/phone', label: 'Уведомления' },
  { id: 'download', href: '#/apps', label: 'Скачать' },
];

export function CabinetNav({ route }: { route: Route }) {
  const current = sectionOf(route);
  return (
    <nav className="cab-nav" aria-label="Разделы кабинета">
      {ITEMS.map((item) => (
        <a key={item.id} className="cab-nav-item" href={item.href} aria-current={current === item.id ? 'page' : undefined}>
          {ICONS[item.id]}
          <span>{item.label}</span>
        </a>
      ))}
    </nav>
  );
}
