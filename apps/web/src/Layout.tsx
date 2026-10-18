import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { ROLE_LABEL } from '@bills/domain';
import { useAuth } from './auth.ts';
import { Link, ROUTES, navigate, useLocation } from './router.tsx';
import { useHub } from './useHub.tsx';

/**
 * Navigation bar and page frame around every page, the hall screen included.
 * Applies the club's display settings (theme, card size, what a waiter sees)
 * to <html>, where app.css picks them up.
 */
export function Layout({ children }: { children: ReactNode }) {
  const { staff, role, can, logout } = useAuth();
  const { state, online } = useHub();
  const { path } = useLocation();
  const display = state?.settings.display;

  useEffect(() => {
    const html = document.documentElement;
    const theme = display?.theme ?? 'auto';
    if (theme === 'auto') delete html.dataset.theme;
    else html.dataset.theme = theme;
    const cards = display?.cardSize ?? 'normal';
    if (cards === 'normal') delete html.dataset.cards;
    else html.dataset.cards = cards;
    if (role === 'waiter' && display?.waiterSees === 'time') html.dataset.hideAmounts = '';
    else delete html.dataset.hideAmounts;
  }, [display?.theme, display?.cardSize, display?.waiterSees, role]);

  const title = display?.title ?? state?.club.name ?? 'billS';

  /** Drops the session on the HUB (best effort) and shows the login page. */
  const onLogout = async () => {
    await logout();
    navigate('/login');
  };
  const pages = ROUTES.filter((r) => !r.hidden && r.action && can(r.action));

  return (
    <div className="shell">
      <nav className="nav" aria-label="Разделы">
        <Link to="/" className="nav-brand">
          {display?.logoUrl ? (
            <img className="nav-logo" src={display.logoUrl} alt="" />
          ) : (
            <span className="ball" aria-hidden="true">
              8
            </span>
          )}
          <span className="nav-title">{title}</span>
        </Link>
        <div className="nav-links">
          {pages.map((r) => (
            <Link key={r.path} to={r.path} className="nav-link" aria-current={r.path === path ? 'page' : undefined}>
              <span className="nav-link-full">{r.title}</span>
              <span className="nav-link-short">{r.short ?? r.title}</span>
            </Link>
          ))}
        </div>
        <div className="nav-user">
          {staff && !online && (
            <span className="conn" title="Нет связи с HUB">
              HUB
            </span>
          )}
          {staff ? (
            <>
              <span className="nav-staff">
                <strong>{staff.name}</strong>
                <span className="muted">{ROLE_LABEL[staff.role]}</span>
              </span>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => void onLogout()}>
                Выйти
              </button>
            </>
          ) : (
            <Link to="/login" className="btn btn-small nav-login">
              Войти
            </Link>
          )}
        </div>
      </nav>
      {children}
    </div>
  );
}
