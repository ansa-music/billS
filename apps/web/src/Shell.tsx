import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthStaff, HubState } from '@bills/domain';
import { ROLE_LABEL } from '@bills/domain';
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

function NavLinks({
  routes,
  active,
  badges,
  compact,
}: {
  routes: RouteDef[];
  active: string;
  badges: NavBadges;
  compact?: boolean;
}) {
  return (
    <>
      {routes.map((r) => {
        const badge = badges[r.path];
        return (
          <a
            key={r.path}
            href={hrefFor(r.path)}
            className="nav-link"
            title={r.title}
            aria-current={r.path === active ? 'page' : undefined}
          >
            <span className="nav-icon">
              <Icon name={r.icon} size={compact ? 22 : 20} />
              {badge && badge.count > 0 && (
                <span className="nav-badge" data-tone={badge.tone}>
                  {badge.count > 99 ? '99+' : badge.count}
                </span>
              )}
            </span>
            <span className="nav-label">{compact ? (r.short ?? r.title) : r.title}</span>
          </a>
        );
      })}
    </>
  );
}

export function Sidebar({
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
        {logoUrl ? (
          <img className="sidebar-logo" src={logoUrl} alt="" />
        ) : (
          <BrandMark />
        )}
        <div className="sidebar-brand-text">
          <strong>TS</strong>
          <span>{title}</span>
        </div>
      </div>
      <div className="sidebar-links">
        <NavLinks routes={routes} active={active} badges={badges} />
      </div>
      <div className="sidebar-foot" data-online={online || undefined}>
        <span className="conn-dot" aria-hidden="true" />
        <span className="nav-label">{online ? 'HUB на связи' : 'Нет связи с HUB'}</span>
      </div>
    </nav>
  );
}

export function BottomNav({ routes, active, badges }: { routes: RouteDef[]; active: string; badges: NavBadges }) {
  return (
    <nav className="bottom-nav" aria-label="Разделы">
      <NavLinks routes={routes} active={active} badges={badges} compact />
    </nav>
  );
}

/** A button with a panel under it; closes on outside click and Escape. */
export function Popover({
  label,
  button,
  children,
  align = 'end',
  className,
}: {
  label: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  className?: string;
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
        className="icon-btn"
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
  return (
    <header className="topbar">
      <div className="topbar-title">
        <BrandMark className="topbar-mark" />
        <div>
          <h1>{props.title}</h1>
          <p className="topbar-club">{state.club.name}</p>
        </div>
      </div>
      <div className="topbar-tools">
        <span className="topbar-clock" title={`Время клуба (${state.club.timezone})`}>
          {formatClock(props.serverNow, state.club.timezone)}
        </span>
        <span className="topbar-conn" data-online={props.online || undefined} title={props.online ? 'HUB на связи' : 'Нет связи с HUB'}>
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
          label={`Сотрудник: ${staff.name}`}
          button={
            <span className="actor-pill">
              <Icon name="user" size={18} />
              <span className="actor-name">{staff.name}</span>
            </span>
          }
        >
          {(close) => (
            <div className="actor-form">
              <p className="actor-who">
                <strong>{staff.name}</strong>
                <span className="muted">{ROLE_LABEL[staff.role]}</span>
              </p>
              <p className="hint">Вход по ключу доступа; имя попадает в журнал действий. Другой сотрудник — выйти и войти своим ключом.</p>
              <a className="btn actor-apps" href={hrefFor('/apps')} onClick={close}>
                <Icon name="download" size={18} /> Приложения TS
              </a>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  close();
                  props.onLogout();
                }}
              >
                <Icon name="logout" size={18} /> Выйти
              </button>
            </div>
          )}
        </Popover>

        <button type="button" className="icon-btn" onClick={props.onTheme} title={THEME_LABEL[props.theme]} aria-label={THEME_LABEL[props.theme]}>
          <Icon name={THEME_ICON[props.theme]} />
        </button>
        {fullscreen.supported && (
          <button
            type="button"
            className="icon-btn"
            onClick={fullscreen.toggle}
            title={fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран'}
            aria-label={fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран'}
          >
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
