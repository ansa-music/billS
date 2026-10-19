import type { ReactNode } from 'react';
import type { ClassifiedRelease, DevicePlatform, ReleaseAsset } from '@bills/domain';
import { detectPlatform, formatSize, releasesPageUrl } from '@bills/domain';
import { Icon } from '../icons.tsx';
import { useInstallPrompt, useStandalone } from '../pwa.tsx';
import { useLatestRelease } from '../releases.ts';
import type { ReleaseState } from '../releases.ts';
import { Page, Section } from '../ui.tsx';
import './apps.css';

/**
 * «Приложения» (#/apps): installers outside the app stores. The owner app for
 * Android as an APK and the cash-desk installers for computers come from
 * GitHub Releases; this very screen can also go on a tablet's home screen as a
 * PWA. Hidden from the navigation, linked from the staff menu and the owner page.
 */

type SectionKey = 'android' | 'ios' | 'desktop' | 'screen';

function sectionOrder(platform: DevicePlatform): SectionKey[] {
  if (platform === 'ios') return ['ios', 'screen', 'android', 'desktop'];
  if (platform === 'windows' || platform === 'linux' || platform === 'mac') return ['desktop', 'screen', 'android', 'ios'];
  return ['android', 'screen', 'ios', 'desktop'];
}

function devicePlatform(): DevicePlatform {
  try {
    return detectPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  } catch {
    return 'other';
  }
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

function ReleaseLine({ state }: { state: ReleaseState }) {
  if (state.status === 'loading') return <>Проверяем последнюю версию…</>;
  if (state.status === 'ok') {
    const r = state.release;
    return (
      <span className="apps-release">
        <span className="tag tag-ok">Версия {r.version}</span>
        {r.publishedAt !== null && <span>от {dateFormat.format(r.publishedAt)}</span>}
        <a className="link" href={r.pageUrl} target="_blank" rel="noreferrer">
          Все файлы на GitHub
        </a>
      </span>
    );
  }
  return (
    <span className="apps-release">
      <span>
        {state.status === 'none'
          ? 'Релизов пока нет — установщики ещё не выложены.'
          : `Не удалось узнать последнюю версию: ${state.message}.`}
      </span>
      <a className="link" href={releasesPageUrl()} target="_blank" rel="noreferrer">
        Открыть страницу релизов на GitHub
      </a>
    </span>
  );
}

function AssetLink({ asset, primary, label }: { asset: ReleaseAsset; primary?: boolean; label?: string }) {
  return (
    <a className={primary ? 'btn btn-primary apps-download' : 'btn apps-download'} href={asset.url} download>
      <Icon name="download" size={18} />
      <span className="apps-download-text">
        <span>{label ?? asset.name}</span>
        <span className="apps-size">
          {label ? `${asset.name} · ` : ''}
          {formatSize(asset.size)}
        </span>
      </span>
    </a>
  );
}

function Missing({ state, what }: { state: ReleaseState; what: string }) {
  if (state.status === 'loading') return <p className="empty">Загрузка…</p>;
  return (
    <p className="empty">
      {state.status === 'ok' ? `В последнем релизе нет ${what}. ` : ''}
      <a className="link" href={releasesPageUrl()} target="_blank" rel="noreferrer">
        Страница релизов на GitHub
      </a>
    </p>
  );
}

function AppSection({ title, current, children }: { title: string; current: boolean; children: ReactNode }) {
  return (
    <Section title={title} aside={current ? <span className="tag tag-ok">это устройство</span> : undefined}>
      <div className="apps-body" data-current={current || undefined}>
        {children}
      </div>
    </Section>
  );
}

function AndroidSection({ state, release, current }: { state: ReleaseState; release: ClassifiedRelease | null; current: boolean }) {
  const [apk, ...rest] = release?.android ?? [];
  return (
    <AppSection title="Android (телефон владельца)" current={current}>
      <p className="muted">Приложение владельца ставится файлом APK, без Google Play.</p>
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
  const address = `${location.origin}/`;
  return (
    <AppSection title="iPhone и iPad" current={current}>
      <p className="muted">
        Этот экран клуба ставится на планшет персонала как приложение. Кабинет владельца открывается по адресу облака —
        на iPhone его так же добавляют на экран «Домой» из Safari.
      </p>
      <ol className="apps-steps">
        <li>
          Откройте в <b>Safari</b>: <a href={address}>{address}</a>
        </li>
        <li>
          Нажмите «Поделиться» <span aria-hidden="true">⎙</span>.
        </li>
        <li>Выберите «На экран „Домой“».</li>
        <li>Нажмите «Добавить» — на экране появится значок TS.</li>
      </ol>
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
    <AppSection title="Компьютер (касса, Windows / Linux)" current={current}>
      <p className="muted">Программа для кассы и экрана зала на компьютере клуба.</p>
      {groups.length > 0 ? (
        groups.map((g, gi) => (
          <div key={g.label} className="apps-group">
            <h3>{g.label}</h3>
            <div className="apps-files">
              {g.assets.map((a, i) => (
                <AssetLink key={a.url} asset={a} primary={gi === 0 && i === 0} />
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

/** This hall screen as an installed app (PWA), with the browser's own install prompt when it offers one. */
function ScreenSection() {
  const standalone = useStandalone();
  const install = useInstallPrompt();
  return (
    <AppSection title="Этот экран как приложение" current={false}>
      {standalone ? (
        <p>Экран уже открыт как приложение — без адресной строки, на весь экран.</p>
      ) : (
        <>
          <p className="muted">
            Экран зала можно поставить на планшет или компьютер значком, как обычное приложение: он откроется без
            адресной строки и будет обновляться сам.
          </p>
          {install.kind === 'native' && (
            <div className="apps-files">
              <button type="button" className="btn btn-primary apps-download" onClick={() => void install.install()}>
                <Icon name="download" size={18} /> Установить
              </button>
            </div>
          )}
          <ul className="apps-steps">
            <li>Android, Chrome на компьютере: меню ⋮ → «Установить приложение» или «Добавить на главный экран».</li>
            <li>iPhone, iPad: Safari → «Поделиться» → «На экран „Домой“».</li>
          </ul>
        </>
      )}
    </AppSection>
  );
}

export function AppsPage() {
  const state = useLatestRelease();
  const platform = devicePlatform();
  const release = state.status === 'ok' ? state.release : null;
  const desktop = platform === 'windows' || platform === 'linux' || platform === 'mac';

  const sections: Record<SectionKey, ReactNode> = {
    android: <AndroidSection key="android" state={state} release={release} current={platform === 'android'} />,
    ios: <IosSection key="ios" current={platform === 'ios'} />,
    desktop: <DesktopSection key="desktop" state={state} release={release} current={desktop} />,
    screen: <ScreenSection key="screen" />,
  };

  return (
    <Page title="Приложения" subtitle={<ReleaseLine state={state} />}>
      <div className="apps-sections">{sectionOrder(platform).map((key) => sections[key])}</div>
    </Page>
  );
}
