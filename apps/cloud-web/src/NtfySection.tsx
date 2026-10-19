import { useState } from 'react';
import { currentNtfyTopic, enableNtfy, newNtfyTopicUrl } from './ntfy.ts';
import { nativeBridge } from './platform.ts';
import { QrImage } from './QrImage.tsx';
import { Section } from './shared.tsx';
import { DEFAULT_NTFY_SERVER, ntfyLinks, normalizeNtfyServer } from './supabase-util.ts';

const FDROID = 'https://f-droid.org/packages/io.heckel.ntfy/';
const GOOGLE_PLAY = 'https://play.google.com/store/apps/details?id=io.heckel.ntfy';
const APP_STORE = 'https://apps.apple.com/app/ntfy/id1625396347';

/**
 * «Получать уведомления через ntfy» (Supabase mode). The Android app has no Web Push in its
 * WebView, so alerts go to a secret ntfy topic and the free ntfy app shows them.
 */
export function NtfySection({ onChange }: { onChange: () => Promise<void> | void }) {
  const inApp = nativeBridge() !== null;
  const [topic, setTopic] = useState(() => currentNtfyTopic()?.topicUrl ?? null);
  const [server, setServer] = useState(() => {
    const links = topic ? ntfyLinks(topic) : null;
    return links && links.server !== DEFAULT_NTFY_SERVER ? links.server : '';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function enable(fresh: boolean) {
    const base = normalizeNtfyServer(server);
    if (!base) {
      setError('Адрес сервера ntfy не похож на адрес сайта, например ntfy.example.kz');
      return;
    }
    if (fresh && topic && !confirm('Создать новый адрес? Старая подписка в ntfy перестанет получать уведомления.')) return;
    setBusy(true);
    setError(null);
    try {
      const keep = !fresh && topic && ntfyLinks(topic)?.server === base ? topic : null;
      const url = keep ?? newNtfyTopicUrl(base);
      await enableNtfy(url);
      setTopic(url);
      await onChange();
    } catch (e) {
      setError(`Не удалось подключить ntfy: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // no clipboard: the topic is on screen to copy by hand
    }
  }

  const links = topic ? ntfyLinks(topic) : null;

  return (
    <Section title="Уведомления через ntfy">
      <p className="hint">
        {inApp
          ? 'Приложение TS получает тревоги через бесплатное приложение ntfy — без Google-аккаунта и без рекламы.'
          : 'Можно получать тревоги и через бесплатное приложение ntfy (Android, iPhone) — например, если браузер не умеет уведомления.'}
      </p>

      {links ? (
        <>
          <ol className="steps">
            <li>
              Установите ntfy: <a className="link" href={FDROID} target="_blank" rel="noreferrer">F-Droid</a> (работает
              без Google) или <a className="link" href={GOOGLE_PLAY} target="_blank" rel="noreferrer">Google Play</a>
              {links.server === DEFAULT_NTFY_SERVER && (
                <>
                  ; на iPhone — <a className="link" href={APP_STORE} target="_blank" rel="noreferrer">App Store</a>
                </>
              )}
              .
            </li>
            <li>
              {inApp ? 'Нажмите «Подписаться в ntfy»' : 'На телефоне нажмите «Подписаться в ntfy» или отсканируйте QR'}.
              Если не открылось — в ntfy нажмите «+» и введите тему <code>{links.topic}</code>
              {links.server !== DEFAULT_NTFY_SERVER && (
                <>
                  , включите «Другой сервер» и укажите <code>{links.server}</code>
                </>
              )}
              .
            </li>
            <li>Нажмите «Отправить тестовое уведомление» в разделе «Устройства» ниже.</li>
          </ol>
          <div className="row wrap">
            <a className="btn btn-primary" href={links.deepLink}>
              Подписаться в ntfy
            </a>
            <a className="btn" href={links.https} target="_blank" rel="noreferrer">
              Открыть тему в браузере
            </a>
            <button type="button" className="btn btn-small" onClick={() => void copy(links.topic)}>
              {copied ? 'Скопировано' : 'Скопировать тему'}
            </button>
          </div>
          {!inApp && <QrImage text={links.https} alt="QR-код подписки ntfy" />}
          <p className="hint">
            Адрес темы — секрет: кто его знает, тот видит уведомления. Если он попал не туда — создайте новый.
          </p>
          <div className="row wrap">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => void enable(true)}>
              Создать новый адрес
            </button>
          </div>
        </>
      ) : (
        <div className="row wrap">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void enable(false)}>
            {busy ? 'Подключаем…' : 'Получать уведомления через ntfy'}
          </button>
        </div>
      )}

      <details className="ntfy-server">
        <summary>Свой сервер ntfy</summary>
        <label className="field">
          <span>Адрес сервера (пусто — {DEFAULT_NTFY_SERVER.replace('https://', '')})</span>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="ntfy.example.kz"
            value={server}
            onChange={(e) => setServer(e.target.value)}
          />
        </label>
        {topic && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void enable(true)}>
            Перейти на этот сервер
          </button>
        )}
      </details>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}
