import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { OwnerView } from '@bills/domain';
import { normalizeCloudUrl, parseLoginQr } from '@bills/domain';
import { CloudRequestError, SUPABASE_MODE, login, loginByKey, sendMagicLink, takeLinkError } from './api.ts';
import { BrandMark } from './BrandMark.tsx';
import { nativeBridge } from './platform.ts';

/** 'key' — self-hosted only (owner keys); 'link' — Supabase only (magic link to the e-mail). */
type Mode = 'password' | 'key' | 'link';

const NOT_TS_QR = 'Этот QR-код не от TS. Откройте кабинет на компьютере → «Телефон и уведомления» → «Создать ключ для телефона».';

/** What went wrong, in words the owner understands. */
function describe(err: unknown, mode: Mode, cloudUrl: string | null): string {
  const e = err as CloudRequestError;
  if (e.code === 'OFFLINE') {
    return cloudUrl
      ? `Нет связи с облаком по адресу ${cloudUrl}. Проверьте адрес и интернет.`
      : 'Нет связи с облаком. Проверьте интернет.';
  }
  if (e.code === 'NO_CLOUD') return 'Укажите адрес облака';
  // Supabase mode: api-supabase.ts already words every error for the owner.
  if (SUPABASE_MODE) return e.message || 'Не удалось войти';
  if (e.status === 401) {
    return mode === 'key' ? 'Ключ не подходит: неверный или отозван' : 'Неверный e-mail или пароль';
  }
  if (e.code === 'HTTP_ERROR' && cloudUrl) return `По адресу ${cloudUrl} отвечает не облако TS. Проверьте адрес.`;
  return e.message || 'Не удалось войти';
}

export function Login({ onLogin }: { onLogin: (owner: OwnerView) => void }) {
  // With Supabase the app signs in like the browser: no cloud address, no owner keys.
  const bridge = SUPABASE_MODE ? null : nativeBridge();
  const inApp = nativeBridge() !== null;
  const [mode, setMode] = useState<Mode>(bridge ? 'key' : 'password');
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  const [cloud, setCloud] = useState(() => bridge?.cloudUrl() ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A magic link that did not work (expired, used twice) comes back here with the reason.
  useEffect(() => {
    if (!SUPABASE_MODE) return;
    void takeLinkError().then((e) => {
      if (e) setError(e);
    });
  }, []);

  /** In the app: checks and saves the cloud address; returns it, or null after showing an error. */
  async function saveCloud(input: string): Promise<string | null | false> {
    if (!bridge) return null;
    const url = normalizeCloudUrl(input);
    if (!url) {
      setError(input.trim() ? 'Адрес облака не похож на адрес сайта, например cloud.example.kz' : 'Укажите адрес облака');
      return false;
    }
    if (url !== bridge.cloudUrl()) await bridge.setCloudUrl(url);
    setCloud(url);
    return url;
  }

  async function run(how: Mode, attempt: () => Promise<OwnerView>, cloudUrl: string | null) {
    try {
      onLogin(await attempt());
    } catch (err) {
      setError(describe(err, how, cloudUrl));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let cloudUrl = await saveCloud(cloud);
      if (cloudUrl === false) return;
      if (mode === 'password') {
        await run('password', () => login(email.trim(), password), cloudUrl);
        return;
      }
      if (mode === 'link') {
        try {
          await sendMagicLink(email.trim());
          setLinkSentTo(email.trim());
        } catch (err) {
          setError(describe(err, 'link', null));
        }
        return;
      }
      // A pasted QR text («ts://login?…») works as well as the bare key.
      const parsed = parseLoginQr(key) ?? { key: key.trim(), cloudUrl: null };
      if (parsed.cloudUrl && bridge) {
        cloudUrl = await saveCloud(parsed.cloudUrl);
        if (cloudUrl === false) return;
      }
      await run('key', () => loginByKey(parsed.key), cloudUrl);
    } finally {
      setBusy(false);
    }
  }

  async function scan() {
    if (!bridge || busy) return;
    setError(null);
    let text: string | null;
    try {
      text = await bridge.scanQr();
    } catch (err) {
      setError(`Не удалось открыть камеру: ${(err as Error).message}`);
      return;
    }
    if (text === null) return; // cancelled
    const parsed = parseLoginQr(text);
    if (!parsed) {
      setError(NOT_TS_QR);
      return;
    }
    setMode('key');
    setKey(parsed.key);
    setBusy(true);
    try {
      const cloudUrl = await saveCloud(parsed.cloudUrl ?? cloud);
      if (cloudUrl === false) return;
      await run('key', () => loginByKey(parsed.key), cloudUrl);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login" onSubmit={submit}>
        <div className="brand">
          <BrandMark />
          <div>
            <h1>Кабинет владельца</h1>
            <p className="muted">TS</p>
          </div>
        </div>

        {bridge && (
          <>
            <label className="field">
              <span>Адрес облака</span>
              <input
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="cloud.example.kz"
                value={cloud}
                onChange={(e) => setCloud(e.target.value)}
                onBlur={() => {
                  const url = normalizeCloudUrl(cloud);
                  if (url) setCloud(url);
                }}
              />
            </label>
            <button type="button" className="btn btn-primary btn-scan" onClick={() => void scan()} disabled={busy}>
              Сканировать QR
            </button>
            <p className="hint">
              QR-код — в кабинете на компьютере: «Телефон и уведомления» → «Создать ключ для телефона».
            </p>
          </>
        )}

        {SUPABASE_MODE ? (
          <div className="seg" role="tablist" aria-label="Способ входа">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'password'}
              onClick={() => {
                setMode('password');
                setError(null);
              }}
            >
              Почта и пароль
            </button>
            {/* In the app a link from the mail would open the phone's browser, not the app. */}
            {!inApp && (
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'link'}
                onClick={() => {
                  setMode('link');
                  setError(null);
                }}
              >
                Ссылка на почту
              </button>
            )}
          </div>
        ) : (
        <div className="seg" role="tablist" aria-label="Способ входа">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'password'}
            onClick={() => {
              setMode('password');
              setError(null);
            }}
          >
            Почта и пароль
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'key'}
            onClick={() => {
              setMode('key');
              setError(null);
            }}
          >
            Ключ владельца
          </button>
        </div>
        )}

        {mode === 'link' ? (
          linkSentTo ? (
            <p className="saved" role="status">
              Письмо со ссылкой отправлено на {linkSentTo}. Откройте ссылку на этом устройстве — кабинет откроется уже
              с входом. Письма нет — проверьте «Спам».
            </p>
          ) : (
            <label className="field">
              <span>E-mail</span>
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )
        ) : mode === 'password' ? (
          <>
            <label className="field">
              <span>E-mail</span>
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus={!bridge}
              />
            </label>
            <label className="field">
              <span>Пароль</span>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="field">
            <span>Ключ владельца</span>
            <input
              className="key-input"
              type="text"
              required
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="OWNER-XXXX-XXXX-XXXX-XXXX"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {mode === 'link' ? (
          linkSentTo ? (
            <button type="button" className="btn" onClick={() => setLinkSentTo(null)}>
              Отправить ещё раз
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Отправляем…' : 'Прислать ссылку для входа'}
            </button>
          )
        ) : (
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Входим…' : 'Войти'}
          </button>
        )}
      </form>
      <a className="link login-apps" href="#/apps">
        Скачать приложение для телефона и кассы
      </a>
    </main>
  );
}
