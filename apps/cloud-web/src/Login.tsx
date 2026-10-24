import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { normalizeAccessKey, normalizeCloudUrl, parseLoginQr, roleOfKeyPrefix } from '@bills/domain';
import { CloudRequestError, SIGNUP_AVAILABLE, SUPABASE_MODE, loginByKey, loginEmail, platformLogin, sendMagicLink, sendPasswordReset, takeLinkError } from './api.ts';
import type { Identity } from './api.ts';
import { BrandMark } from './BrandMark.tsx';
import { nativeBridge } from './platform.ts';
import { isReturning } from './signup.ts';

/**
 * 'key' — self-hosted only (owner keys); 'link' — Supabase only (magic link to the e-mail);
 * 'reset' — Supabase only («Забыли пароль?»: a letter leading to «Задать пароль»).
 */
type Mode = 'password' | 'key' | 'link' | 'reset';

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
    return mode === 'key' ? 'Ключ телефона не подходит: неверный или отозван' : 'Неверный e-mail или пароль';
  }
  if (e.code === 'HTTP_ERROR' && cloudUrl) return `По адресу ${cloudUrl} отвечает не облако TS. Проверьте адрес.`;
  return e.message || 'Не удалось войти';
}

/** Platform sign-in errors: wrong key, a manager's key, too many tries. */
function describePlatform(err: unknown): string {
  const e = err as CloudRequestError & { retryAfterMs?: number };
  if (e.code === 'OFFLINE') return 'Нет связи с облаком. Проверьте интернет.';
  if (e.status === 429 || e.code === 'LOGIN_LOCKED') {
    return e.message || 'Слишком много неверных попыток — подождите немного и попробуйте снова';
  }
  if (e.status === 401 || e.status === 403) return 'Ключ не подходит: неверный, отозван или это не ключ платформы TS';
  return e.message || 'Не удалось войти';
}

/** null when the key looks like a platform key, otherwise what is wrong with it. */
function platformKeyProblem(key: string): string | null {
  const role = roleOfKeyPrefix(key);
  if (role === 'owner' || role === 'tech') return null;
  if (role === 'manager') return 'Это ключ управляющего — он для входа в кассу заведения. В кабинет управляющий входит почтой и паролем.';
  return 'Ключ платформы начинается с OWNER- или TECH-';
}

type Side = 'manager' | 'platform';

export function Login({
  onLogin,
  start = 'welcome',
}: {
  /** The manager, the platform or both (Supabase: one e-mail may be both). */
  onLogin: (id: Identity) => void;
  /** 'welcome' — «Начать бесплатно» first for a new visitor (#/); 'form' — straight to the sign-in form (#/login). */
  start?: 'welcome' | 'form';
}) {
  // With Supabase the app signs in like the browser: no cloud address, no owner keys.
  const bridge = SUPABASE_MODE ? null : nativeBridge();
  const inApp = nativeBridge() !== null;
  const [mode, setMode] = useState<Mode>(bridge ? 'key' : 'password');
  // The phone app is the manager's; the platform signs in from a browser.
  const [side, setSide] = useState<Side>('manager');
  const [platformKey, setPlatformKey] = useState('');
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);
  const [cloud, setCloud] = useState(() => bridge?.cloudUrl() ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new visitor first sees «Начать бесплатно»; whoever signed in here before — the form.
  const [welcome, setWelcome] = useState(() => SIGNUP_AVAILABLE && !inApp && start === 'welcome' && !isReturning());

  // A magic link that did not work (expired, used twice) comes back here with the reason.
  useEffect(() => {
    if (!SUPABASE_MODE) return;
    void takeLinkError().then((e) => {
      if (e) {
        setError(e);
        setWelcome(false);
      }
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

  async function run(how: Mode, attempt: () => Promise<Identity>, cloudUrl: string | null) {
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
    if (side === 'platform') {
      try {
        const k = normalizeAccessKey(platformKey);
        const problem = platformKeyProblem(k);
        if (problem) {
          setError(problem);
          return;
        }
        onLogin({ owner: null, platform: await platformLogin(k) });
      } catch (err) {
        setError(describePlatform(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    try {
      let cloudUrl = await saveCloud(cloud);
      if (cloudUrl === false) return;
      if (mode === 'password') {
        await run('password', () => loginEmail(email.trim(), password), cloudUrl);
        return;
      }
      if (mode === 'reset') {
        try {
          await sendPasswordReset(email.trim());
          setResetSentTo(email.trim());
        } catch (err) {
          setError(describe(err, 'reset', null));
        }
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
      await run('key', async () => ({ owner: await loginByKey(parsed.key), platform: null }), cloudUrl);
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
      await run('key', async () => ({ owner: await loginByKey(parsed.key), platform: null }), cloudUrl);
    } finally {
      setBusy(false);
    }
  }

  const teamLink = !inApp && (
    <button
      type="button"
      className="link login-team"
      onClick={() => {
        setSide(side === 'platform' ? 'manager' : 'platform');
        setWelcome(false);
        setError(null);
      }}
    >
      {side === 'platform' ? '← Вход для владельцев заведений' : 'Вход для команды TS'}
    </button>
  );

  if (welcome && side === 'manager') {
    return (
      <main className="login-page">
        <section className="login welcome" aria-labelledby="welcome-title">
          <div className="brand">
            <BrandMark />
            <div>
              <h1 id="welcome-title">TS</h1>
              <p className="muted">Касса и учёт для заведения</p>
            </div>
          </div>
          <h2 className="welcome-title">Касса, смены и отчёты для кофейни или бильярдного клуба</h2>
          <ul className="welcome-points">
            <li>Касса работает даже без интернета</li>
            <li>Выручка и смены — на телефоне, где бы вы ни были</li>
            <li>14 дней бесплатно, карта не нужна</li>
          </ul>
          <a className="btn btn-primary btn-big-text" href="#/signup">
            Начать бесплатно
          </a>
          <p className="login-alt">
            Уже есть аккаунт?{' '}
            <a className="link-inline" href="#/login" onClick={() => setWelcome(false)}>
              Войти
            </a>
          </p>
        </section>
        <a className="link login-apps" href="#/apps">
          Скачать программу для кассы и телефона
        </a>
        {teamLink}
      </main>
    );
  }

  return (
    <main className="login-page">
      <form className="login" onSubmit={submit}>
        <div className="brand">
          <BrandMark />
          <div>
            <h1>{side === 'platform' ? 'Вход для команды TS' : 'Вход в кабинет'}</h1>
            <p className="muted">{side === 'platform' ? 'Владелец и техподдержка TS' : 'TS'}</p>
          </div>
        </div>

        {side === 'platform' ? (
          <>
            <label className="field">
              <span>Ключ платформы</span>
              <input
                className="key-input"
                type="password"
                required
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="OWNER-XXXX-XXXX-XXXX-XXXX или TECH-…"
                value={platformKey}
                onChange={(e) => setPlatformKey(e.target.value)}
                autoFocus
              />
            </label>
            <p className="hint">
              Для владельца и техподдержки TS. Владельцы заведений входят почтой и паролем.
              {SUPABASE_MODE && ' Владелец платформы может войти и своей почтой — откроется кабинет платформы.'}
            </p>
          </>
        ) : (
          <>

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
            Ключ телефона
          </button>
        </div>
        )}

        {mode === 'reset' ? (
          resetSentTo ? (
            <p className="saved" role="status">
              Письмо для смены пароля отправлено на {resetSentTo}. Откройте ссылку из письма — кабинет предложит задать
              новый пароль. Письма нет — проверьте «Спам».
            </p>
          ) : (
            <>
              <p className="hint">Пришлём письмо со ссылкой: по ней вы зададите новый пароль.</p>
              <label className="field">
                <span>E-mail</span>
                <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
              </label>
            </>
          )
        ) : mode === 'link' ? (
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
            <span>Ключ для телефона (MGR-… или из «Телефон и уведомления»)</span>
            <input
              className="key-input"
              type="text"
              required
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder="MGR-XXXX-XXXX-XXXX-XXXX"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        )}

          </>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {side === 'platform' ? (
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Входим…' : 'Войти'}
          </button>
        ) : mode === 'reset' ? (
          <>
            {!resetSentTo && (
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Отправляем…' : 'Прислать ссылку для смены пароля'}
              </button>
            )}
            <button
              type="button"
              className="link"
              onClick={() => {
                setMode('password');
                setResetSentTo(null);
                setError(null);
              }}
            >
              Назад ко входу
            </button>
          </>
        ) : mode === 'link' ? (
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
          <>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Входим…' : 'Войти'}
            </button>
            {SUPABASE_MODE && mode === 'password' && (
              <button
                type="button"
                className="link"
                onClick={() => {
                  setMode('reset');
                  setError(null);
                }}
              >
                Забыли пароль?
              </button>
            )}
            {SIGNUP_AVAILABLE && side === 'manager' && (
              <p className="login-alt">
                Нет аккаунта?{' '}
                <a className="link-inline" href="#/signup">
                  Начать бесплатно
                </a>
              </p>
            )}
          </>
        )}
      </form>
      <a className="link login-apps" href="#/apps">
        Скачать программу для кассы и телефона
      </a>
      {teamLink}
    </main>
  );
}
