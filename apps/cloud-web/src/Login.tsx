import { useState } from 'react';
import type { FormEvent } from 'react';
import type { OwnerView } from '@bills/domain';
import { CloudRequestError, login } from './api.ts';

export function Login({ onLogin }: { onLogin: (owner: OwnerView) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(email.trim(), password));
    } catch (err) {
      const e = err as CloudRequestError;
      setError(e.status === 401 ? 'Неверный e-mail или пароль' : e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login" onSubmit={submit}>
        <div className="brand">
          <span className="ball" aria-hidden="true">
            8
          </span>
          <div>
            <h1>Кабинет владельца</h1>
            <p className="muted">Billiard Control</p>
          </div>
        </div>
        <label className="field">
          <span>E-mail</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
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
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Входим…' : 'Войти'}
        </button>
      </form>
    </main>
  );
}
