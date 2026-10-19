import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { SHORT_KEY_LENGTH, isDemoKeyShape, keyKindOf, normalizeAccessKey } from '@bills/domain';
import { HubRequestError } from './api.ts';
import { readDevice, useAuth, writeDevice } from './auth.ts';
import { DemoKeys, useDemo } from './demo.tsx';
import { navigate, useLocation } from './router.tsx';
import { Field, Page } from './ui.tsx';

const LONG_PLACEHOLDER = 'MGR-XXXX-XXXX-XXXX-XXXX';
const SHORT_HINT = `Ключ сотрудника — ${SHORT_KEY_LENGTH} цифр.`;
const LONG_HINT = 'Длинный ключ выглядит как MGR-XXXX-XXXX-XXXX-XXXX.';
const BAD_KEY = 'Ключ не подходит. Проверьте цифры или попросите новый ключ у управляющего.';

type Mode = 'short' | 'long';

/**
 * Canonical form while typing: uppercase, separators → dashes, but a trailing
 * dash the person just typed stays so the next group can follow it. Digits stay digits.
 */
function liveNormalize(raw: string): string {
  const n = normalizeAccessKey(raw);
  if (/^\d*$/.test(n)) return n.slice(0, 12);
  return n && /[\s_\-–—]$/.test(raw) ? `${n}-` : n;
}

/** A key from a link or a tap: digits → the keypad, anything else → the long-key field. */
function modeOf(key: string, fallback: Mode): Mode {
  if (!key) return fallback;
  return /^\d+$/.test(key) ? 'short' : 'long';
}

function secondsLeft(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * Sign in with an access key: six digits for staff (a big keypad for the
 * tablet), or a long key (MGR-…, OWNER-…, TECH-…) for the manager and TS.
 * The kind is recognised by its shape. `#/login?key=…` prefills the key for QR
 * links; nothing is submitted until «Войти». After too many wrong keys the HUB
 * answers 429 and the form counts down.
 */
export function LoginPage({ next }: { next: string }) {
  const { login } = useAuth();
  const { demo } = useDemo();
  const { query } = useLocation();
  const linkKey = query.get('key') ?? '';
  const [key, setKey] = useState(() => normalizeAccessKey(linkKey));
  const [mode, setMode] = useState<Mode>(() => modeOf(normalizeAccessKey(linkKey), 'short'));
  // A link with ?key= may arrive while this page is already shown (logout → link): prefill then too.
  useEffect(() => {
    if (!linkKey) return;
    const k = normalizeAccessKey(linkKey);
    setKey(k);
    setMode((m) => modeOf(k, m));
  }, [linkKey]);
  const [device, setDevice] = useState(readDevice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);

  // Count down a lock once a second; stops by itself when it is over.
  useEffect(() => {
    if (lockedUntil === null) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= lockedUntil) setLockedUntil(null);
    }, 1000);
    return () => clearInterval(t);
  }, [lockedUntil]);
  const wait = secondsLeft(lockedUntil, now);

  const normalized = normalizeAccessKey(key);
  // A demo HUB also takes its four-digit presentation keys; a real HUB refuses them anyway.
  const kind = keyKindOf(normalized) ?? (demo && isDemoKeyShape(normalized) ? 'short' : null);
  const digitsOnly = /^\d+$/.test(normalized);
  const shapeHint = digitsOnly ? SHORT_HINT : LONG_HINT;

  const setTyped = (value: string) => {
    const k = liveNormalize(value);
    setKey(k);
    setError(null);
    // Letters typed on a hardware keyboard: this is a long key.
    if (mode === 'short' && /[A-Za-z]/.test(k)) setMode('long');
  };

  const submit = async (e?: FormEvent, picked?: string) => {
    e?.preventDefault();
    if (busy || wait > 0) return;
    const normalized = picked ?? normalizeAccessKey(key);
    const kind = picked ? 'short' : (keyKindOf(normalized) ?? (demo && isDemoKeyShape(normalized) ? 'short' : null));
    if (!normalized) return setError('Введите ключ доступа');
    if (!kind) return setError(shapeHint);
    setError(null);
    setBusy(true);
    try {
      const d = device.trim().slice(0, 120);
      writeDevice(d);
      await login(normalized, d || undefined);
      const target = !next || next === '/login' ? '/' : next;
      navigate(target);
    } catch (err) {
      if (err instanceof HubRequestError && err.status === 429) {
        const ms = err.retryAfterMs ?? 30_000;
        setNow(Date.now());
        setLockedUntil(Date.now() + ms);
        setError(null);
      } else if (err instanceof HubRequestError && err.status === 401) {
        setError(BAD_KEY);
        if (kind === 'short') setKey('');
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const press = (digit: string) => {
    setError(null);
    setKey((k) => (/^\d*$/.test(k) ? (k + digit).slice(0, demo ? 4 : SHORT_KEY_LENGTH) : digit));
  };
  const erase = () => {
    setError(null);
    setKey((k) => k.slice(0, -1));
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setKey('');
    setError(null);
    setTimeout(() => input.current?.focus(), 0);
  };

  // The demo knows only its four-digit keys: no long-key field, no device name, no first-run hint.
  const shortMode = demo || mode === 'short';
  const digits = demo ? 4 : SHORT_KEY_LENGTH;
  const locked = wait > 0;

  return (
    <Page title="Вход по ключу доступа" subtitle="Ключ выдаёт управляющий на странице «Сотрудники».">
      <form className="form login-form" onSubmit={(e) => void submit(e)} autoComplete="off">
        {!demo && (
          <div className="seg-chips login-mode" role="radiogroup" aria-label="Какой ключ">
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={shortMode}
              aria-pressed={shortMode}
              onClick={() => switchMode('short')}
            >
              6 цифр (сотрудник)
            </button>
            <button
              type="button"
              className="chip"
              role="radio"
              aria-checked={!shortMode}
              aria-pressed={!shortMode}
              onClick={() => switchMode('long')}
            >
              Длинный ключ
            </button>
          </div>
        )}
        <Field
          label="Ключ доступа"
          hint={
            key && !kind
              ? shapeHint
              : demo
                ? 'Демо: ключи 0000–4444 — или нажмите «Войти как …» ниже.'
                : shortMode
                  ? 'Наберите цифры на клавиатуре ниже или на своей.'
                  : 'Регистр и пробелы не важны — ключ подправится сам.'
          }
        >
          <input
            ref={input}
            className="login-key"
            data-kind={shortMode ? 'short' : 'long'}
            type={shortMode ? 'password' : 'text'}
            value={key}
            placeholder={shortMode ? '•'.repeat(digits) : LONG_PLACEHOLDER}
            inputMode={shortMode ? 'numeric' : 'text'}
            pattern={shortMode ? '[0-9]*' : undefined}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            maxLength={60}
            aria-invalid={key && !kind && (!shortMode || key.length >= digits) ? true : undefined}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => setKey(normalized)}
          />
        </Field>

        {shortMode && (
          <div className="keypad" role="group" aria-label="Цифровая клавиатура">
            <div className="keypad-dots" aria-hidden="true">
              {Array.from({ length: digits }, (_, i) => (
                <span key={i} className="keypad-dot" data-on={i < key.length || undefined} />
              ))}
            </div>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} type="button" className="keypad-key" disabled={busy || locked} onClick={() => press(d)}>
                {d}
              </button>
            ))}
            <button type="button" className="keypad-key keypad-erase" disabled={busy || !key} onClick={erase} aria-label="Стереть">
              ⌫
            </button>
            <button type="button" className="keypad-key" disabled={busy || locked} onClick={() => press('0')}>
              0
            </button>
            <button type="submit" className="keypad-key keypad-enter" disabled={busy || locked || kind !== 'short'} aria-label="Войти">
              {busy ? '…' : 'Войти'}
            </button>
          </div>
        )}

        {!demo && (
          <Field label="Название устройства" hint="Необязательно: видно в списке входов, чтобы отличать планшеты.">
            <input
              type="text"
              value={device}
              placeholder="Планшет у бара"
              maxLength={120}
              autoComplete="off"
              onChange={(e) => setDevice(e.target.value)}
            />
          </Field>
        )}
        {locked && (
          <p className="field-error login-locked" role="alert">
            Слишком много попыток, подождите {wait} с.
          </p>
        )}
        {error && !locked && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {!shortMode && (
          <div className="form-actions">
            <button type="submit" className="btn btn-primary login-submit" disabled={busy || locked || !normalized}>
              {busy ? 'Проверяем…' : locked ? `Подождите ${wait} с` : 'Войти'}
            </button>
          </div>
        )}
      </form>
      <DemoKeys
        busy={busy || locked}
        onLogin={(k) => {
          const n = normalizeAccessKey(k);
          setMode(modeOf(n, mode));
          setKey(n);
          setError(null);
          void submit(undefined, n);
        }}
      />
      {!demo && (
        <aside className="login-help">
          <p>
            Сотрудники входят по ключу из 6 цифр, который выдал управляющий; он работает только в этом филиале. Управляющий и поддержка TS
            входят по длинному ключу. Если HUB запущен впервые и без облака, стартовый ключ поддержки записан в файл{' '}
            <code>first-run-keys.txt</code> рядом с базой.
          </p>
        </aside>
      )}
    </Page>
  );
}
