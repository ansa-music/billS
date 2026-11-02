import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { TrialWatchStatus } from '@bills/domain';
import { useAuth } from '../auth.ts';
import { Icon } from '../icons.tsx';
import { QrCode } from '../QrCode.tsx';
import { Modal } from '../ui.tsx';
import { createWatchLink, revokeWatchLinks, watchAvailable, watchLinksStatus, watchUrl, WatchHttpError } from '../demo-hub/trial-watch.ts';
import { currentTrial, subscribeTrial, TRIAL, trialVersion } from '../demo-hub/trial-store.ts';
import './trial.css';

/**
 * «Смотреть с телефона» at the cash desk (VITE_TRIAL=1): the director gets a QR code with a watch
 * link — the phone opens TS read-only on the cash desk's latest data and signs in with the
 * director's own code. «Отключить телефоны» switches every link off. Opened from the trial details
 * («Пробная» → «Открыть на телефоне») and from the staff menu in the top bar; only the director
 * (role manager) or the owner sees it.
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

/** Opens the dialog (from anywhere: the trial details, the staff menu). */
export function openTrialWatch(): void {
  setOpen(true);
}

/** May the signed-in person watch from a phone here? The director or the owner of a trial with a cloud link. */
export function useCanWatchFromPhone(): boolean {
  useSyncExternalStore(subscribeTrial, trialVersion);
  const { roles } = useAuth();
  const info = TRIAL ? currentTrial() : null;
  return watchAvailable(info) && roles.some((r) => r === 'manager' || r === 'owner');
}

/** Mounted once (with the trial badge in the menu); the dialog goes to <body>, so a hidden menu does not hide it. */
export function TrialWatchHost() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  if (!isOpen || typeof document === 'undefined') return null;
  return createPortal(<TrialWatchDialog onClose={() => setOpen(false)} />, document.body);
}

/** The staff menu's line «Смотреть с телефона». */
export function TrialWatchMenuItem({ onPick }: { onPick: () => void }) {
  if (!useCanWatchFromPhone()) return null;
  return (
    <button
      type="button"
      className="btn btn-small btn-ghost actor-apps"
      onClick={() => {
        onPick();
        openTrialWatch();
      }}
    >
      <Icon name="tv" size={18} /> Смотреть с телефона
    </button>
  );
}

const time = (ms: number): string => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
};

function statusLine(status: TrialWatchStatus | null): string {
  if (!status) return '';
  if (status.watching) return 'Сейчас смотрят с телефона.';
  if (status.lastViewedAt !== null) return `Последний раз смотрели с телефона: ${time(status.lastViewedAt)}.`;
  return 'С телефона ещё не смотрели.';
}

const problemText = (err: unknown): string =>
  err instanceof WatchHttpError
    ? err.status === 0
      ? err.code === 'NOT_LINKED'
        ? err.message
        : 'Нет связи с TS. Проверьте интернет и попробуйте ещё раз.'
      : err.message
    : 'Не получилось. Попробуйте ещё раз.';

function TrialWatchDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [status, setStatus] = useState<TrialWatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const made = useRef(false);

  const makeLink = () => {
    const info = currentTrial();
    if (!info) return;
    setBusy(true);
    setError(null);
    setNote(null);
    createWatchLink(info)
      .then((l) => setLink(watchUrl(l.token)))
      .catch((err: unknown) => setError(problemText(err)))
      .finally(() => setBusy(false));
  };

  // One link per opening (StrictMode runs effects twice in development: the ref keeps it to one).
  useEffect(() => {
    if (made.current) return;
    made.current = true;
    makeLink();
  }, []);

  // While the dialog is open: has the phone opened it yet?
  useEffect(() => {
    let alive = true;
    const load = () => {
      const info = currentTrial();
      if (!info?.cloudId) return;
      watchLinksStatus(info)
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const revoke = () => {
    const info = currentTrial();
    if (!info) return;
    if (!window.confirm('Отключить все телефоны? Они перестанут видеть данные кассы. Новую ссылку можно сделать в любой момент.')) return;
    setBusy(true);
    setError(null);
    revokeWatchLinks(info)
      .then(() => {
        setLink(null);
        setStatus(null);
        setNote('Телефоны отключены: по старым ссылкам данные больше не открываются.');
      })
      .catch((err: unknown) => setError(problemText(err)))
      .finally(() => setBusy(false));
  };

  const copy = () => {
    if (!link) return;
    void (navigator.clipboard?.writeText(link) ?? Promise.reject(new Error('no clipboard')))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <Modal open title="Смотреть с телефона" onClose={onClose}>
      <div className="trial-watch">
        <p>Наведите камеру телефона на код — откроется TS только для просмотра. Войдите там своим кодом директора.</p>
        {link ? (
          <>
            <div className="trial-watch-qr">
              <QrCode value={link} size={232} label="QR-код: TS на телефоне, только просмотр" />
            </div>
            <div className="trial-watch-link">
              <input readOnly value={link} aria-label="Ссылка для телефона" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn-small" onClick={copy}>
                {copied ? 'Скопировано' : 'Скопировать'}
              </button>
            </div>
          </>
        ) : error ? (
          <p className="trial-watch-error" role="alert">
            {error}
          </p>
        ) : note ? (
          <p className="trial-watch-note">{note}</p>
        ) : (
          <p className="muted">Готовим ссылку…</p>
        )}
        <ul className="trial-watch-facts">
          <li>На телефоне видно то же, что здесь: продажи, отчёты, склад. Менять там ничего нельзя.</li>
          <li>Данные обновляются примерно раз в минуту, пока TS открыт на кассе и есть интернет.</li>
          <li>Ссылка — как ключ от кассы: не пересылайте её посторонним.</li>
        </ul>
        {status && link && <p className="trial-watch-status">{statusLine(status)}</p>}
        <div className="trial-details-actions">
          {!link && (error || note) && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={makeLink}>
              {error ? 'Попробовать ещё раз' : 'Новая ссылка'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={revoke}>
            Отключить телефоны
          </button>
        </div>
      </div>
    </Modal>
  );
}
