import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { Modal } from '../ui.tsx';
import type { TrialInfo } from '../demo-hub/trial-store.ts';
import {
  currentTrial,
  daysLeft,
  downloadBackup,
  PAID_NOTICE_MS,
  paidUntilText,
  subscribeTrial,
  TRIAL,
  trialEndsAt,
  trialOver,
  trialOverMessage,
  trialVersion,
} from '../demo-hub/trial-store.ts';
import { TrialCloudPanel } from './TrialCloud.tsx';

/** What the menu line says, or null when a permanent version has nothing to say. */
export function badgeLabel(info: Pick<TrialInfo, 'startedAt' | 'endsAt' | 'status' | 'plan' | 'paidUntil' | 'moved'>, now = Date.now()): { text: string; short: string; over: boolean } | null {
  const over = trialOver(info, now);
  if (info.moved) return { text: 'Открыта на другом устройстве', short: 'Перенесена', over: true };
  if (info.plan === 'paid') {
    if (over) return { text: 'Оплата закончилась', short: 'Оплата', over: true };
    const until = info.paidUntil ?? null;
    if (until !== null && until - now <= PAID_NOTICE_MS) return { text: `Оплачено до ${paidUntilText(until)}`, short: paidUntilText(until), over: false };
    return null;
  }
  if (over) return { text: 'Пробная завершена', short: 'Пробная', over: true };
  const left = daysLeft(info, now);
  return { text: `Пробная · ${left} дн.`, short: `${left} дн.`, over: false };
}

/**
 * Browser trial (VITE_TRIAL=1): a quiet line at the bottom of the menu — «Пробная · 12 дн.» —
 * instead of a strip over every page. A click opens the details: the end date, «Скачать копию»,
 * the cloud copy, transfer and phone link, the manager's code. A permanent version («paid») shows
 * nothing here except «Оплачено до 12 декабря» in its last 7 days (its details are in «Настройки»).
 * Renders nothing in other builds.
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
  const label = badgeLabel(info);
  if (!label) return null;
  const over = label.over;
  const left = daysLeft(info);
  return (
    <>
      <button
        type="button"
        className="trial-badge"
        data-place={place}
        data-over={over || undefined}
        data-plan={info.plan ?? 'trial'}
        title={over ? trialOverMessage(info) : info.plan === 'paid' ? label.text : `Пробная версия: осталось ${left} ${daysWord(left)}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="trial-badge-dot" aria-hidden="true" />
        <span className="trial-badge-text">{label.text}</span>
        <span className="trial-badge-short" aria-hidden="true">
          {label.short}
        </span>
      </button>
      {open && <TrialDetails onClose={() => setOpen(false)} />}
    </>
  );
}

export function TrialDetails({ onClose }: { onClose: () => void }) {
  const info = currentTrial();
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  if (!info) return null;
  const over = trialOver(info);
  const left = daysLeft(info);
  const paid = info.plan === 'paid';
  const until = new Date(trialEndsAt(info)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <Modal open title={paid ? 'TS в браузере' : 'Пробная версия'} onClose={onClose}>
      <div className="trial-details">
        {over ? (
          <p className="trial-details-state" data-over="">
            {trialOverMessage(info)}
          </p>
        ) : paid ? (
          <p className="trial-details-state">
            {info.paidUntil ? (
              <>
                Оплачено до <strong>{paidUntilText(info.paidUntil)}</strong>.
              </>
            ) : (
              'Постоянная версия: работает без ограничения срока.'
            )}
          </p>
        ) : (
          <p className="trial-details-state">
            Осталось <strong>{left} {daysWord(left)}</strong> — до {until}.
          </p>
        )}
        <p className="muted">
          {info.localOnly
            ? 'Это копия данных для просмотра: она хранится только в этом браузере и не связана с TS.'
            : 'Данные хранятся в этом браузере, а копия — в облаке TS. Файл копии можно скачать и себе.'}
        </p>
        <TrialCloudPanel />
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
              {info.managerName}: <code>{info.managerKey}</code>
            </p>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (window.confirm('Показать код управляющего? Убедитесь, что экран не видят посторонние.')) setShowKey(true);
              }}
            >
              Код управляющего
            </button>
          )}
        </div>
        <p className="trial-details-foot">{paid ? 'Оплата и вопросы — напишите TS.' : 'Продлить или подключить полную версию — напишите TS.'}</p>
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
