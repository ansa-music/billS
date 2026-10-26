import { useEffect, useState } from 'react';
import type { OwnerView, PlatformMe } from '@bills/domain';
import { AppsPage } from './Apps.tsx';
import {
  CloudRequestError,
  SIGNUP_AVAILABLE,
  SUPABASE_MODE,
  logout,
  platformLogout,
  restoreSession,
  subscribeAlerts,
  subscribeApi,
} from './api.ts';
import type { Identity } from './api.ts';
import { CompanyPage } from './Company.tsx';
import { PlatformCabinet } from './Platform.tsx';
import { StaffHome, StaffPage } from './Staff.tsx';
import { Signup } from './Signup.tsx';
import { StartPage } from './Start.tsx';
import { CabinetNav } from './CabinetNav.tsx';
import { markReturning } from './signup.ts';
import { ClubPage } from './ClubPage.tsx';
import { BookingsPage } from './Bookings.tsx';
import { clubHref, requestRefresh, useHashRoute } from './hooks.ts';
import { Login } from './Login.tsx';
import { Overview } from './Overview.tsx';
import { OfflineBanner } from './shared.tsx';
import { Shifts } from './Shifts.tsx';
import { Tariffs } from './Tariffs.tsx';
import { BrandMark } from './BrandMark.tsx';
import { Phone } from './Phone.tsx';
import { SetPasswordPage } from './SetPassword.tsx';
import { enablePhonePush, resetPhonePush } from './phonePush.ts';
import { nativeBridge } from './platform.ts';

type Auth =
  | { status: 'loading' }
  | { status: 'anonymous' }
  /** `platform`: the same person is in the TS team too (Supabase e-mail sign-in) — a switch to that cabinet. */
  | { status: 'ok'; owner: OwnerView; platform: PlatformMe | null; mustSetPassword?: boolean }
  /** Owner or tech of TS: the platform cabinet; `owner` when they also manage a client. */
  | { status: 'platform'; me: PlatformMe; owner: OwnerView | null; mustSetPassword?: boolean };

/** Platform first: someone in the TS team lands in the platform cabinet. */
function authOf(id: Identity): Auth {
  const mustSetPassword = id.mustSetPassword === true;
  if (id.platform) return { status: 'platform', me: id.platform, owner: id.owner, mustSetPassword };
  if (id.owner) return { status: 'ok', owner: id.owner, platform: null, mustSetPassword };
  return { status: 'anonymous' };
}

function useAuth() {
  const [auth, setAuth] = useState<Auth>({ status: 'loading' });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      // The phone app without a cloud address or a token has nothing to ask: straight to the login form.
      const bridge = SUPABASE_MODE ? null : nativeBridge();
      if (bridge && (!bridge.cloudUrl() || !bridge.token())) {
        setAuth({ status: 'anonymous' });
        return;
      }
      try {
        const id = await restoreSession();
        if (!cancelled) setAuth(authOf(id));
      } catch (e) {
        if (cancelled) return;
        const err = e as CloudRequestError;
        if (err.status === 401 || err.code === 'NO_CLOUD') setAuth({ status: 'anonymous' });
        else retry = setTimeout(check, 5000); // the cloud is down or starting — keep trying
      }
    };
    void check();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, []);

  useEffect(
    () =>
      subscribeApi((signal) => {
        if (signal.type === 'online') setOnline(signal.online);
        else setAuth({ status: 'anonymous' });
      }),
    [],
  );

  // In the phone app: (re)register this phone for pushes on every sign-in and start —
  // the FCM token may have changed; registration is idempotent by token.
  const signedIn = auth.status === 'ok';
  useEffect(() => {
    if (signedIn && nativeBridge() && !SUPABASE_MODE) void enablePhonePush();
  }, [signedIn]);

  return { auth, setAuth, online };
}

interface Toast {
  id: number;
  text: string;
  href: string;
}

let toastSeq = 0;

/**
 * Supabase mode: new alerts arrive over Realtime (RLS shows only the owner's clubs). The open
 * screen reloads at once and a toast says what happened; the channel closes on sign-out.
 */
function useAlertToasts(signedIn: boolean) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    if (!signedIn || !SUPABASE_MODE) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stop = subscribeAlerts((alert) => {
      requestRefresh();
      const toast: Toast = { id: ++toastSeq, text: alert.message || 'Новая тревога в клубе', href: clubHref(alert.clubId) };
      setToasts((list) => [...list.slice(-2), toast]);
      const timer = setTimeout(() => {
        timers.delete(timer);
        setToasts((list) => list.filter((t) => t.id !== toast.id));
      }, 10_000);
      timers.add(timer);
    });
    return () => {
      stop();
      for (const t of timers) clearTimeout(t);
      setToasts([]);
    };
  }, [signedIn]);
  const dismiss = (id: number) => setToasts((list) => list.filter((t) => t.id !== id));
  return { toasts, dismiss };
}

function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span className="toast-dot" aria-hidden="true" />
          <a className="toast-text" href={t.href} onClick={() => dismiss(t.id)}>
            {t.text}
          </a>
          <button type="button" className="toast-close" aria-label="Закрыть" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const { auth, setAuth, online } = useAuth();
  const route = useHashRoute();
  const { toasts, dismiss } = useAlertToasts(auth.status === 'ok');

  // The download page needs no account: the owner opens it on a fresh phone before signing in,
  // and it must work even while the cloud is unreachable (installers come from GitHub).
  if (route.kind === 'apps' && auth.status !== 'ok') {
    return (
      <main className="app">
        <AppsPage signedIn={false} />
      </main>
    );
  }

  if (auth.status === 'loading') {
    return (
      <main className="boot">
        <p>{online ? 'Загрузка…' : 'Подключаемся к облаку…'}</p>
        {/* The phone app keeps retrying a stored address: let the owner fix it instead of waiting forever. */}
        {!online && nativeBridge() && !SUPABASE_MODE && (
          <>
            <p className="muted">{nativeBridge()?.cloudUrl()}</p>
            <button type="button" className="btn btn-small" onClick={() => setAuth({ status: 'anonymous' })}>
              Сменить адрес облака
            </button>
          </>
        )}
      </main>
    );
  }

  if (auth.status === 'anonymous') {
    const onLogin = (id: Identity) => {
      markReturning();
      if (route.kind === 'login' || route.kind === 'signup') location.hash = '#/';
      setAuth(authOf(id));
    };
    return (
      <>
        <OfflineBanner online={online} />
        {route.kind === 'signup' && SIGNUP_AVAILABLE ? (
          <Signup
            onLogin={(id) => {
              markReturning();
              location.hash = '#/start';
              setAuth(authOf(id));
            }}
          />
        ) : (
          <Login key={route.kind === 'login' ? 'form' : 'start'} start={route.kind === 'login' ? 'form' : 'welcome'} onLogin={onLogin} />
        )}
      </>
    );
  }

  // Supabase: the letter's link or a temporary password — the password first; #/set-password by choice.
  if (SUPABASE_MODE && (auth.status === 'ok' || auth.status === 'platform') && (auth.mustSetPassword || route.kind === 'set-password')) {
    const signedIn = auth;
    return (
      <SetPasswordPage
        email={signedIn.owner?.email ?? null}
        forced={signedIn.mustSetPassword === true}
        onDone={() => {
          location.hash = '#/';
          setAuth({ ...signedIn, mustSetPassword: false });
        }}
        onSignOut={() => {
          void logout()
            .catch(() => undefined)
            .then(() => setAuth({ status: 'anonymous' }));
        }}
      />
    );
  }

  if (auth.status === 'platform') {
    const signOutPlatform = async () => {
      try {
        await platformLogout();
      } catch {
        // The session may already be gone; either way back to the login form.
      }
      setAuth({ status: 'anonymous' });
    };
    const asManager = auth.owner;
    return (
      <PlatformCabinet
        me={auth.me}
        online={online}
        onSignOut={() => void signOutPlatform()}
        onSwitchToManager={asManager ? () => setAuth({ status: 'ok', owner: asManager, platform: auth.me }) : undefined}
      />
    );
  }

  const { owner, platform } = auth;

  async function signOut() {
    try {
      await logout();
    } catch {
      // The cookie may already be gone; either way the cabinet shows the login form.
    }
    resetPhonePush();
    setAuth({ status: 'anonymous' });
  }

  // Signed in, «Начать бесплатно» and the sign-in form have nothing to show: the overview instead.
  const page = route.kind === 'signup' || route.kind === 'login' ? ({ kind: 'overview' } as const) : route;

  return (
    <div className="app app-cabinet">
      <header className="topbar">
        <a className="brand" href="#/">
          <BrandMark />
          <div>
            <h1>{owner.company.name}</h1>
            <p className="muted">Кабинет TS</p>
          </div>
        </a>
        <div className="topbar-right">
          <span className="conn" data-online={online || undefined} title={online ? 'Кабинет на связи' : 'Нет связи с интернетом'}>
            <span className="conn-text">{online ? 'На связи' : 'Нет связи'}</span>
          </span>
          <span className="owner" title={owner.email}>
            {owner.name || owner.email}
          </span>
          {platform && (
            <button
              type="button"
              className="btn btn-small btn-link"
              onClick={() => {
                location.hash = '#/';
                setAuth({ status: 'platform', me: platform, owner });
              }}
            >
              Кабинет платформы
            </button>
          )}
          <button type="button" className="btn btn-small" onClick={() => void signOut()}>
            Выйти
          </button>
        </div>
      </header>

      <CabinetNav route={page} />

      <OfflineBanner online={online} />
      <Toasts toasts={toasts} dismiss={dismiss} />

      {page.kind === 'overview' && <Overview companyId={owner.company.id} />}
      {page.kind === 'start' && <StartPage companyId={owner.company.id} />}
      {page.kind === 'apps' && <AppsPage signedIn />}
      {page.kind === 'club' && <ClubPage key={page.id} id={page.id} />}
      {page.kind === 'tariffs' && <Tariffs key={page.id} id={page.id} />}
      {page.kind === 'shifts' && <Shifts key={page.id} id={page.id} />}
      {page.kind === 'staff' && <StaffPage key={page.id} clubId={page.id} />}
      {page.kind === 'bookings' && <BookingsPage key={page.id} id={page.id} />}
      {page.kind === 'staff-home' && <StaffHome />}
      {page.kind === 'company' && <CompanyPage companyId={owner.company.id} />}
      {page.kind === 'phone' && <Phone />}
    </div>
  );
}
