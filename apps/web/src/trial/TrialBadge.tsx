import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { Modal } from '../ui.tsx';
import { currentTrial, daysLeft, downloadBackup, subscribeTrial, TRIAL, trialEndsAt, trialOver, trialPermanent, trialVersion } from '../demo-hub/trial-store.ts';
import { openTrialWatch, TrialWatchHost, useCanWatchFromPhone } from './TrialWatch.tsx';
import { openTrialLink, TrialLinkHost, useCanLinkDevices } from './TrialLink.tsx';
import { trialMovedAway } from '../demo-hub/trial-move.ts';
import { TrialCafeCodeSection, TrialMovedState, TrialMoveHost } from './TrialMove.tsx';

/**
 * Browser trial (VITE_TRIAL=1): a quiet line at the bottom of the menu — «Пробная · 12 дн.», or
 * «Полная версия» once TS made it permanent — instead of a strip over every page. A click opens the
 * details: the end date (none for the full version), «Скачать копию», the director's code (role manager,
 * «Директор» in a coffee shop), devices, «Открыть на телефоне» and how to extend. Renders nothing in other builds.
 */
export function TrialBadge({ place = 'sidebar' }: { place?: 'sidebar' | 'sheet' }) {
  useSyncExternalStore(subscribeTrial, trialVersion);
  // Days left change with the clock, not only with the cloud's answers.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 10 * 60_000);
    return () => clearInterval(t);
  }, []);
  const [open, setOpen] = useState(false);
  const info = TRIAL ? currentTrial() : null;
  if (!info) return null;
  const full = trialPermanent(info);
  // «Касса перенесена на другой компьютер» (TrialMove.tsx): read-only like a finished trial, whatever its status.
  const moved = trialMovedAway(info);
  const over = moved || (!full && trialOver(info));
  const left = daysLeft(info);
  const label = moved ? 'Касса перенесена' : full ? 'Полная версия' : over ? 'Пробная завершена' : `Пробная · ${left} дн.`;
  const title = moved
    ? 'Касса перенесена на другой компьютер'
    : full
      ? 'Полная версия TS — без срока'
      : over
        ? (info.message ?? 'Пробный период завершён')
        : `Пробная версия: осталось ${left} ${daysWord(left)}`;
  return (
    <>
      <button
        type="button"
        className="trial-badge"
        data-place={place}
        data-over={over || undefined}
        data-full={(full && !moved) || undefined}
        title={title}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="trial-badge-dot" aria-hidden="true" />
        <span className="trial-badge-text">{label}</span>
        <span className="trial-badge-short" aria-hidden="true">
          {moved ? 'Перенесена' : full ? 'TS' : over ? 'Пробная' : `${left} дн.`}
        </span>
      </button>
      {open && <TrialDetails onClose={() => setOpen(false)} />}
      {place === 'sidebar' && (
        <>
          <TrialWatchHost />
          <TrialLinkHost />
          <TrialMoveHost />
        </>
      )}
    </>
  );
}

function TrialDetails({ onClose }: { onClose: () => void }) {
  const info = currentTrial();
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const canWatch = useCanWatchFromPhone();
  const canLink = useCanLinkDevices();
  if (!info) return null;
  const full = trialPermanent(info);
  const moved = trialMovedAway(info);
  const over = !full && trialOver(info);
  const left = daysLeft(info);
  const until = new Date(trialEndsAt(info)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <Modal open title={full ? 'Полная версия' : 'Пробная версия'} onClose={onClose}>
      <div className="trial-details">
        {moved ? (
          <TrialMovedState />
        ) : full ? (
          <p className="trial-details-state">
            <strong>Полная версия TS</strong> — без срока: касса работает, ничего продлевать не нужно.
          </p>
        ) : over ? (
          <p className="trial-details-state" data-over="">
            {info.message ?? 'Пробный период завершён: данные можно смотреть и скачать, новые заказы недоступны.'}
          </p>
        ) : (
          <p className="trial-details-state">
            Осталось <strong>{left} {daysWord(left)}</strong> — до {until}.
          </p>
        )}
        <p className="muted">
          {info.localOnly
            ? 'Это копия данных для просмотра: она хранится только в этом браузере и не связана с TS.'
            : 'Данные хранятся в этом браузере. Раз в несколько дней скачивайте копию.'}
        </p>
        <div className="trial-details-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void downloadBackup().finally(() => setBusy(false));
            }}
          >
            Скачать копию
          </button>
          {showKey ? (
            <p className="trial-details-key">
              {info.managerName}: {info.managerKey ? <code>{info.managerKey}</code> : 'тот же код, что был на старом компьютере'}
            </p>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (window.confirm('Показать код директора? Убедитесь, что экран не видят посторонние.')) setShowKey(true);
              }}
            >
              Код директора
            </button>
          )}
        </div>
        <TrialCafeCodeSection onClose={onClose} />
        {canLink && !moved && (
          <div className="trial-details-watch">
            <p className="muted">Телефоны и планшеты сотрудников, экран заказов на телевизоре — работают вместе с этой кассой.</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                onClose();
                openTrialLink();
              }}
            >
              Подключить устройство
            </button>
          </div>
        )}
        {canWatch && !moved && (
          <div className="trial-details-watch">
            <p className="muted">Смотреть, что происходит на кассе, можно и с телефона — одновременно с кассой.</p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                onClose();
                openTrialWatch();
              }}
            >
              Открыть на телефоне
            </button>
          </div>
        )}
        <p className="trial-details-foot">{full ? 'Вопросы и помощь — напишите TS.' : 'Продлить или подключить полную версию — напишите TS.'}</p>
      </div>
    </Modal>
  );
}

export function daysWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'день';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'дня';
  return 'дней';
}
