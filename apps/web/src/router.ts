import { useEffect, useState } from 'react';

export const SECTIONS = ['hall', 'checks', 'stats', 'tariffs', 'journal', 'equipment'] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_TITLE: Record<Section, string> = {
  hall: 'Зал',
  checks: 'Счета',
  stats: 'Сводка',
  tariffs: 'Тарифы',
  journal: 'Журнал',
  equipment: 'Оборудование',
};

export interface Route {
  section: Section;
  params: URLSearchParams;
}

/** #/journal?table=… — a hash route, so the HUB serves one page and links survive reloads. */
function parse(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const section = (SECTIONS as readonly string[]).includes(path) ? (path as Section) : 'hall';
  return { section, params: new URLSearchParams(query) };
}

export function href(section: Section, params?: Record<string, string>): string {
  const q = params ? new URLSearchParams(params).toString() : '';
  return `#/${section}${q ? `?${q}` : ''}`;
}

export function navigate(section: Section, params?: Record<string, string>): void {
  window.location.hash = href(section, params);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
