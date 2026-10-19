import type { ReactNode } from 'react';
import type { ClassifiedRelease, VisitorPlatform, ReleaseAsset } from '@bills/domain';
import { detectPlatform, formatSize, releasesPageUrl } from '@bills/domain';
import { BrandMark } from './BrandMark.tsx';
import { useLatestRelease } from './releases.ts';
import type { ReleaseState } from './releases.ts';

/**
 * «Скачать приложение» (#/apps): the owner app for Android as an APK, the
 * cabinet itself on the iPhone home screen, and the cash-desk installers for
 * computers. Installers live in GitHub Releases, not in the app stores.
 * Open without signing in too — the owner may land here from a fresh phone.
 */

type SectionKey = 'android' | 'ios' | 'desktop';

function sectionOrder(platform: VisitorPlatform): SectionKey[] {
  if (platform === 'ios') return ['ios', 'android', 'desktop'];
  if (platform === 'windows' || platform === 'linux' || platform === 'mac') return ['desktop', 'android', 'ios'];
  return ['android', 'ios', 'desktop'];
}

function devicePlatform(): VisitorPlatform {
  try {
    return detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  } catch {
    return 'other';
  }
}

function isStandalone(): boolean {
  try {
    if (matchMedia('(display-mode: standalone)').matches) return true;
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

function ReleaseLine({ state }: { state: ReleaseState }) {
  const page = releasesPageUrl();
  if (state.status === 'loading') return <p className="muted">Проверяем последнюю версию…</p>;
  if (state.status === 'ok') {
    const r = state.release;
    return (
      <p className="apps-release">
        <span className="tag tag-new">Версия {r.version}</span>
        {r.publishedAt !== null && <span className="muted">от {dateFormat.format(r.publishedAt)}</span>}
        <a className="link" href={r.pageUrl} target="_blank" rel="noreferrer">
          Все файлы на GitHub
        </a>
      </p>
    );
  }
  return (
    <div className="apps-note" role="status">
      <p>
        {state.status === 'none'
          ? 'Релизов пока нет — установщики ещё не выложены.'
          : `Не удалось узнать последнюю версию: ${state.message}.`}
      </p>
      <a className="link" href={page} target="_blank" rel="noreferrer">
        Открыть страницу релизов на GitHub
      </a>
    </div>
  );
}

function AssetLink({ asset, primary, label }: { asset: ReleaseAsset; primary?: boolean; label?: string }) {
  return (
    <a className={primary ? 'btn btn-primary apps-download' : 'btn apps-download'} href={asset.url} download>
      <span>{label ?? asset.name}</span>
      <span className="apps-size">
        {label ? `${asset.name} · ` : ''}
        {formatSize(asset.size)}
      </span>
    </a>
  );
}

function Missing({ state, what }: { state: ReleaseState; what: string }) {
  if (state.status === 'loading') return <p className="muted">Загрузка…</p>;
  return (
    <p className="muted">
      {state.status === 'ok' ? `В последнем релизе нет ${what}. ` : ''}
      <a className="link" href={releasesPageUrl()} target="_blank" rel="noreferrer">
        Страница релизов на GitHub
      </a>
    </p>
  );
}

function AppSection({ title, lead, current, children }: { title: string; lead: string; current: boolean; children: ReactNode }) {
  return (
    <section className="panel apps-section" data-current={current || undefined}>
      <header className="panel-head">
        <h2>{title}</h2>
        {current && <span className="tag">это устройство</span>}
      </header>
      <p className="muted">{lead}</p>
      {children}
    </section>
  );
}

function AndroidSection({ state, release, current }: { state: ReleaseState; release: ClassifiedRelease | null; current: boolean }) {
  const [apk, ...rest] = release?.android ?? [];
  return (
    <AppSection title="Android (телефон владельца)" lead="Приложение владельца ставится файлом APK, без Google Play." current={current}>
      {apk ? (
        <div className="apps-files">
          <AssetLink asset={apk} primary label="Скачать APK" />
          {rest.map((a) => (
            <AssetLink key={a.url} asset={a} />
          ))}
        </div>
      ) : (
        <Missing state={state} what="APK для Android" />
      )}
      <ol className="apps-steps">
        <li>Нажмите «Скачать APK» на телефоне и дождитесь загрузки.</li>
        <li>Откройте скачанный файл — из уведомления или из папки «Загрузки».</li>
        <li>
          Телефон попросит разрешить <b>«Установка из неизвестных источников»</b> для браузера — включите и вернитесь
          назад.
        </li>
        <li>Нажмите «Установить».</li>
      </ol>
      <p className="hint">
        Если Play Защита предупредит о неизвестном приложении — нажмите «Подробнее» → <b>«Всё равно установить»</b>.
        Обновление: скачайте новый APK и установите его поверх — данные и вход сохранятся.
      </p>
    </AppSection>
  );
}

function IosSection({ current }: { current: boolean }) {
  const standalone = isStandalone();
  const address = `${location.origin}/`;
  return (
    <AppSection
      title="iPhone и iPad"
      lead="Отдельного приложения нет: кабинет ставится на экран «Домой» и открывается как приложение — без адресной строки."
      current={current}
    >
      {standalone ? (
        <p className="apps-note">Кабинет уже открыт как приложение.</p>
      ) : (
        <ol className="apps-steps">
          <li>
            Откройте кабинет в <b>Safari</b>: <a href={address}>{address}</a>
          </li>
          <li>
            Нажмите «Поделиться» <span aria-hidden="true">⎙</span> внизу экрана.
          </li>
          <li>Выберите «На экран „Домой“».</li>
          <li>Нажмите «Добавить» — на экране появится значок TS.</li>
        </ol>
      )}
      <p className="hint">Chrome и другие браузеры на iPhone так не умеют — нужен именно Safari.</p>
    </AppSection>
  );
}

function DesktopSection({ state, release, current }: { state: ReleaseState; release: ClassifiedRelease | null; current: boolean }) {
  const groups: Array<{ label: string; assets: ReleaseAsset[] }> = [
    { label: 'Windows', assets: release?.windows ?? [] },
    { label: 'Linux', assets: release?.linux ?? [] },
    { label: 'macOS', assets: release?.mac ?? [] },
  ].filter((g) => g.assets.length > 0);
  return (
    <AppSection
      title="Компьютер (касса, Windows / Linux)"
      lead="Программа для кассы и экрана зала на компьютере клуба."
      current={current}
    >
      {groups.length > 0 ? (
        groups.map((g) => (
          <div key={g.label} className="apps-group">
            <h3>{g.label}</h3>
            <div className="apps-files">
              {g.assets.map((a, i) => (
                <AssetLink key={a.url} asset={a} primary={i === 0 && g === groups[0]} />
              ))}
            </div>
          </div>
        ))
      ) : (
        <Missing state={state} what="установщиков для компьютера" />
      )}
      <p className="hint">
        Установщик без платной подписи, поэтому Windows может показать окно SmartScreen «Система Windows защитила ваш
        компьютер» — нажмите «Подробнее» → <b>«Выполнить в любом случае»</b>. Для Windows берите .msi или .exe, для
        Linux — .deb (Ubuntu, Debian) или .AppImage (любой дистрибутив).
      </p>
    </AppSection>
  );
}

export function AppsPage({ signedIn }: { signedIn: boolean }) {
  const state = useLatestRelease();
  const platform = devicePlatform();
  const release = state.status === 'ok' ? state.release : null;
  const first = sectionOrder(platform)[0];

  const sections: Record<SectionKey, ReactNode> = {
    android: <AndroidSection key="android" state={state} release={release} current={platform === 'android'} />,
    ios: <IosSection key="ios" current={platform === 'ios'} />,
    desktop: (
      <DesktopSection
        key="desktop"
        state={state}
        release={release}
        current={first === 'desktop' && platform !== 'other'}
      />
    ),
  };

  return (
    <div className="apps-page">
      <header className="apps-head">
        {!signedIn && <BrandMark />}
        <div>
          <a className="back" href="#/">
            {signedIn ? '← К обзору' : '← Войти в кабинет'}
          </a>
          <h2>Скачать приложение</h2>
          <ReleaseLine state={state} />
        </div>
      </header>
      <div className="apps-sections">{sectionOrder(platform).map((key) => sections[key])}</div>
      {!signedIn && (
        <p className="apps-foot">
          <a className="btn btn-primary" href="#/">
            Войти
          </a>
        </p>
      )}
    </div>
  );
}
