import { useEffect, useState } from 'react';
import type { OwnerView } from '@bills/domain';
import { CloudRequestError, fetchMe, logout, subscribeApi } from './api.ts';
import { ClubPage } from './ClubPage.tsx';
import { useHashRoute } from './hooks.ts';
import { Login } from './Login.tsx';
import { Overview } from './Overview.tsx';
import { OfflineBanner } from './shared.tsx';
import { Shifts } from './Shifts.tsx';
import { Tariffs } from './Tariffs.tsx';
import { BrandMark } from './BrandMark.tsx';
import { Phone } from './Phone.tsx';
import { enablePhonePush, resetPhonePush } from './phonePush.ts';
import { nativeBridge } from './platform.ts';

type Auth = { status: 'loading' } | { status: 'anonymous' } | { status: 'ok'; owner: OwnerView };

function useAuth() {
  const [auth, setAuth] = useState<Auth>({ status: 'loading' });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      // The phone app without a cloud address or a token has nothing to ask: straight to the login form.
      const bridge = nativeBridge();
      if (bridge && (!bridge.cloudUrl() || !bridge.token())) {
        setAuth({ status: 'anonymous' });
        return;
      }
      try {
        const owner = await fetchMe();
        if (!cancelled) setAuth({ status: 'ok', owner });
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
    if (signedIn && nativeBridge()) void enablePhonePush();
  }, [signedIn]);

  return { auth, setAuth, online };
}

export function App() {
  const { auth, setAuth, online } = useAuth();
  const route = useHashRoute();

  if (auth.status === 'loading') {
    return (
      <main className="boot">
        <p>{online ? 'Загрузка…' : 'Подключаемся к облаку…'}</p>
        {/* The phone app keeps retrying a stored address: let the owner fix it instead of waiting forever. */}
        {!online && nativeBridge() && (
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
    return (
      <>
        <OfflineBanner online={online} />
        <Login onLogin={(owner) => setAuth({ status: 'ok', owner })} />
      </>
    );
  }

  const { owner } = auth;

  async function signOut() {
    try {
      await logout();
    } catch {
      // The cookie may already be gone; either way the cabinet shows the login form.
    }
    resetPhonePush();
    setAuth({ status: 'anonymous' });
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">
          <BrandMark />
          <div>
            <h1>{owner.company.name}</h1>
            <p className="muted">Кабинет владельца</p>
          </div>
        </a>
        <div className="topbar-right">
          <span className="conn" data-online={online || undefined}>
            {online ? 'Облако на связи' : 'Нет связи с облаком'}
          </span>
          <span className="owner" title={owner.email}>
            {owner.name || owner.email}
          </span>
          <a
            className="btn btn-small btn-link"
            href="#/phone"
            aria-current={route.kind === 'phone' ? 'page' : undefined}
          >
            Телефон и уведомления
          </a>
          <button type="button" className="btn btn-small" onClick={() => void signOut()}>
            Выйти
          </button>
        </div>
      </header>

      <OfflineBanner online={online} />

      {route.kind === 'overview' && <Overview />}
      {route.kind === 'club' && <ClubPage key={route.id} id={route.id} />}
      {route.kind === 'tariffs' && <Tariffs key={route.id} id={route.id} />}
      {route.kind === 'shifts' && <Shifts key={route.id} id={route.id} />}
      {route.kind === 'phone' && <Phone />}
    </div>
  );
}
