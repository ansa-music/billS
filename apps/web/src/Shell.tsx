import { memo, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthStaff, HubState } from '@bills/domain';
import { rolesLabel } from '@bills/domain';
import { CloudStatus } from './CloudStatus.tsx';
import { formatClock } from './format.ts';
import { PowerBadge } from './PowerBadge.tsx';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import { useFullscreen } from './kiosk.ts';
import { hrefFor } from './router.tsx';
import type { RouteDef } from './router.tsx';
import type { ThemePreference } from './theme.ts';
import { BrandMark } from './BrandMark.tsx';

/** Badge counts by route path (unpaid checks, lamp problems …). */
export type NavBadges = Record<string, { count: number; tone: 'info' | 'danger' }>;

/** The app re-renders every second (clocks); the navigation only when its routes, badges or page change. */
function sameNav(
  a: { routes: RouteDef[]; badges: NavBadges; active: string },
  b: { routes: RouteDef[]; badges: NavBadges; active: string },
): boolean {
  if (a.active !== b.active || a.routes.length !== b.routes.length) return false;
  if (a.routes.some((r, i) => r.path !== b.routes[i]?.path || r.title !== b.routes[i]?.title)) return false;
  const ka = Object.keys(a.badges);
  if (ka.length !== Object.keys(b.badges).length) return false;
  return ka.every((k) => a.badges[k]?.count === b.badges[k]?.count && a.badges[k]?.tone === b.badges[k]?.tone);
}

function NavBadge({ badge }: { badge: NavBadges[string] | undefined }) {
  if (!badge || badge.count <= 0) return null;
  return (
    <span className="nav-badge" data-tone={badge.tone}>
      {badge.count > 99 ? '99+' : badge.count}
    </span>
  );
}

function NavLinks({
  routes,
  active,
  badges,
  onNavigate,
}: {
  routes: RouteDef[];
  active: string;
  badges: NavBadges;
  onNavigate?: () => void;
}) {
  return (
    <>
      {routes.map((r) => (
        <a
          key={r.path}
          href={hrefFor(r.path)}
          className="nav-link"
          title={r.title}
          aria-current={r.path === active ? 'page' : undefined}
          onClick={onNavigate}
        >
          <span className="nav-icon">
            <Icon name={r.icon} size={22} />
            <NavBadge badge={badges[r.path]} />
          </span>
          {/* Full title in the sidebar and the «Ещё» sheet, the short one under the icon (tablet rail, phone tabs). */}
          <span className="nav-label">{r.title}</span>
          <span className="nav-label-short" aria-hidden="true">
            {r.short ?? r.title}
          </span>
        </a>
      ))}
    </>
  );
}

function SidebarImpl({
  title,
  logoUrl,
  routes,
  active,
  badges,
  online,
}: {
  /** Club name or the title from the hall screen settings. */
  title: string;
  logoUrl: string | null;
  routes: RouteDef[];
  active: string;
  badges: NavBadges;
  online: boolean;
}) {
  return (
    <nav className="sidebar" aria-label="Разделы">
      <div className="sidebar-brand">
        {logoUrl ? <img className="sidebar-logo" src={logoUrl} alt="" /> : <BrandMark />}
        <div className="sidebar-brand-text">
          <strong>TS</strong>
          <span>{title}</span>
        </div>
      </div>
      <div className="sidebar-links">
        <NavLinks routes={routes} active={active} badges={badges} />
      </div>
      <div className="sidebar-foot" data-online={online || undefined} title={online ? 'Касса на связи' : 'Нет связи с кассой'}>
        <span className="conn-dot" aria-hidden="true" />
        <span className="nav-label">{online ? 'Касса на связи' : 'Нет связи с кассой'}</span>
      </div>
    </nav>
  );
}

export const Sidebar = memo(
  SidebarImpl,
  (a, b) => a.title === b.title && a.logoUrl === b.logoUrl && a.online === b.online && sameNav(a, b),
);

/** Phones: the first sections as tabs, the rest (and who is signed in) in the «Ещё» sheet. */
const PHONE_TABS = 4;

function BottomNavImpl({
  routes,
  active,
  badges,
  staff,
  onLogout,
}: {
  routes: RouteDef[];
  active: string;
  badges: NavBadges;
  staff?: AuthStaff | undefined;
  onLogout?: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const fits = routes.length <= PHONE_TABS + 1;
  const tabs = fits ? routes : routes.slice(0, PHONE_TABS);
  const rest = fits ? [] : routes.slice(PHONE_TABS);
  const restActive = rest.find((r) => r.path === active);
  const restCount = rest.reduce((sum, r) => sum + (badges[r.path]?.count ?? 0), 0);
  const restTone = rest.some((r) => (badges[r.path]?.count ?? 0) > 0 && badges[r.path]?.tone === 'danger') ? 'danger' : 'info';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => setOpen(false), [active]);

  return (
    <>
      <nav className="bottom-nav" aria-label="Разделы" style={{ gridTemplateColumns: `repeat(${tabs.length + (rest.length ? 1 : 0)}, minmax(0, 1fr))` }}>
        <NavLinks routes={tabs} active={active} badges={badges} />
        {rest.length > 0 && (
          <button
            type="button"
            className="nav-link nav-more"
            aria-expanded={open}
            aria-haspopup="dialog"
            data-active={restActive ? '' : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            <span className="nav-icon">
              <Icon name={restActive?.icon ?? 'grid'} size={22} />
              <NavBadge badge={restCount > 0 ? { count: restCount, tone: restTone } : undefined} />
            </span>
            <span className="nav-label-short">{restActive ? (restActive.short ?? restActive.title) : 'Ещё'}</span>
          </button>
        )}
      </nav>
      {open && (
        <>
          <div className="more-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="more-sheet" role="dialog" aria-label="Все разделы">
            <div className="more-grip" aria-hidden="true" />
            {staff && (
              <div className="more-who">
                <span className="avatar">{initials(staff.name)}</span>
                <span className="more-who-text">
                  <strong>{staff.name}</strong>
                  <span className="muted">{rolesLabel(staff.roles)}</span>
                </span>
                {onLogout && (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => {
                      setOpen(false);
                      onLogout();
                    }}
                  >
                    <Icon name="logout" size={18} /> Сменить
                  </button>
                )}
              </div>
            )}
            <div className="more-links">
              <NavLinks routes={rest} active={active} badges={badges} onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </>
      )}
    </>
  );
}

export const BottomNav = memo(
  BottomNavImpl,
  (a, b) => a.staff === b.staff && a.onLogout === b.onLogout && sameNav(a, b),
);

/** «Марат Управляющий» → «МУ». */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** A button with a panel under it; closes on outside click and Escape. */
export function Popover({
  label,
  button,
  children,
  align = 'end',
  className,
  buttonClassName,
}: {
  label: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  className?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className={`popover ${className ?? ''}`} ref={root}>
      <button
        type="button"
        className={buttonClassName ? `icon-btn ${buttonClassName}` : 'icon-btn'}
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open && (
        <div className="popover-panel" data-align={align} role="dialog" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const THEME_LABEL: Record<ThemePreference, string> = {
  auto: 'Тема: как в настройках клуба',
  dark: 'Тема: тёмная',
  light: 'Тема: светлая',
};
const THEME_ICON: Record<ThemePreference, IconName> = { auto: 'auto', dark: 'moon', light: 'sun' };

export function Topbar(props: {
  title: string;
  state: HubState;
  serverNow: number;
  online: boolean;
  staff: AuthStaff;
  onLogout: () => void;
  theme: ThemePreference;
  onTheme: () => void;
  onResolveAlert: (id: string) => void;
  canResolveAlerts: boolean;
  busy: boolean;
}) {
  const { state, staff } = props;
  const fullscreen = useFullscreen();
  const alerts = state.alerts;
  const fullscreenLabel = fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран';
  return (
    <header className="topbar">
      <div className="topbar-title">
        <BrandMark className="topbar-mark" />
        <div className="topbar-title-text">
          <h1>{props.title}</h1>
          <p className="topbar-club">{state.club.name}</p>
        </div>
      </div>
      <div className="topbar-tools">
        <span className="topbar-clock" title={`Время клуба (${state.club.timezone})`}>
          {formatClock(props.serverNow, state.club.timezone)}
        </span>
        <span
          className="topbar-conn"
          data-online={props.online || undefined}
          title={props.online ? 'Касса на связи' : 'Нет связи с кассой'}
          role="status"
          aria-label={props.online ? 'Касса на связи' : 'Нет связи с кассой'}
        >
          <span className="conn-dot" aria-hidden="true" />
          <span className="topbar-conn-text">{props.online ? 'На связи' : 'Нет связи'}</span>
        </span>
        <PowerBadge power={state.power} />
        <CloudStatus sync={state.sync} timezone={state.club.timezone} />

        <Popover
          label={alerts.length ? `Тревоги: ${alerts.length}` : 'Тревог нет'}
          className="alerts-popover"
          button={
            <span className="bell" data-active={alerts.length > 0 || undefined}>
              <Icon name="bell" />
              {alerts.length > 0 && <span className="bell-count">{alerts.length}</span>}
            </span>
          }
        >
          {() => (
            <div className="alert-list">
              <h2>Тревоги</h2>
              {alerts.length === 0 ? (
                <p className="empty">Всё спокойно: тревог нет</p>
              ) : (
                alerts.map((a) => (
                  <div key={a.id} className="alert-item">
                    <Icon name="alert" size={18} className="alert-item-icon" />
                    <div>
                      <p>{a.message}</p>
                      <span className="muted">{formatClock(a.at, state.club.timezone)}</span>
                    </div>
                    {props.canResolveAlerts && (
                      <button type="button" className="btn btn-small" disabled={props.busy} onClick={() => props.onResolveAlert(a.id)}>
                        Принято
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </Popover>

        <Popover
          label={`Сотрудник: ${staff.name}. Сменить сотрудника`}
          buttonClassName="actor-btn"
          button={
            <span className="actor-pill">
              <span className="avatar avatar-sm" aria-hidden="true">
                {initials(staff.name)}
              </span>
              <span className="actor-text">
                <span className="actor-name">{staff.name}</span>
                <span className="actor-role">{rolesLabel(staff.roles)}</span>
              </span>
              <Icon name="chevron-down" size={16} className="actor-chevron" />
            </span>
          }
        >
          {(close) => (
            <div className="actor-form">
              <div className="actor-who">
                <span className="avatar">{initials(staff.name)}</span>
                <span className="actor-who-text">
                  <strong>{staff.name}</strong>
                  <span className="muted">{rolesLabel(staff.roles)}</span>
                </span>
              </div>
              <p className="hint">Имя попадает в журнал действий. Другой сотрудник входит своим ключом.</p>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  close();
                  props.onLogout();
                }}
              >
                <Icon name="logout" size={18} /> Выйти и сменить сотрудника
              </button>
              <div className="actor-row">
                <button type="button" className="btn btn-small" onClick={props.onTheme}>
                  <Icon name={THEME_ICON[props.theme]} size={18} /> {THEME_LABEL[props.theme].replace('Тема: ', 'Тема — ')}
                </button>
                {fullscreen.supported && (
                  <button type="button" className="btn btn-small actor-fullscreen" onClick={fullscreen.toggle}>
                    <Icon name={fullscreen.active ? 'fullscreen-exit' : 'fullscreen'} size={18} /> {fullscreenLabel}
                  </button>
                )}
              </div>
              <a className="btn btn-small btn-ghost actor-apps" href={hrefFor('/apps')} onClick={close}>
                <Icon name="download" size={18} /> Приложения TS
              </a>
            </div>
          )}
        </Popover>

        <button type="button" className="icon-btn topbar-extra" onClick={props.onTheme} title={THEME_LABEL[props.theme]} aria-label={THEME_LABEL[props.theme]}>
          <Icon name={THEME_ICON[props.theme]} />
        </button>
        {fullscreen.supported && (
          <button type="button" className="icon-btn topbar-extra" onClick={fullscreen.toggle} title={fullscreenLabel} aria-label={fullscreenLabel}>
            <Icon name={fullscreen.active ? 'fullscreen-exit' : 'fullscreen'} />
          </button>
        )}
      </div>
    </header>
  );
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  return (
    <div className="toast" role="status" onClick={onClose}>
      {message}
    </div>
  );
}
