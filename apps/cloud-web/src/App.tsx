import { useEffect, useState } from 'react';
import type { OwnerView } from '@bills/domain';
import { AppsPage } from './Apps.tsx';
import { CloudRequestError, fetchMe, logout, subscribeApi } from './api.ts';
import { ClubPage } from './ClubPage.tsx';
import { useHashRoute } from './hooks.ts';
import { Login } from './Login.tsx';
import { Overview } from './Overview.tsx';
import { OfflineBanner } from './shared.tsx';
import { Shifts } from './Shifts.tsx';
import { Tariffs } from './Tariffs.tsx';
import { BrandMark } from './BrandMark.tsx';

type Auth = { status: 'loading' } | { status: 'anonymous' } | { status: 'ok'; owner: OwnerView };

function useAuth() {
  const [auth, setAuth] = useState<Auth>({ status: 'loading' });
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const owner = await fetchMe();
        if (!cancelled) setAuth({ status: 'ok', owner });
      } catch (e) {
        if (cancelled) return;
        const err = e as CloudRequestError;
        if (err.status === 401) setAuth({ status: 'anonymous' });
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

  return { auth, setAuth, online };
}

export function App() {
  const { auth, setAuth, online } = useAuth();
  const route = useHashRoute();

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
          <a className="topbar-link" href="#/apps" aria-current={route.kind === 'apps' ? 'page' : undefined}>
            Скачать приложение
          </a>
          <span className="owner" title={owner.email}>
            {owner.name || owner.email}
          </span>
          <button type="button" className="btn btn-small" onClick={() => void signOut()}>
            Выйти
          </button>
        </div>
      </header>

      <OfflineBanner online={online} />

      {route.kind === 'overview' && <Overview />}
      {route.kind === 'apps' && <AppsPage signedIn />}
      {route.kind === 'club' && <ClubPage key={route.id} id={route.id} />}
      {route.kind === 'tariffs' && <Tariffs key={route.id} id={route.id} />}
      {route.kind === 'shifts' && <Shifts key={route.id} id={route.id} />}
    </div>
  );
}
