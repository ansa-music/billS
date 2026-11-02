import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { formatCafeCode, TRIAL_MOVED_MESSAGE, trialWaiting } from '@bills/domain';
import { useAuth } from '../auth.ts';
import { Modal } from '../ui.tsx';
import type { ForcedCopy } from '../demo-hub/trial-move.ts';
import { deskMoveApi, MOVE_AVAILABLE, MoveHttpError, trialMovedAway } from '../demo-hub/trial-move.ts';
import { currentTrial, downloadBackup, subscribeTrial, TRIAL, trialVersion } from '../demo-hub/trial-store.ts';
import { TrialCloudBanner } from './TrialCloud.tsx';
import './trial.css';
import './trial-move.css';

/**
 * The cash desk's side of «У меня уже есть TS — войти» (VITE_TRIAL=1; demo-hub/trial-move.ts):
 *  - in the trial details, for the director, «Управляющий» or the owner: «Код кофейни» (shown after a
 *    confirmation, «Сменить код») and «Перенести кассу на другой компьютер» — a fresh copy goes up at once,
 *    then the code and the steps;
 *  - on a cash desk another computer took over: «Касса перенесена на другой компьютер», read-only, with
 *    «Скачать копию» (anything done here off line) and «Вернуть кассу сюда».
 */

// The move itself is only needed on a desk that was moved away: loaded when it is opened.
const TrialMoveIn = lazy(() => import('./TrialSignIn.tsx').then((m) => ({ default: m.TrialMoveIn })));

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

export function openTrialMoveOut(): void {
  setOpen(true);
}

function useTrial() {
  useSyncExternalStore(subscribeTrial, trialVersion);
  return TRIAL ? currentTrial() : null;
}

/** May the signed-in person see the café code and move the cash desk? The director, «Управляющий» or the owner. */
function useCanMove(): boolean {
  const info = useTrial();
  const { roles } = useAuth();
  return Boolean(
    info &&
      !info.localOnly &&
      !trialMovedAway(info) &&
      !info.cloud &&
      !trialWaiting(info.status) &&
      MOVE_AVAILABLE &&
      roles.some((r) => r === 'manager' || r === 'admin' || r === 'owner'),
  );
}

function moveTime(ms: number): string {
  const d = new Date(ms);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

const errorText = (err: unknown): string =>
  err instanceof MoveHttpError && err.status === 429 ? 'Код меняли слишком часто. Попробуйте через час.' : 'Не получилось: нет связи с TS. Проверьте интернет и попробуйте ещё раз.';

/** «Код кофейни» in the trial details (TrialBadge.tsx). */
export function TrialCafeCodeSection({ onClose }: { onClose: () => void }) {
  const info = useTrial();
  const canMove = useCanMove();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!info || !canMove) return null;
  const code = info.cafeCode ?? null;

  const change = (first: boolean) => {
    const api = deskMoveApi();
    if (!api) return;
    if (!first && !window.confirm('Сменить код кофейни? Старый код перестанет работать — запишите новый.')) return;
    setBusy(true);
    setError(null);
    api
      .changeCode()
      .then(() => setShow(true))
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="trial-details-watch trial-cafe-code">
      <p className="muted">
        <strong>Код кофейни</strong> — чтобы перенести кассу на другой компьютер. Это как пароль: не показывайте его посторонним.
      </p>
      {code ? (
        show ? (
          <p className="trial-details-key">
            Код кофейни: <code>{formatCafeCode(code)}</code>
          </p>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              if (window.confirm('Показать код кофейни? Убедитесь, что экран не видят посторонние.')) setShow(true);
            }}
          >
            Показать код кофейни
          </button>
        )
      ) : (
        <>
          <p className="muted">Код появится, когда касса свяжется с TS (нужен интернет).</p>
          {info.cloudId && (
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => change(true)}>
              Получить код сейчас
            </button>
          )}
        </>
      )}
      {error && (
        <p className="trial-watch-error" role="alert">
          {error}
        </p>
      )}
      <div className="trial-details-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            onClose();
            openTrialMoveOut();
          }}
        >
          Перенести кассу на другой компьютер
        </button>
        {code && show && (
          <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => change(false)}>
            Сменить код
          </button>
        )}
      </div>
    </div>
  );
}

/** Mounted once with the trial badge; the dialog goes to <body>. */
export function TrialMoveHost() {
  const isOpen = useSyncExternalStore(subscribe, () => open);
  if (!isOpen || typeof document === 'undefined') return null;
  return createPortal(<TrialMoveOutDialog onClose={() => setOpen(false)} />, document.body);
}

/** «Перенести кассу на другой компьютер» on the old cash desk: a fresh copy now, then the code and the steps. */
function TrialMoveOutDialog({ onClose }: { onClose: () => void }) {
  const info = useTrial();
  const [copy, setCopy] = useState<ForcedCopy | 'sending'>('sending');
  const [codeBusy, setCodeBusy] = useState(false);
  const asked = useRef(false);
  const send = () => {
    const api = deskMoveApi();
    if (!api) {
      setCopy('failed');
      return;
    }
    setCopy('sending');
    api
      .sendCopyNow()
      .then(setCopy)
      .catch(() => setCopy('failed'));
  };
  // Once per opening (StrictMode runs effects twice).
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    send();
  }, []);
  if (!info) return null;
  const code = info.cafeCode ?? null;
  const site = `${window.location.host}${window.location.pathname}`.replace(/\/$/, '');

  return (
    <Modal open title="Перенести кассу на другой компьютер" onClose={onClose}>
      <div className="trial-watch trial-move-out">
        <ol className="trial-move-steps">
          <li aria-live="polite">
            {copy === 'sending' && 'Отправляем свежие данные кассы в TS…'}
            {copy === 'sent' && info.snapshotAt !== undefined && (
              <>
                <strong>Данные на {moveTime(info.snapshotAt)} отправлены.</strong> Они и перейдут на новый компьютер.
              </>
            )}
            {copy === 'too-big' && (
              <span className="trial-watch-error">
                Данных кассы слишком много для переноса через TS. Нажмите здесь «Скачать копию», а на новом компьютере — «Восстановить из копии».
              </span>
            )}
            {copy === 'failed' && (
              <>
                <span className="trial-watch-error">Не получилось отправить данные: нет связи с TS. Проверьте интернет.</span>{' '}
                <button type="button" className="btn btn-small" onClick={send}>
                  Отправить ещё раз
                </button>
              </>
            )}
          </li>
          <li>
            На новом компьютере откройте <strong>{site}</strong> и нажмите <strong>«У меня уже есть TS — войти»</strong> →{' '}
            <strong>«Перенести кассу на этот компьютер»</strong>.
          </li>
          <li>
            Введите код кофейни:{' '}
            {code ? (
              <code className="trial-move-code">{formatCafeCode(code)}</code>
            ) : (
              <>
                <span className="muted">код ещё не получен.</span>{' '}
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={codeBusy}
                  onClick={() => {
                    setCodeBusy(true);
                    void deskMoveApi()
                      ?.changeCode()
                      .catch(() => undefined)
                      .finally(() => setCodeBusy(false));
                  }}
                >
                  Получить код
                </button>
              </>
            )}
          </li>
          <li>Войдите своим кодом — тем же, что здесь.</li>
        </ol>
        <p className="trial-watch-note">
          После переноса этот компьютер перестанет принимать заказы — касса будет на новом. Пока TS здесь открыт, новый компьютер сам попросит самые свежие данные.
        </p>
        <div className="trial-details-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Понятно
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One line for the trial details of a moved desk. */
export function TrialMovedState() {
  return (
    <p className="trial-details-state" data-over="">
      {TRIAL_MOVED_MESSAGE}
    </p>
  );
}

/**
 * «Касса перенесена на другой компьютер» on the old cash desk — on the sign-in screen (App.tsx) and over the
 * pages (license.tsx, in place of the read-only strip). A cash desk that moved to the cloud gets
 * «Касса переехала в облако» instead (TrialCloud.tsx). Nothing on a desk that was not moved.
 */
export function TrialMovedBanner() {
  const info = useTrial();
  const [back, setBack] = useState(false);
  const [busy, setBusy] = useState(false);
  if (info?.cloud) return <TrialCloudBanner />;
  if (!info || !trialMovedAway(info)) return null;
  return (
    <div className="license-banner trial-moved-banner" data-tone="danger" role="alert">
      <div className="license-banner-text">
        <p>
          <strong>Касса перенесена на другой компьютер.</strong> Здесь можно только смотреть данные — заказы теперь принимает новая касса.
        </p>
        {info.movedUnsynced && (
          <p>Здесь есть изменения, которых нет на новой кассе (сделаны без интернета или в последние минуты). Скачайте копию, чтобы их не потерять.</p>
        )}
        <p className="trial-moved-hint">
          Работать здесь вместе с новой кассой: на ней «Пробная» → «Подключить устройство» → «Скопировать ссылку», и откройте ссылку на этом компьютере.
        </p>
        <div className="trial-moved-actions">
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
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setBack(true)}>
            Вернуть кассу сюда
          </button>
        </div>
      </div>
      {back && (
        <Modal open title="Вернуть кассу на этот компьютер" onClose={() => setBack(false)}>
          <Suspense fallback={<p className="muted">Загрузка…</p>}>
            <TrialMoveIn replacing onDone={() => window.location.reload()} />
          </Suspense>
        </Modal>
      )}
    </div>
  );
}
