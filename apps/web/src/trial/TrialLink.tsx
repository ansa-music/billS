import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { LinkView } from '@bills/domain';
import { linkHash } from '@bills/domain';
import { useAuth } from '../auth.ts';
import { Icon } from '../icons.tsx';
import { QrCode } from '../QrCode.tsx';
import { Modal } from '../ui.tsx';
import type { LinkDeviceView } from '../demo-hub/link-control.ts';
import { linkHostApi, linkHostState, linkHostVersion, subscribeLinkHost } from '../demo-hub/link-control.ts';
import { TRIAL } from '../demo-hub/trial-store.ts';
import { openTrialWatch, useCanWatchFromPhone } from './TrialWatch.tsx';
import { watchTime } from './WatchBanner.tsx';
import './trial.css';

/**
 * «Подключить устройство» at the cash desk (VITE_TRIAL=1): a QR code and a link for a phone or tablet of the
 * staff (or the order board on a TV), the devices that are or were connected, and «Отключить все устройства».
 * The devices work through this tab: requests and live updates go to its in-page HUB (demo-hub/link-host.ts).
 * Only the director (manager), «Управляющий» (admin) or the owner opens it.
 */

let open = false;
const listeners = new Set<() => void>();
const setOpen = (value: boolean) => {
  open = value;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function openTrialLink(): void {
  setOpen(true);
}

/** May the signed-in person connect devices here? A cash desk that can take them, and the director, «Управляющий» or the owner. */
export function useCanLinkDevices(): boolean {
  useSyncExternalStore(subscribeLinkHost, linkHostVersion);
  const { roles } = useAuth();
  return TRIAL && linkHostApi() !== null && roles.some((r) => r === 'manager' || r === 'admin' || r === 'owner');
}

/** Mounted once (with the trial badge); the dialog goes to <body>. */
export function TrialLinkHost() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  if (!isOpen || typeof document === 'undefined') return null;
  return createPortal(<TrialLinkDialog onClose={() => setOpen(false)} />, document.body);
}

/** The staff menu's line «Подключить устройство». */
export function TrialLinkMenuItem({ onPick }: { onPick: () => void }) {
  if (!useCanLinkDevices()) return null;
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost actor-apps"
      onClick={() => {
        onPick();
        openTrialLink();
      }}
    >
      <Icon name="plug" size={18} /> Подключить устройство
    </button>
  );
}

function deviceState(d: LinkDeviceView): string {
  if (d.online) return d.direct ? 'на связи — напрямую по Wi-Fi' : 'на связи — через интернет';
  return `последний раз: ${watchTime(d.lastSeen)}`;
}

function DeviceList({ devices }: { devices: LinkDeviceView[] }) {
  if (devices.length === 0) return <p className="muted">Подключённых устройств пока нет.</p>;
  return (
    <ul className="link-devices">
      {devices.map((d) => (
        <li key={d.id} data-online={d.online || undefined}>
          <span className="link-dot" aria-hidden="true" />
          <span className="link-device-name">
            {d.view === 'board' ? 'Экран заказов' : d.name}
            {d.view === 'board' ? <span className="muted"> · {d.name}</span> : d.who ? <span className="muted"> · {d.who}</span> : null}
          </span>
          <span className="link-device-state">{deviceState(d)}</span>
        </li>
      ))}
    </ul>
  );
}

function TrialLinkDialog({ onClose }: { onClose: () => void }) {
  useSyncExternalStore(subscribeLinkHost, linkHostVersion);
  const state = linkHostState();
  const canWatch = useCanWatchFromPhone();
  const [secret, setSecret] = useState<string | null>(state.secret);
  const [view, setView] = useState<LinkView>('staff');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const asked = useRef(false);

  // The link is made the first time the dialog opens (StrictMode runs effects twice: the ref keeps it to one).
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    const api = linkHostApi();
    if (!api) {
      setError('На этой кассе подключить устройства нельзя.');
      return;
    }
    api
      .enable()
      .then(setSecret)
      .catch(() => setError('Не получилось подготовить ссылку. Обновите страницу и попробуйте ещё раз.'));
  }, []);

  useEffect(() => setCopied(false), [view, secret]);

  const url = secret ? `${window.location.origin}${window.location.pathname}${linkHash(secret, view)}` : null;

  const copy = () => {
    if (!url) return;
    void (navigator.clipboard?.writeText(url) ?? Promise.reject(new Error('no clipboard')))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  const rotate = () => {
    const api = linkHostApi();
    if (!api) return;
    if (!window.confirm('Отключить все устройства? Телефоны и планшеты сразу перестанут работать с кассой. Чтобы подключить их снова, понадобится новый QR-код.')) return;
    setBusy(true);
    setError(null);
    api
      .rotate()
      .then((next) => {
        setSecret(next);
        setNote('Все устройства отключены. Ниже новый QR-код — старые ссылки больше не работают.');
      })
      .catch(() => setError('Не получилось. Попробуйте ещё раз.'))
      .finally(() => setBusy(false));
  };

  return (
    <Modal open title="Подключить устройство" onClose={onClose}>
      <div className="trial-watch trial-link">
        <p>Телефоны и планшеты сотрудников работают вместе с этой кассой: заказы, бариста, экран заказов. Ничего устанавливать не нужно.</p>
        <div className="link-views" role="radiogroup" aria-label="Что откроется на устройстве">
          <button type="button" role="radio" aria-checked={view === 'staff'} className="btn btn-small" data-on={view === 'staff' || undefined} onClick={() => setView('staff')}>
            Для сотрудника
          </button>
          <button type="button" role="radio" aria-checked={view === 'board'} className="btn btn-small" data-on={view === 'board' || undefined} onClick={() => setView('board')}>
            <Icon name="tv" size={16} /> Экран заказов
          </button>
        </div>
        {note && <p className="trial-watch-note">{note}</p>}
        {url ? (
          <>
            <div className="trial-watch-qr">
              <QrCode value={url} size={232} label={view === 'board' ? 'QR-код: экран заказов на телевизоре или планшете' : 'QR-код: TS на телефоне или планшете сотрудника'} />
            </div>
            <p className="muted">
              {view === 'board'
                ? 'Откройте код на телевизоре или планшете над стойкой — появится экран заказов, входить не нужно.'
                : 'Наведите камеру телефона на код (или отправьте ссылку сотруднику) — откроется TS. Каждый входит своим кодом и видит то, что разрешено его роли.'}
            </p>
            <div className="trial-watch-link">
              <input readOnly value={url} aria-label="Ссылка для устройства" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn-small" onClick={copy}>
                {copied ? 'Скопировано' : 'Скопировать'}
              </button>
            </div>
          </>
        ) : error ? (
          <p className="trial-watch-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Готовим ссылку…</p>
        )}
        {secret && !state.connected && <p className="trial-watch-note">Касса подключается к интернету… Устройства смогут подключиться, как только связь появится.</p>}
        <h3 className="link-devices-title">Устройства</h3>
        <DeviceList devices={state.devices} />
        <ul className="trial-watch-facts">
          <li>Не закрывайте TS на кассе: устройства работают через неё. Закроете — на них появится «Касса не отвечает», а когда TS снова откроется, они подключатся сами.</li>
          <li>Ссылка — как ключ от кассы: не пересылайте её посторонним. Войти всё равно можно только своим кодом.</li>
        </ul>
        {canWatch && (
          <div className="trial-details-watch">
            <p className="muted">Только посмотреть продажи с телефона, даже когда касса закрыта (данные до минуты назад):</p>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                onClose();
                openTrialWatch();
              }}
            >
              Смотреть с телефона
            </button>
          </div>
        )}
        <div className="trial-details-actions">
          <button type="button" className="btn btn-ghost" disabled={busy || !secret} onClick={rotate}>
            {busy ? 'Отключаем…' : 'Отключить все устройства'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
