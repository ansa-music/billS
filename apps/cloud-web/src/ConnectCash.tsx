/**
 * «Подключите кассу»: the connection code (text + QR + «Скопировать») a venue's cash register
 * takes on its first start, and «Получить новый код» (POST /owner/clubs/:id/hub-code). Used by the
 * checklist (Start.tsx) and right after «Добавить заведение» (Company.tsx). The technical values
 * stay folded under «Для техподдержки».
 */
import { useEffect, useRef, useState } from 'react';
import { encodeHubSetupCode, hubCloudUrl, hubSetupUrl, isLocalOnlyCloudUrl } from '@bills/domain';
import { CloudRequestError, issueHubCode } from './api.ts';
import { CopyValue } from './cabinet-ui.tsx';
import { SUPABASE_MODE, supabaseUrl } from './config.ts';
import { nativeBridge } from './platform.ts';
import { QrImage } from './QrImage.tsx';

export interface HubCredentials {
  hubId: string;
  apiKey: string;
  /** Empty — the cabinet's own idea of the address (branchCloudUrl). */
  cloudUrl?: string | null;
  code?: string | null;
}

interface Shown {
  hubId: string;
  apiKey: string;
  cloudUrl: string | null;
  code: string | null;
}

/**
 * Codes issued in this tab, by venue: going back and forth between pages shows the same code
 * instead of issuing (and breaking) a new one. Memory only — the code is a secret.
 */
const issued = new Map<string, Shown>();

/**
 * CLOUD_URL for a venue's register: the `sync` Edge Function under the Supabase project, or the
 * self-hosted cloud this cabinet is served from (in the phone app — the cloud from its settings).
 */
export function branchCloudUrl(): string | null {
  if (SUPABASE_MODE) return hubCloudUrl({ supabaseUrl: supabaseUrl() });
  return hubCloudUrl({ cloudOrigin: nativeBridge()?.cloudUrl() ?? (typeof location === 'undefined' ? null : location.origin) });
}

function toShown(c: HubCredentials): Shown {
  const cloudUrl = c.cloudUrl || branchCloudUrl();
  let code = c.code || null;
  if (!code && cloudUrl) {
    try {
      code = encodeHubSetupCode({ hubId: c.hubId, apiKey: c.apiKey, cloudUrl });
    } catch {
      code = null; // values the cloud never issues: the manual ones under «Для техподдержки» still work
    }
  }
  return { hubId: c.hubId, apiKey: c.apiKey, cloudUrl, code };
}

/** Keeps a code that came with «Добавить заведение» so the checklist shows the same one. */
export function rememberHubCode(clubId: string, c: HubCredentials): void {
  issued.set(clubId, toShown(c));
}

function issueErrorText(e: unknown): string {
  const err = e as CloudRequestError;
  if (err.code === 'OFFLINE') return 'Нет связи с интернетом. Проверьте подключение и нажмите ещё раз.';
  if (err.status === 404 || err.status === 405) {
    return 'Получить код здесь пока нельзя: сервер TS ещё не обновился. Напишите в поддержку TS — пришлём код.';
  }
  if (err.code === 'LICENSE_READ_ONLY') return 'Лицензия закончилась — новый код не выдать. Продлите её у TS.';
  return `Не получилось получить код: ${err.message || 'попробуйте ещё раз'}`;
}

export function ConnectCash({
  clubId,
  clubName,
  hubConnected,
  autoIssue = false,
  initial = null,
}: {
  clubId: string;
  clubName: string;
  hubConnected: boolean;
  /** Issue a code at once when there is none yet and the register has never connected. */
  autoIssue?: boolean;
  initial?: HubCredentials | null;
}) {
  const [shown, setShown] = useState<Shown | null>(() => {
    if (initial) {
      const s = toShown(initial);
      issued.set(clubId, s);
      return s;
    }
    return issued.get(clubId) ?? null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);

  async function issue(confirmFirst: boolean) {
    if (busy) return;
    if (
      confirmFirst &&
      !confirm(
        hubConnected || shown
          ? 'Получить новый код? Старый код перестанет работать: кассу, подключённую по нему, придётся подключить заново.'
          : 'Получить новый код? Старый код перестанет работать.',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await issueHubCode(clubId);
      const s = toShown(res);
      issued.set(clubId, s);
      setShown(s);
    } catch (e) {
      setError(issueErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoIssue && !shown && !hubConnected && !autoTried.current) {
      autoTried.current = true;
      void issue(false);
    }
  }, [autoIssue, shown, hubConnected]);

  const env = shown
    ? [`HUB_ID=${shown.hubId}`, `CLOUD_API_KEY=${shown.apiKey}`, ...(shown.cloudUrl ? [`CLOUD_URL=${shown.cloudUrl}`] : [])].join('\n')
    : '';

  return (
    <div className="connect">
      {hubConnected && !shown && (
        <p className="connect-ok">
          <span aria-hidden="true">✓</span> Касса заведения «{clubName}» подключена и на связи.
        </p>
      )}

      {shown?.code ? (
        <div className="connect-grid">
          <div className="connect-code">
            <p className="connect-how">
              В программе TS на кассе нажмите «Подключить» и вставьте код. Или отсканируйте QR телефоном, подключённым
              к Wi-Fi заведения.
            </p>
            <span className="copy-label">Код подключения</span>
            <code className="connect-code-text">{shown.code}</code>
            <CopyButtonBig text={shown.code} />
          </div>
          <div className="connect-qr">
            <QrImage text={hubSetupUrl(shown.code)} alt={`QR-код для подключения кассы «${clubName}»`} />
          </div>
        </div>
      ) : (
        !hubConnected &&
        !busy &&
        !error && <p className="hint">{autoIssue ? 'Готовим код подключения…' : 'Код подключения ещё не получен.'}</p>
      )}

      {busy && <p className="hint">Получаем код…</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="row wrap">
        {shown || hubConnected ? (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void issue(true)}>
            Получить новый код
          </button>
        ) : !autoIssue || error ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void issue(false)}>
            Получить код подключения
          </button>
        ) : null}
      </div>

      {shown && (
        <details className="tech">
          <summary>Для техподдержки</summary>
          <div className="tech-body">
            <p className="hint">
              Если код не подходит, в мастере настройки выберите ручной ввод или впишите строки в файл настроек сервера
              кассы (<code>/etc/bills/hub.env</code>) и перезапустите его.
            </p>
            <CopyValue label="HUB_ID" value={shown.hubId} />
            <CopyValue label="CLOUD_API_KEY" value={shown.apiKey} />
            {shown.cloudUrl && <CopyValue label="CLOUD_URL" value={shown.cloudUrl} />}
            <pre className="env-snippet">{env}</pre>
            {shown.cloudUrl && isLocalOnlyCloudUrl(shown.cloudUrl) && (
              <p className="hint">
                Кабинет открыт по адресу <code>{shown.cloudUrl}</code> — такой адрес работает только на этом компьютере.
                Кассу в другом месте подключайте вручную с адресом этого компьютера в сети.
              </p>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

/** «Скопировать» for the long code: a big button, «Скопировано ✓» for a moment. */
function CopyButtonBig({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      prompt('Скопируйте код вручную', text);
    }
  }
  return (
    <button type="button" className="btn btn-primary connect-copy" onClick={() => void copy()}>
      {copied ? 'Скопировано ✓' : 'Скопировать код'}
    </button>
  );
}
