import { useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { formatTransferCode, normalizeTransferCode } from '@bills/domain';
import type { TrialTransferCode } from '@bills/domain';
import { readAuth } from '../auth.ts';
import { QrCode } from '../QrCode.tsx';
import { currentTrial, subscribeTrial, trialActions, trialOver, trialVersion } from '../demo-hub/trial-store.ts';

/**
 * «Постоянная работа в браузере»: what the cloud keeps of this coffee shop — the copy (and how
 * fresh it is), the transfer to another device and the owner's phone link. Shown in the trial
 * details (the menu badge) and in «Настройки → Облако и перенос». Transfer and the phone link are
 * the manager's: other roles see only the copy line.
 */

/** Where the owner's phone page lives (apps/cloud-web, #/v/<token>). */
export const CABINET_URL = (String(import.meta.env.VITE_CABINET_URL ?? '').trim() || 'https://ts-cabinet.pages.dev').replace(/\/+$/, '');

export function phoneLink(token: string): string {
  return `${CABINET_URL}/#/v/${token}`;
}

/** This page with the code in the address: a tablet that scans the QR opens «Открыть по коду переноса» filled in. */
export function transferLink(code: string): string {
  const raw = normalizeTransferCode(code) ?? code;
  return `${window.location.origin}${window.location.pathname}#transfer=${raw}`;
}

/** «только что» / «5 минут назад» / «2 часа назад» / «3 дня назад». */
export function agoText(at: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')} назад`;
  const days = Math.floor(hours / 24);
  return `${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return one;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
  return many;
}

function isManager(): boolean {
  const roles = readAuth()?.staff.roles ?? [];
  return roles.includes('manager') || roles.includes('owner');
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Не получилось. Проверьте интернет и попробуйте ещё раз.';
}

function CopyLine({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="trial-copy-line">
      <input ref={ref} type="text" readOnly value={value} aria-label={label} onFocus={(e) => e.target.select()} />
      <button
        type="button"
        className="btn btn-small"
        onClick={() => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            } catch {
              ref.current?.focus();
              ref.current?.select();
            }
          })();
        }}
      >
        {copied ? 'Скопировано' : 'Скопировать'}
      </button>
    </div>
  );
}

export function TrialCloudPanel() {
  useSyncExternalStore(subscribeTrial, trialVersion);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  const info = currentTrial();
  const actions = trialActions();
  const manager = isManager();
  const [transfer, setTransfer] = useState<TrialTransferCode | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!info) return null;
  const over = trialOver(info);
  const copyAt = info.cloudSnapshotAt ?? null;

  const act = (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    void fn()
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(null));
  };

  return (
    <div className="trial-cloud">
      <p className="trial-cloud-copy" data-testid="cloud-copy">
        {info.localOnly ? (
          'Это копия для просмотра: в облако она не отправляется.'
        ) : copyAt ? (
          <>
            Копия в облаке: <strong>{agoText(copyAt)}</strong>
          </>
        ) : actions ? (
          'Копия в облаке: ещё не было — появится в течение нескольких минут при интернете.'
        ) : (
          'Копия в облаке: нет связи с облаком TS.'
        )}
      </p>
      {info.snapshotTooBig && <p className="muted">Данных стало слишком много для облака — раз в несколько дней нажимайте «Скачать копию».</p>}

      {manager && actions && !over && (
        <>
          <section className="trial-cloud-block" aria-labelledby="trial-transfer-title">
            <h3 id="trial-transfer-title">Перенести на другое устройство</h3>
            {transfer ? (
              <div className="trial-transfer">
                <p className="trial-transfer-code" data-testid="transfer-code" aria-label={`Код переноса ${transfer.code.split('').join(' ')}`}>
                  {formatTransferCode(normalizeTransferCode(transfer.code) ?? transfer.code)}
                </p>
                <QrCode value={transferLink(transfer.code)} size={168} label="QR-код для переноса" />
                <p className="muted">
                  На новом устройстве откройте эту же страницу и нажмите «Открыть по коду переноса» (или наведите камеру на QR). Код действует
                  до {new Date(transfer.expiresAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.
                </p>
                <p className="trial-warn">После переноса здесь можно будет только смотреть данные — заказы будут на новом устройстве.</p>
              </div>
            ) : (
              <>
                <p className="muted">Касса работает на одном устройстве. Код переносит все данные на новый компьютер или планшет.</p>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    act('transfer', async () => {
                      setTransfer(await actions.transferCode());
                    })
                  }
                >
                  {busy === 'transfer' ? 'Отправляем копию…' : 'Получить код переноса'}
                </button>
              </>
            )}
          </section>

          <section className="trial-cloud-block" aria-labelledby="trial-phone-title">
            <h3 id="trial-phone-title">Смотреть выручку с телефона</h3>
            {info.viewToken ? (
              <div className="trial-phone">
                <QrCode value={phoneLink(info.viewToken)} size={168} label="QR-код ссылки для телефона" />
                <p className="muted">Наведите камеру телефона на QR или отправьте себе ссылку. По ней видно выручку и чеки — без входа, только просмотр.</p>
                <CopyLine value={phoneLink(info.viewToken)} label="Ссылка для телефона" />
                <div className="row wrap">
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!window.confirm('Сделать новую ссылку? Старая перестанет работать.')) return;
                      act('view', async () => {
                        await actions.viewLink();
                      });
                    }}
                  >
                    Новая ссылка
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    disabled={busy !== null}
                    onClick={() =>
                      act('view', async () => {
                        await actions.viewLink(true);
                      })
                    }
                  >
                    Выключить ссылку
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="muted">Ссылка для вашего телефона: выручка за сегодня, неделю и месяц, чеки и лучшие позиции. Видите только вы.</p>
                <button
                  type="button"
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    act('view', async () => {
                      await actions.viewLink();
                    })
                  }
                >
                  {busy === 'view' ? 'Готовим ссылку…' : 'Получить ссылку'}
                </button>
              </>
            )}
          </section>
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
