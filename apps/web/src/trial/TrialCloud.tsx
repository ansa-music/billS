import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { TrialCloudInfo } from '@bills/domain';
import { formatCafeCode } from '@bills/domain';
import { BrandMark } from '../BrandMark.tsx';
import type { TrialInfo } from '../demo-hub/trial-store.ts';
import { currentTrial, downloadBackup, persistTrial, subscribeTrial, TRIAL, trialVersion } from '../demo-hub/trial-store.ts';
import '../onboarding/onboarding.css';
import './trial.css';

/**
 * «Облачная касса» on the trial page (VITE_TRIAL=1; demo-hub/trial-cloud.ts keeps TrialInfo.cloud):
 *  - the old browser cash desk: «Касса переехала в облако» full screen — «Открыть кассу», the café code,
 *    «Скачать копию», «Посмотреть старые данные» (then the read-only cash desk with TrialCloudBanner);
 *  - a request approved straight into the cloud: «Ваша касса готова — она в облаке» with the director's key once;
 *  - devices («Подключить устройство») and watching phones: the same screen without the download.
 * Light (no HUB): LinkBanner.tsx and WatchBanner.tsx import it.
 */

/** Words for an action refused on the old cash desk (license.tsx). */
export const TRIAL_CLOUD_READ_ONLY = 'Касса переехала в облако: здесь можно только смотреть старые данные. Работайте в облачной кассе.';

// «Посмотреть старые данные»: the big screen steps aside for this tab (it comes back after a reload).
let dismissed = false;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const setDismissed = (value: boolean) => {
  dismissed = value;
  for (const l of listeners) l();
};

/** Has the person stepped past «Касса переехала в облако» in this tab? And how to do it. */
export function useCloudScreenDismissed(): [boolean, () => void] {
  const value = useSyncExternalStore(subscribe, () => dismissed);
  return [value, () => setDismissed(true)];
}

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost"
      onClick={() => {
        void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('no clipboard'))).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}
    </button>
  );
}

/** The link (or, without one yet, where to get it) and the café code, big. */
function CloudWay({ cloud }: { cloud: Pick<TrialCloudInfo, 'code' | 'url'> }) {
  return (
    <>
      {cloud.url ? (
        <div className="trial-cloud-open">
          <a className="btn btn-primary btn-large" href={cloud.url} target="_blank" rel="noopener noreferrer">
            Открыть кассу
          </a>
          <p className="trial-cloud-url">
            <span className="muted">{cloud.url}</span> <CopyLink url={cloud.url} />
          </p>
        </div>
      ) : (
        <p className="onboarding-note">Ссылку на облачную кассу пришлёт TS.</p>
      )}
      <p className="trial-cloud-code-line">
        <span className="muted">Код кофейни</span>
        <code className="trial-cloud-code">{formatCafeCode(cloud.code)}</code>
      </p>
    </>
  );
}

/**
 * «Касса переехала в облако — теперь она работает на любом телефоне и компьютере»: the old cash desk (with
 * «Скачать копию» and «Посмотреть старые данные»), a device or a watching phone (without the download).
 */
export function CloudMovedScreen({
  cloud,
  onDownload,
  onDismiss,
  extra,
}: {
  cloud: Pick<TrialCloudInfo, 'code' | 'url'>;
  onDownload?: () => Promise<void>;
  onDismiss?: () => void;
  extra?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <section className="page onboarding trial-welcome trial-cloud">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Касса переехала в облако</h1>
          <p className="page-lead">Теперь она работает на любом телефоне и компьютере.</p>
        </div>
      </header>
      <div className="onboarding-card trial-cloud-card">
        <CloudWay cloud={cloud} />
        <p className="onboarding-note">На каждом телефоне и компьютере откройте ссылку и войдите своим кодом — тем же, что здесь.</p>
        {onDownload && <p className="onboarding-note">Здесь касса больше не принимает заказы: старые данные можно посмотреть и скачать.</p>}
        {(onDownload || onDismiss || extra) && (
          <div className="trial-cloud-actions">
            {onDownload && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onDownload().finally(() => setBusy(false));
                }}
              >
                Скачать копию
              </button>
            )}
            {onDismiss && (
              <button type="button" className="btn btn-ghost" onClick={onDismiss}>
                Посмотреть старые данные
              </button>
            )}
            {extra}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * «Ваша касса готова — она в облаке»: a request TS approved straight into the cloud. The director's key big until
 * «Я записал(а) код», later behind «Показать код директора». The café in this browser was only the welcome form.
 */
export function TrialCloudReady({ info }: { info: TrialInfo }) {
  const cloud = info.cloud!;
  const [show, setShow] = useState(false);
  const key = cloud.managerKey ?? null;
  const bigKey = key !== null && !cloud.keySeen;
  return (
    <section className="page onboarding trial-welcome trial-cloud">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Ваша касса готова — она в облаке</h1>
          <p className="page-lead">TS подтвердил заявку «{info.venue}». Касса работает на любом телефоне и компьютере.</p>
        </div>
      </header>
      <div className="onboarding-card trial-cloud-card">
        <CloudWay cloud={cloud} />
        {bigKey ? (
          <div className="trial-cloud-key">
            <p>Ваш код входа (директор):</p>
            <p className="trial-key" aria-label={`Код входа ${key.split('').join(' ')}`}>
              {key.slice(0, 3)} {key.slice(3)}
            </p>
            <p className="onboarding-note">Запишите его. Код спросят при входе в кассу. Сотрудников добавите в «Сотрудники» — каждый получит свой код.</p>
            <button type="button" className="btn" onClick={() => void persistTrial({ cloud: { ...cloud, keySeen: true } })}>
              Я записал(а) код
            </button>
          </div>
        ) : key !== null ? (
          show ? (
            <p className="trial-details-key">
              Код директора: <code>{key}</code>
            </p>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (window.confirm('Показать код директора? Убедитесь, что экран не видят посторонние.')) setShow(true);
              }}
            >
              Показать код директора
            </button>
          )
        ) : (
          <p className="onboarding-note">Код входа директора — у TS. Если его у вас нет, напишите TS.</p>
        )}
        <ol className="trial-next">
          <li>Откройте ссылку — на компьютере у кассы, на телефонах и планшетах.</li>
          <li>Войдите кодом директора.</li>
          <li>«Смена» → «Открыть смену» и принимайте заказы.</li>
        </ol>
        <p className="onboarding-note">
          {info.withMenu === false ? 'Название кофейни перенесено в облачную кассу.' : 'Название и меню перенесены в облачную кассу.'} В этом браузере больше ничего
          делать не нужно.
        </p>
      </div>
    </section>
  );
}

/** Over the read-only old cash desk after «Посмотреть старые данные» (license.tsx, the sign-in screen). */
export function TrialCloudBanner() {
  useSyncExternalStore(subscribeTrial, trialVersion);
  const [busy, setBusy] = useState(false);
  const info = TRIAL ? currentTrial() : null;
  const cloud = info?.cloud;
  if (!cloud) return null;
  return (
    <div className="license-banner trial-moved-banner trial-cloud-banner" data-tone="warn" role="status">
      <div className="license-banner-text">
        <p>
          <strong>Касса переехала в облако</strong> — теперь она работает на любом телефоне и компьютере. Здесь можно только смотреть старые данные.
        </p>
        <div className="trial-moved-actions">
          {cloud.url && (
            <a className="btn btn-small btn-primary" href={cloud.url} target="_blank" rel="noopener noreferrer">
              Открыть кассу
            </a>
          )}
          <span className="trial-cloud-banner-code">
            Код кофейни <code>{formatCafeCode(cloud.code)}</code>
          </span>
          <button
            type="button"
            className="btn btn-small"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void downloadBackup().finally(() => setBusy(false));
            }}
          >
            Скачать копию
          </button>
        </div>
      </div>
    </div>
  );
}

/** One block for the trial details («В облаке»): the link and the code. */
export function TrialCloudState({ cloud }: { cloud: Pick<TrialCloudInfo, 'code' | 'url'> }) {
  return (
    <div className="trial-details-state trial-cloud-state">
      <p>
        <strong>Касса переехала в облако</strong> — теперь она работает на любом телефоне и компьютере.
      </p>
      <p>
        Код кофейни: <code>{formatCafeCode(cloud.code)}</code>
      </p>
      {cloud.url && (
        <a className="btn btn-primary" href={cloud.url} target="_blank" rel="noopener noreferrer">
          Открыть кассу
        </a>
      )}
    </div>
  );
}
