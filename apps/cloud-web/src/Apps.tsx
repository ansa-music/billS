import { Fragment, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ClassifiedRelease, DownloadCard, DownloadKind, DownloadStep, ReleaseAsset, VisitorPlatform } from '@bills/domain';
import {
  ANDROID_STEPS,
  DOWNLOAD_TEXT,
  MINIPC_COMMAND_STEPS,
  MINIPC_GUIDE_URL,
  MINIPC_IMAGE_STEPS,
  PLATFORM_NAME,
  assetFileText,
  assetLinkText,
  computerDownload,
  downloadPath,
  computerSteps,
  detectPlatform,
  downloadCards,
  releaseVersionText,
  releasesPageUrl,
} from '@bills/domain';
import { BrandMark } from './BrandMark.tsx';
import { QrImage } from './QrImage.tsx';
import { useLatestRelease } from './releases.ts';
import type { ReleaseState } from './releases.ts';

/**
 * «Скачать приложение» (#/apps): the cash-desk app for Windows, the owner app
 * for Android, the USB image of the club's mini-PC (with the one-command
 * install as the alternative) and the cabinet on the iPhone home screen. The
 * visitor's device goes first. Files live in GitHub Releases; the cards, their
 * order and texts are shared with the hall screens through @bills/domain.
 * Open without signing in too — the owner may land here from a fresh phone.
 */

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

const PHONE_PATH =
  'M7.5 2.5h9a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V4a1.5 1.5 0 0 1 1.5-1.5z M11 18.5h2';

const ICON_PATHS: Record<DownloadCard | 'download', string> = {
  computer: 'M3 4.5h18v11.5H3z M8.5 20h7 M12 16v4',
  android: PHONE_PATH,
  ios: PHONE_PATH,
  minipc: 'M4.5 7.5h15a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15V9a1.5 1.5 0 0 1 1.5-1.5z M6.5 12h4 M16.5 12h1',
  download: 'M12 3.5v11 M7 10l5 5 5-5 M5 20.5h14',
};

function Glyph({ name, size = 24 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** The command with a «Скопировать» button; without a clipboard (plain http) it is selected for copying by hand. */
function CommandBox({ command }: { command: string }) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<'ok' | 'manual' | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied('ok');
    } catch {
      const el = ref.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCopied('manual');
    }
  };
  return (
    <span className="dl-command">
      <code ref={ref}>{command}</code>
      <button type="button" className="btn btn-small" onClick={() => void copy()}>
        {copied === 'ok' ? 'Скопировано' : 'Скопировать'}
      </button>
      <span className="dl-command-status" role="status">
        {copied === 'manual' ? 'Команда выделена — скопируйте её вручную.' : ''}
      </span>
    </span>
  );
}

function StepText({ step }: { step: DownloadStep }) {
  return (
    <>
      {step.map((part, i) => {
        if (typeof part === 'string') return <Fragment key={i}>{part}</Fragment>;
        if ('strong' in part) return <b key={i}>{part.strong}</b>;
        if ('command' in part) return <CommandBox key={i} command={part.command} />;
        return (
          <a key={i} className="dl-inline-link" href={part.href} target="_blank" rel="noreferrer">
            {part.text}
          </a>
        );
      })}
    </>
  );
}

function Steps({ steps }: { steps: readonly DownloadStep[] }) {
  return (
    <ol className="dl-steps">
      {steps.map((step, i) => (
        <li key={i}>
          <StepText step={step} />
        </li>
      ))}
    </ol>
  );
}

interface CardProps {
  card: DownloadCard;
  kicker: string;
  title: string;
  current: boolean;
  wide: boolean;
  /** Left column on a wide card: what it is and the download button. */
  main: ReactNode;
  /** Right column on a wide card: the steps. */
  more: ReactNode;
}

function Card({ card, kicker, title, current, wide, main, more }: CardProps) {
  return (
    <section
      className="panel dl-card"
      data-current={current || undefined}
      data-wide={wide || undefined}
      aria-labelledby={`dl-${card}`}
    >
      <header className="dl-card-head">
        <span className="dl-icon">
          <Glyph name={card} />
        </span>
        <div className="dl-title">
          <p className="dl-kicker">{kicker}</p>
          <h3 id={`dl-${card}`}>{title}</h3>
        </div>
        {current && <span className="tag dl-current">{DOWNLOAD_TEXT.current}</span>}
      </header>
      <div className="dl-card-body">
        <div className="dl-main">{main}</div>
        {more && <div className="dl-more">{more}</div>}
      </div>
    </section>
  );
}

/** The big button with the version above and the file size below — or «скоро» when there is no file yet. */
function Download({
  state,
  asset,
  release,
  label,
  soon,
  extra,
  share,
}: {
  state: ReleaseState;
  asset: ReleaseAsset | null | undefined;
  release: ClassifiedRelease | null;
  label: string;
  soon: string;
  extra?: ReactNode;
  /** Short link /download/<kind> that always gives the latest file; null where the site has none. */
  share?: string | null;
}) {
  if (state.status === 'loading') return <p className="dl-wait">{DOWNLOAD_TEXT.loading}</p>;
  if (!asset) {
    if (state.status === 'error') {
      return (
        <p className="dl-soon" data-quiet>
          Новую версию проверить не удалось.{' '}
          <a className="dl-inline-link" href={releasesPageUrl()} target="_blank" rel="noreferrer">
            {DOWNLOAD_TEXT.allVersions}
          </a>
        </p>
      );
    }
    return <p className="dl-soon">{soon}</p>;
  }
  return (
    <div className="dl-get">
      {release && <p className="dl-version">{releaseVersionText(release)}</p>}
      <a className="btn btn-primary dl-button" href={asset.url} download>
        <Glyph name="download" size={22} />
        {label}
      </a>
      <p className="dl-file">
        {assetFileText(asset)}
        {extra}
      </p>
      {share && (
        <p className="dl-file">
          Ссылка, чтобы отправить в WhatsApp или Telegram:{' '}
          <a className="dl-inline-link" href={share}>
            {share.replace(/^https?:\/\//, '')}
          </a>
        </p>
      )}
    </div>
  );
}

function OtherFiles({ assets }: { assets: ReleaseAsset[] }) {
  if (assets.length === 0) return null;
  return (
    <ul className="dl-others" aria-label="Другие версии">
      {assets.map((a) => (
        <li key={a.url}>
          <a href={a.url} download>
            {assetLinkText(a)}
          </a>
        </li>
      ))}
    </ul>
  );
}

function IosCard({ current, wide }: { current: boolean; wide: boolean }) {
  const standalone = isStandalone();
  const address = `${location.origin}/`;
  return (
    <Card
      card="ios"
      kicker="Телефон владельца"
      title="iPhone и iPad"
      current={current}
      wide={wide}
      main={
        <>
          <p className="dl-lead">
            Отдельного приложения нет: кабинет ставится на экран «Домой» и открывается как приложение — без адресной
            строки.
          </p>
          {standalone && <p className="dl-soon">Кабинет уже открыт как приложение.</p>}
        </>
      }
      more={
        standalone ? null : (
          <>
            <ol className="dl-steps">
              <li>
                Откройте кабинет в <b>Safari</b>:{' '}
                <a className="dl-inline-link dl-address" href={address}>
                  {address}
                </a>
              </li>
              <li>
                Нажмите «Поделиться» <span aria-hidden="true">⎙</span> внизу экрана.
              </li>
              <li>
                Выберите <b>«На экран „Домой“»</b>.
              </li>
              <li>Нажмите «Добавить» — на экране появится значок TS.</li>
            </ol>
            <p className="dl-note">Chrome и другие браузеры на iPhone так не умеют — нужен именно Safari.</p>
          </>
        )
      }
    />
  );
}

export function AppsPage({ signedIn }: { signedIn: boolean }) {
  const state = useLatestRelease();
  const platform = devicePlatform();
  const catalog = state.status === 'ok' ? state.release : null;
  const { order, current } = downloadCards(platform, catalog);
  const onComputer = platform === 'windows' || platform === 'linux' || platform === 'mac';
  // The device's card spans the row; an odd card left over at the end spans it too.
  const rest = order.length - (current ? 1 : 0);
  const isWide = (card: DownloadCard, i: number) => card === current || (i === order.length - 1 && rest % 2 === 1);

  const computer = computerDownload(catalog, platform);
  // Short links /download/<kind> are a Cloudflare Pages Function: not on the GitHub Pages copy.
  const shortLink = (kind: DownloadKind) =>
    location.hostname.endsWith('github.io') || location.hostname === 'localhost' ? null : `${location.origin}${downloadPath(kind)}`;
  const system = computer.primary?.platform ?? 'windows';
  const apk = catalog?.android[0];
  const image = catalog?.minipc[0];
  // Known to have no image (not just still loading or unreachable): the command is the way for now.
  const noImage = !image && (state.status === 'ok' || state.status === 'none');

  const cards: Record<DownloadCard, (wide: boolean) => ReactNode> = {
    computer: (wide) => (
      <Card
        key="computer"
        card="computer"
        kicker={DOWNLOAD_TEXT.computer.kicker}
        title={PLATFORM_NAME[system]}
        current={current === 'computer'}
        wide={wide}
        main={
          <>
            <p className="dl-lead">{DOWNLOAD_TEXT.computer.lead}</p>
            <Download
              state={state}
              asset={computer.primary}
              release={catalog?.desktopRelease ?? null}
              label={`Скачать для ${PLATFORM_NAME[system]}`}
              soon={DOWNLOAD_TEXT.computer.soon}
              share={computer.primary ? shortLink(computer.primary.platform === 'linux' ? 'linux' : 'windows') : null}
            />
            <OtherFiles assets={computer.others} />
          </>
        }
        more={<Steps steps={computerSteps(system)} />}
      />
    ),
    android: (wide) => (
      <Card
        key="android"
        card="android"
        kicker={DOWNLOAD_TEXT.android.kicker}
        title={DOWNLOAD_TEXT.android.title}
        current={current === 'android'}
        wide={wide}
        main={
          <>
            <p className="dl-lead">{DOWNLOAD_TEXT.android.lead}</p>
            <Download
              state={state}
              asset={apk}
              release={catalog?.androidRelease ?? null}
              label={DOWNLOAD_TEXT.android.button}
              soon={DOWNLOAD_TEXT.android.soon}
              share={shortLink('android')}
            />
            {apk && onComputer && (
              <div className="dl-qr">
                <QrImage text={shortLink('android') ?? apk.url} alt="QR-код: скачать приложение на телефон" />
                <p>{DOWNLOAD_TEXT.android.qr}</p>
              </div>
            )}
          </>
        }
        more={
          <>
            <Steps steps={ANDROID_STEPS} />
            <p className="dl-note">{DOWNLOAD_TEXT.android.hint}</p>
          </>
        }
      />
    ),
    minipc: (wide) => (
      <Card
        key="minipc"
        card="minipc"
        kicker={DOWNLOAD_TEXT.minipc.kicker}
        title={DOWNLOAD_TEXT.minipc.title}
        current={false}
        wide={wide}
        main={
          <>
            <p className="dl-lead">{DOWNLOAD_TEXT.minipc.lead}</p>
            <Download
              state={state}
              asset={image}
              release={catalog?.minipcRelease ?? null}
              label={DOWNLOAD_TEXT.minipc.button}
              soon={DOWNLOAD_TEXT.minipc.soon}
              share={shortLink('minipc')}
              extra={
                image?.checksumUrl && (
                  <>
                    {' · '}
                    <a href={image.checksumUrl} download>
                      контрольная сумма
                    </a>
                  </>
                )
              }
            />
            {image && (
              <p className="dl-warning" role="note">
                {DOWNLOAD_TEXT.minipc.warning}
              </p>
            )}
          </>
        }
        more={
          <>
            {image && <Steps steps={MINIPC_IMAGE_STEPS} />}
            <div className="dl-alt" data-first={!image || undefined}>
              <h4>
                {noImage ? DOWNLOAD_TEXT.minipc.commandTitleNoImage : DOWNLOAD_TEXT.minipc.commandTitle}
              </h4>
              <Steps steps={MINIPC_COMMAND_STEPS} />
            </div>
            <p className="dl-note">
              {DOWNLOAD_TEXT.minipc.windows}{' '}
              <a className="dl-inline-link" href={MINIPC_GUIDE_URL} target="_blank" rel="noreferrer">
                {DOWNLOAD_TEXT.minipc.guide}
              </a>
            </p>
          </>
        }
      />
    ),
    ios: (wide) => <IosCard key="ios" current={current === 'ios'} wide={wide} />,
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
          <p className="muted">Программы TS для компьютера кассы, телефона владельца и мини-ПК клуба.</p>
        </div>
      </header>
      {state.status === 'error' && (
        <p className="dl-alert" role="status">
          <span>{DOWNLOAD_TEXT.error}</span>
          <a className="link" href={releasesPageUrl()} target="_blank" rel="noreferrer">
            {DOWNLOAD_TEXT.allVersions}
          </a>
        </p>
      )}
      <div className="dl-cards">{order.map((card, i) => cards[card](isWide(card, i)))}</div>
      <p className="apps-foot">
        {!signedIn && (
          <a className="btn btn-primary" href="#/">
            Войти
          </a>
        )}
        <a className="link" href={releasesPageUrl()} target="_blank" rel="noreferrer">
          {DOWNLOAD_TEXT.allVersions}
        </a>
      </p>
    </div>
  );
}
