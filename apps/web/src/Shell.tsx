import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { HubState } from '@bills/domain';
import { formatClock } from './format.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import { useFullscreen } from './kiosk.ts';
import { href, SECTION_TITLE, SECTIONS } from './router.ts';
import type { Section } from './router.ts';
import type { ThemePreference } from './theme.ts';

const SECTION_ICON: Record<Section, IconName> = {
  hall: 'hall',
  checks: 'checks',
  stats: 'stats',
  tariffs: 'tariffs',
  journal: 'journal',
  equipment: 'equipment',
};

export type NavBadges = Partial<Record<Section, { count: number; tone: 'info' | 'danger' }>>;

function NavLinks({ active, badges, compact }: { active: Section; badges: NavBadges; compact?: boolean }) {
  return (
    <>
      {SECTIONS.map((s) => {
        const badge = badges[s];
        return (
          <a
            key={s}
            href={href(s)}
            className="nav-link"
            title={SECTION_TITLE[s]}
            aria-current={s === active ? 'page' : undefined}
          >
            <span className="nav-icon">
              <Icon name={SECTION_ICON[s]} size={compact ? 22 : 20} />
              {badge && badge.count > 0 && (
                <span className="nav-badge" data-tone={badge.tone}>
                  {badge.count > 99 ? '99+' : badge.count}
                </span>
              )}
            </span>
            <span className="nav-label">{SECTION_TITLE[s]}</span>
          </a>
        );
      })}
    </>
  );
}

export function Sidebar({ club, active, badges, online }: { club: string; active: Section; badges: NavBadges; online: boolean }) {
  return (
    <nav className="sidebar" aria-label="Разделы">
      <div className="sidebar-brand">
        <span className="ball" aria-hidden="true">
          8
        </span>
        <div className="sidebar-brand-text">
          <strong>Billiard Control</strong>
          <span>{club}</span>
        </div>
      </div>
      <div className="sidebar-links">
        <NavLinks active={active} badges={badges} />
      </div>
      <div className="sidebar-foot" data-online={online || undefined}>
        <span className="conn-dot" aria-hidden="true" />
        <span className="nav-label">{online ? 'HUB на связи' : 'Нет связи с HUB'}</span>
      </div>
    </nav>
  );
}

export function BottomNav({ active, badges }: { active: Section; badges: NavBadges }) {
  return (
    <nav className="bottom-nav" aria-label="Разделы">
      <NavLinks active={active} badges={badges} compact />
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

const THEME_LABEL: Record<ThemePreference, string> = { auto: 'Тема: как на устройстве', dark: 'Тема: тёмная', light: 'Тема: светлая' };
const THEME_ICON: Record<ThemePreference, IconName> = { auto: 'auto', dark: 'moon', light: 'sun' };

export function Topbar(props: {
  title: string;
  state: HubState;
  serverNow: number;
  online: boolean;
  actor: string;
  onActor: (name: string) => void;
  theme: ThemePreference;
  onTheme: () => void;
  onResolveAlert: (id: string) => void;
  busy: boolean;
}) {
  const { state } = props;
  const fullscreen = useFullscreen();
  const alerts = state.alerts;
  return (
    <header className="topbar">
      <div className="topbar-title">
        <span className="ball topbar-ball" aria-hidden="true">
          8
        </span>
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
                    <button type="button" className="btn btn-small" disabled={props.busy} onClick={() => props.onResolveAlert(a.id)}>
                      Принято
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </Popover>

        <Popover
          label={`Сотрудник: ${props.actor}`}
          button={
            <span className="actor-pill">
              <Icon name="user" size={18} />
              <span className="actor-name">{props.actor}</span>
            </span>
          }
        >
          {(close) => (
            <form
              className="actor-form"
              onSubmit={(e) => {
                e.preventDefault();
                close();
              }}
            >
              <label className="field">
                Кто работает за этим экраном
                <input
                  className="actor-input"
                  value={props.actor}
                  onChange={(e) => props.onActor(e.target.value)}
                  maxLength={60}
                  autoFocus
                />
              </label>
              <p className="hint">Имя попадает в журнал действий. С этапа 3 — вход по PIN.</p>
              <button type="submit" className="btn btn-primary">
                Готово
              </button>
            </form>
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
