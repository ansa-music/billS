import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { Modal } from '../ui.tsx';
import { currentTrial, daysLeft, downloadBackup, subscribeTrial, TRIAL, trialEndsAt, trialOver, trialVersion } from '../demo-hub/trial-store.ts';

/**
 * Browser trial (VITE_TRIAL=1): a quiet line at the bottom of the menu — «Пробная · 12 дн.» —
 * instead of a strip over every page. A click opens the details: the end date, «Скачать копию»,
 * the manager's code and how to extend. Renders nothing in other builds.
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
  const over = trialOver(info);
  const left = daysLeft(info);
  const label = over ? 'Пробная завершена' : `Пробная · ${left} дн.`;
  return (
    <>
      <button
        type="button"
        className="trial-badge"
        data-place={place}
        data-over={over || undefined}
        title={over ? (info.message ?? 'Пробный период завершён') : `Пробная версия: осталось ${left} ${daysWord(left)}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="trial-badge-dot" aria-hidden="true" />
        <span className="trial-badge-text">{label}</span>
        <span className="trial-badge-short" aria-hidden="true">
          {over ? 'Пробная' : `${left} дн.`}
        </span>
      </button>
      {open && <TrialDetails onClose={() => setOpen(false)} />}
    </>
  );
}

function TrialDetails({ onClose }: { onClose: () => void }) {
  const info = currentTrial();
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);
  if (!info) return null;
  const over = trialOver(info);
  const left = daysLeft(info);
  const until = new Date(trialEndsAt(info)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <Modal open title="Пробная версия" onClose={onClose}>
      <div className="trial-details">
        {over ? (
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
        <p className="trial-details-foot">Продлить или подключить полную версию — напишите TS.</p>
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
