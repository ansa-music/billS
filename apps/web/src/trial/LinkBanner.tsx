import { useEffect, useReducer, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { BrandMark } from '../BrandMark.tsx';
import { forgetLink, isLinkMode, linkViewState, linkViewVersion, retryLink, subscribeLinkView } from '../demo-hub/link-mode.ts';
import { useLocation } from '../router.tsx';
import { CloudMovedScreen } from './TrialCloud.tsx';
import '../onboarding/onboarding.css';
import './trial.css';

/**
 * «Подключить устройство» on the phone or tablet: the status line over every page — «Касса на связи» or
 * «Касса не отвечает — проверьте, что TS открыт на кассе» with «Повторить» — a small badge on the order
 * board (a TV has no menu), and the screen shown once the cash desk switched the device off. Nothing
 * outside link mode.
 */

/** «Подключаемся…» this long before it is worth a word more. */
const SLOW_MS = 4000;

function useLinkView() {
  useSyncExternalStore(subscribeLinkView, linkViewVersion);
  // «давно подключаемся» depends on the clock too.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 2000);
    return () => clearInterval(t);
  }, []);
  return linkViewState();
}

function confirmForget(): void {
  if (window.confirm('Отключить это устройство от кассы? Чтобы подключить его снова, понадобится QR-код или ссылка с кассы.')) forgetLink();
}

function texts(v: ReturnType<typeof linkViewState>): { tone: 'ok' | 'wait' | 'bad'; title: string; detail: string } {
  if (v.problem) return { tone: 'bad', title: 'Не получается подключиться к кассе', detail: v.problem };
  switch (v.status) {
    case 'online':
      return { tone: 'ok', title: 'Касса на связи', detail: v.direct ? 'напрямую по Wi-Fi' : 'через интернет' };
    case 'connecting':
      return {
        tone: 'wait',
        title: 'Подключаемся к кассе…',
        detail: Date.now() - v.since > SLOW_MS ? 'TS должен быть открыт на кассе' : '',
      };
    case 'offline':
    case 'revoked':
      return {
        tone: 'bad',
        title: 'Касса не отвечает',
        detail: v.cloud ? 'проверьте, что TS открыт на кассе' : 'проверьте интернет на этом устройстве и что TS открыт на кассе',
      };
  }
}

export function LinkBanner() {
  const v = useLinkView();
  if (!isLinkMode()) return null;
  const t = texts(v);
  return (
    <div className="pwa-banner link-banner" data-tone={t.tone} role={t.tone === 'bad' ? 'alert' : 'status'}>
      <span className="link-dot" aria-hidden="true" />
      <p className="pwa-banner-text">
        <strong>{t.title}</strong>
        {t.detail ? ` — ${t.detail}` : ''}
      </p>
      <div className="pwa-banner-actions">
        {t.tone === 'bad' && (
          <button type="button" className="btn btn-small" onClick={retryLink}>
            Повторить
          </button>
        )}
        <button type="button" className="btn btn-small btn-ghost" onClick={confirmForget}>
          Отключить устройство
        </button>
      </div>
    </div>
  );
}

/** The order board on a TV: a small corner badge, only while the cash desk is not reached. */
function BoardBadge() {
  const v = useLinkView();
  if (v.status === 'online') return null;
  const t = texts(v);
  return (
    <div className="link-board-badge" data-tone={t.tone} role="status">
      <span className="link-dot" aria-hidden="true" />
      <span>
        <strong>{t.title}</strong>
        {t.detail ? ` — ${t.detail}` : ''}
      </span>
    </div>
  );
}

/** Full screen: the cash desk switched this device off. */
export function LinkRevokedScreen() {
  return (
    <section className="page onboarding trial-welcome watch-problem">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Устройство отключено на кассе</h1>
          <p className="page-lead">
            На кассе нажали «Отключить все устройства». Чтобы работать с этого устройства снова, попросите директора показать новый
            QR-код: на кассе нажмите на своё имя вверху → «Подключить устройство».
          </p>
        </div>
      </header>
      <div className="onboarding-actions">
        <button type="button" className="btn btn-primary btn-large" onClick={forgetLink}>
          Понятно
        </button>
      </div>
    </section>
  );
}

/**
 * The app while the link works; the «отключено» screen once the cash desk switched the device off; «Касса
 * переехала в облако» once the cash desk's answers say the café is in the cloud cash desk (the device opens it there).
 */
export function LinkGate({ children }: { children: ReactNode }) {
  const v = useLinkView();
  const { path } = useLocation();
  if (v.status === 'revoked') return <LinkRevokedScreen />;
  if (v.inCloud) {
    return (
      <CloudMovedScreen
        cloud={v.inCloud}
        extra={
          <button type="button" className="btn btn-ghost" onClick={confirmForget}>
            Отключить это устройство
          </button>
        }
      />
    );
  }
  return (
    <>
      {children}
      {path === '/board' && <BoardBadge />}
    </>
  );
}
