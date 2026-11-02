import { useEffect, useReducer, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { BrandMark } from '../BrandMark.tsx';
import type { WatchProblemKind } from '../demo-hub/watch-mode.ts';
import { isWatchMode, refreshWatch, stopWatching, subscribeWatch, watchVersion, watchView } from '../demo-hub/watch-mode.ts';
import { CloudMovedScreen, useCloudScreenDismissed } from './TrialCloud.tsx';
import '../onboarding/onboarding.css';
import './trial.css';

/**
 * «Смотреть с телефона» on the phone: the line over every page — «Только просмотр · данные кассы
 * на 14:32» with «Обновить» — the screens shown when the copy cannot open, and the gate that closes
 * the copy when the cash desk switched the link off. Nothing outside watch mode.
 */

/** A copy older than this gets «касса давно не присылала данные». */
const STALE_MS = 15 * 60_000;

/** «14:32» today, «1 ноября, 14:32» before. */
export function watchTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function confirmStop(): void {
  if (window.confirm('Перестать смотреть кассу на этом телефоне? Чтобы смотреть снова, понадобится новая ссылка с кассы.')) stopWatching();
}

export function WatchBanner() {
  useSyncExternalStore(subscribeWatch, watchVersion);
  // «давно не присылала» depends on the clock too.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!isWatchMode()) return null;
  const v = watchView();
  const stale = v.snapshotAt !== null && Date.now() - v.snapshotAt > STALE_MS;
  const extra = v.offline ? ' · нет связи с TS' : stale ? ' · касса давно не присылала данные' : '';
  return (
    <div className="pwa-banner watch-banner" data-stale={v.offline || stale || undefined} role="status">
      <p className="pwa-banner-text">
        <strong>Только просмотр</strong>
        {v.venue ? ` · ${v.venue}` : ''} · данные кассы на {v.snapshotAt !== null ? watchTime(v.snapshotAt) : '…'}
        {extra}
      </p>
      <div className="pwa-banner-actions">
        <button type="button" className="btn btn-small" disabled={v.checking} onClick={refreshWatch}>
          {v.checking ? 'Проверяем…' : 'Обновить'}
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={confirmStop}>
          Перестать смотреть
        </button>
      </div>
    </div>
  );
}

const PROBLEM: Record<WatchProblemKind, { title: string; lead: string; retry: boolean }> = {
  revoked: {
    title: 'Ссылка отключена',
    lead: 'На кассе нажали «Отключить телефоны», или ссылка устарела. Попросите новую: на кассе внизу меню «Пробная» → «Открыть на телефоне».',
    retry: false,
  },
  empty: {
    title: 'Касса ещё не прислала данные',
    lead: 'Откройте TS на кассе (нужен интернет) и подождите минуту, затем нажмите «Попробовать снова».',
    retry: true,
  },
  offline: {
    title: 'Нет связи с TS',
    lead: 'Проверьте интернет на телефоне и попробуйте снова.',
    retry: true,
  },
  broken: {
    title: 'Не удалось открыть данные кассы',
    lead: 'Обновите страницу TS на кассе, подождите минуту и попробуйте снова.',
    retry: true,
  },
  cloud: {
    title: 'Касса переехала в облако',
    lead: 'Теперь она работает на любом телефоне и компьютере. Откройте ссылку облачной кассы и войдите своим кодом.',
    retry: false,
  },
};

const stopButton = (
  <button type="button" className="btn btn-ghost" onClick={stopWatching}>
    Перестать смотреть
  </button>
);

/** Full screen: why the cash desk's data is not shown, and what to do. */
export function WatchProblemScreen({ kind, detail }: { kind: WatchProblemKind; detail?: string | undefined }) {
  const cloud = watchView().cloud;
  if (kind === 'cloud' && cloud) return <CloudMovedScreen cloud={cloud} extra={stopButton} />;
  const p = PROBLEM[kind];
  return (
    <section className="page onboarding trial-welcome watch-problem">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">{p.title}</h1>
          <p className="page-lead">{p.lead}</p>
          {kind === 'broken' && detail && <p className="muted watch-problem-detail">{detail}</p>}
        </div>
      </header>
      <div className="onboarding-actions">
        {p.retry && (
          <button type="button" className="btn btn-primary btn-large" onClick={() => window.location.reload()}>
            Попробовать снова
          </button>
        )}
        <button type="button" className={`btn btn-large ${p.retry ? 'btn-ghost' : 'btn-primary'}`} onClick={stopWatching}>
          Перестать смотреть
        </button>
      </div>
    </section>
  );
}

/**
 * The app while the link works; the «Ссылка отключена» screen once the cash desk switched it off; «Касса переехала
 * в облако» once the cloud says so (the old copy stays behind «Посмотреть старые данные»).
 */
export function WatchGate({ children }: { children: ReactNode }) {
  useSyncExternalStore(subscribeWatch, watchVersion);
  const [dismissed, dismiss] = useCloudScreenDismissed();
  const v = watchView();
  if (v.revoked) return <WatchProblemScreen kind="revoked" />;
  if (v.cloud && !dismissed) return <CloudMovedScreen cloud={v.cloud} onDismiss={dismiss} extra={stopButton} />;
  return children;
}
