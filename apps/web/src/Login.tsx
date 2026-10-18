import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { isAccessKeyShape, normalizeAccessKey } from '@bills/domain';
import { HubRequestError } from './api.ts';
import { readDevice, useAuth, writeDevice } from './auth.ts';
import { navigate, useLocation } from './router.tsx';
import { Field, Page } from './ui.tsx';

const KEY_PLACEHOLDER = 'OWNER-XXXX-XXXX-XXXX-XXXX';
const SHAPE_HINT = 'Ключ выглядит как ROLE-XXXX-XXXX-XXXX-XXXX';
const BAD_KEY = 'Ключ не подходит. Проверьте символы или попросите новый ключ у управляющего.';

/**
 * Canonical form while typing: uppercase, separators → dashes, but a trailing
 * dash the person just typed stays so the next group can follow it.
 */
function liveNormalize(raw: string): string {
  const n = normalizeAccessKey(raw);
  return n && /[\s_\-–—]$/.test(raw) ? `${n}-` : n;
}

/**
 * Sign in with an access key issued on the staff page (or written to
 * first-run-keys.txt by the HUB on its first start). `#/login?key=…` prefills
 * the key for QR links; nothing is submitted until «Войти».
 */
export function LoginPage({ next }: { next: string }) {
  const { login } = useAuth();
  const { query } = useLocation();
  const [key, setKey] = useState(() => normalizeAccessKey(query.get('key') ?? ''));
  // A link with ?key= may arrive while this page is already shown (logout → link): prefill then too.
  const linkKey = query.get('key') ?? '';
  useEffect(() => {
    if (linkKey) setKey(normalizeAccessKey(linkKey));
  }, [linkKey]);
  const [device, setDevice] = useState(readDevice);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const normalized = normalizeAccessKey(key);
  const shapeOk = isAccessKeyShape(normalized);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!normalized) return setError('Введите ключ доступа');
    if (!shapeOk) return setError(SHAPE_HINT);
    setError(null);
    setBusy(true);
    try {
      const d = device.trim().slice(0, 120);
      writeDevice(d);
      await login(normalized, d || undefined);
      const target = !next || next === '/login' ? '/' : next;
      navigate(target);
    } catch (err) {
      if (err instanceof HubRequestError && err.status === 401) setError(BAD_KEY);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Вход по ключу доступа" subtitle="Ключ выдаёт управляющий или владелец на странице «Сотрудники».">
      <form className="form login-form" onSubmit={(e) => void submit(e)} autoComplete="off">
        <Field
          label="Ключ доступа"
          hint={key && !shapeOk ? SHAPE_HINT : 'Регистр и пробелы не важны — ключ подправится сам.'}
        >
          <input
            className="login-key"
            type="text"
            value={key}
            placeholder={KEY_PLACEHOLDER}
            inputMode="text"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            maxLength={60}
            aria-invalid={key ? !shapeOk : undefined}
            onChange={(e) => {
              setKey(liveNormalize(e.target.value));
              setError(null);
            }}
            onBlur={() => setKey(normalized)}
          />
        </Field>
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
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary login-submit" disabled={busy || !normalized}>
            {busy ? 'Проверяем…' : 'Войти'}
          </button>
        </div>
      </form>
      <aside className="login-help">
        <p>
          Ключ выдаёт управляющий или владелец на странице «Сотрудники». Первые ключи владельца и техподдержки HUB
          записал в файл <code>first-run-keys.txt</code> рядом с базой при первом запуске.
        </p>
      </aside>
    </Page>
  );
}
