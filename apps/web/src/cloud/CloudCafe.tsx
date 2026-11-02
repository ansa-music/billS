/**
 * «Облачная касса» (VITE_CLOUD_HUB=1, prototype): the first screen on a new phone or computer asks for the
 * café code once; after that the usual sign-in with the person's own key. Nothing is installed and nothing
 * of the café is kept on the device — the café lives in the TS cloud (apps/cloud-hub).
 */
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { formatCafeCodeInput, normalizeCafeCode } from '@bills/domain';
import { BrandMark } from '../BrandMark.tsx';
import { Field } from '../ui.tsx';
import { AUTH_CHANGED_EVENT, readAuth } from '../auth.ts';
import { checkCafe, forgetCafe, rememberCafe, shownCafeCode } from './cloud-cafe.ts';
import '../onboarding/onboarding.css';
import '../trial/trial.css';

const PROBLEM: Record<'unknown' | 'offline', string> = {
  unknown: 'Такой кофейни нет. Проверьте буквы и цифры кода.',
  offline: 'Нет связи с облаком TS. Проверьте интернет и попробуйте ещё раз.',
};

export function CloudCafeCode() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeCafeCode(code);
    if (!normalized) {
      setError('В коде 12 букв и цифр, например K7F3-92QX-M4P8.');
      return;
    }
    setBusy(true);
    const result = await checkCafe(normalized);
    setBusy(false);
    if (result !== 'ok') {
      setError(PROBLEM[result]);
      return;
    }
    rememberCafe(normalized);
    window.location.replace(`${window.location.pathname}${window.location.search}#/login`);
    window.location.reload();
  };

  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Код кофейни</h1>
          <p className="page-lead">Один раз на этом телефоне или компьютере. Потом — вход своим кодом сотрудника.</p>
        </div>
      </header>
      <form className="onboarding-card trial-form" onSubmit={(e) => void submit(e)} autoComplete="off">
        <Field label="Код кофейни" error={error} hint="12 букв и цифр. Его знает директор: он виден в меню «Кофейня» → «Код кофейни».">
          <input
            className="trial-code-input"
            value={code}
            placeholder="XXXX-XXXX-XXXX"
            autoFocus
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={20}
            aria-invalid={error ? true : undefined}
            readOnly={busy}
            onChange={(e) => {
              setCode(formatCafeCodeInput(e.target.value));
              setError(null);
            }}
          />
        </Field>
        <div className="onboarding-actions">
          <button type="submit" className="btn btn-primary btn-large" disabled={busy}>
            {busy ? 'Проверяем код…' : 'Открыть кофейню'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** The app of a known café; before sign-in a small line says which café this is and lets the device switch. */
export function CloudCafeGate({ code, children }: { code: string; children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(() => readAuth() !== null);
  useEffect(() => {
    const onAuth = () => setSignedIn(readAuth() !== null);
    window.addEventListener(AUTH_CHANGED_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuth);
  }, []);
  return (
    <>
      {children}
      {!signedIn && (
        <p className="onboarding-foot" style={{ position: 'fixed', left: 16, bottom: 12, margin: 0 }}>
          Кофейня {shownCafeCode(code)} ·{' '}
          <button
            type="button"
            className="onboarding-link"
            onClick={() => {
              forgetCafe();
              window.location.reload();
            }}
          >
            Другая кофейня
          </button>
        </p>
      )}
    </>
  );
}
