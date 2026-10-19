import { useState } from 'react';
import type { FormEvent } from 'react';
import { setNewPassword } from './api.ts';
import { BrandMark } from './BrandMark.tsx';
import { newPasswordProblem } from './supabase-util.ts';

/**
 * «Задать пароль» (#/set-password, Supabase): after the invitation or reset letter's link, after a
 * temporary password (`forced`: the cabinet stays closed until it is changed), or by choice.
 */
export function SetPasswordPage({
  email,
  forced,
  onDone,
  onSignOut,
}: {
  email: string | null;
  forced: boolean;
  onDone: () => void;
  onSignOut: () => void;
}) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = newPasswordProblem(password, repeat);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setNewPassword(password);
      onDone();
    } catch (err) {
      setError((err as Error).message || 'Не удалось сохранить пароль');
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
            <h1>Задайте пароль</h1>
            <p className="muted">{email ?? 'TS'}</p>
          </div>
        </div>
        <p className="hint">
          {forced
            ? 'Придумайте свой пароль для входа в кабинет — не короче 8 символов. Временный пароль после этого перестанет работать.'
            : 'Новый пароль для входа в кабинет — не короче 8 символов.'}
        </p>
        <label className="field">
          <span>Новый пароль</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span>Ещё раз</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Сохраняем…' : 'Сохранить и войти'}
        </button>
        {forced ? (
          <button type="button" className="link" onClick={onSignOut}>
            Выйти
          </button>
        ) : (
          <a className="link" href="#/">
            Не менять
          </a>
        )}
      </form>
    </main>
  );
}
