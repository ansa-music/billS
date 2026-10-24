/** «Начать бесплатно» (#/signup): five fields → company, first venue, trial → signed in → #/start. */
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { BusinessType } from '@bills/domain';
import { CloudRequestError, loginEmail, signup } from './api.ts';
import type { Identity } from './api.ts';
import { BrandMark } from './BrandMark.tsx';
import { DEFAULT_CITY_ID, citiesByCountry, cityTimezone } from './cities.ts';
import type { SignupField } from './signup.ts';
import {
  PASSWORD_MIN,
  VENUE_NAME_MAX,
  passwordStrength,
  rememberVenueType,
  saveManagerKey,
  signupErrorField,
  signupErrorText,
  signupProblems,
} from './signup.ts';

function CupIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="kind-icon">
      <path d="M10 18h24v10a10 10 0 0 1-10 10h-4a10 10 0 0 1-10-10V18Z" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <path d="M34 21h3a5 5 0 0 1 0 10h-3" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M17 8c0 3-2 3-2 6M24 8c0 3-2 3-2 6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function BallIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className="kind-icon">
      <circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="24" cy="21" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <text x="24" y="25" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor">
        8
      </text>
    </svg>
  );
}

const KINDS: Array<{ type: BusinessType; title: string; text: string; icon: ReactNode }> = [
  { type: 'cafe', title: 'Кофейня', text: 'Касса, меню, заказы для бариста', icon: <CupIcon /> },
  { type: 'billiards', title: 'Бильярдный клуб', text: 'Столы, время игры, тарифы', icon: <BallIcon /> },
];

export function Signup({ onLogin }: { onLogin: (id: Identity) => void }) {
  const [venueName, setVenueName] = useState('');
  const [kind, setKind] = useState<BusinessType | null>(null);
  const [cityId, setCityId] = useState(DEFAULT_CITY_ID);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);
  const [serverField, setServerField] = useState<{ field: SignupField | 'kind' | null; text: string; code: string } | null>(null);
  const [created, setCreated] = useState(false);

  const problems = signupProblems({ venueName, email, password });
  const kindProblem = kind ? null : 'Выберите, что у вас';
  const strength = passwordStrength(password);

  /** Under the field: the form's own check after the first «Создать», else what the cloud said. */
  const errorOf = (f: SignupField | 'kind'): string | null => {
    if (serverField?.field === f) return serverField.text;
    if (!tried) return null;
    return f === 'kind' ? kindProblem : (problems[f] ?? null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setTried(true);
    setServerField(null);
    if (Object.keys(problems).length > 0 || !kind) {
      const first = !venueName.trim() || problems.venueName ? 'su-name' : !kind ? 'su-kind-cafe' : problems.email ? 'su-email' : 'su-password';
      document.getElementById(first)?.focus();
      return;
    }
    setBusy(true);
    const mail = email.trim();
    try {
      const res = await signup({
        email: mail,
        password,
        venueName: venueName.trim(),
        businessType: kind,
        timezone: cityTimezone(cityId),
      });
      saveManagerKey({ clubId: res.clubId, key: res.managerKey });
      rememberVenueType(res.clubId, kind);
      setCreated(true);
      try {
        const id = await loginEmail(mail, password);
        location.hash = '#/start';
        onLogin(id);
      } catch {
        setServerField({
          field: null,
          code: 'LOGIN_AFTER',
          text: 'Заведение создано! Войти автоматически не получилось — нажмите «Войти» и введите эту почту и пароль.',
        });
      }
    } catch (err) {
      const e2 = err as CloudRequestError;
      setServerField({ field: signupErrorField(e2.code), text: signupErrorText(e2.code, e2.status, e2.message), code: e2.code });
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (f: SignupField | 'kind') => {
    const text = errorOf(f);
    return text ? (
      <span className="field-error" role="alert" id={`su-${f}-error`}>
        {text}
        {serverField?.field === f && serverField.code === 'EMAIL_TAKEN' && (
          <>
            {' '}
            <a className="link-inline" href="#/login">
              Войти
            </a>
          </>
        )}
      </span>
    ) : null;
  };

  return (
    <main className="login-page">
      <form className="login signup" onSubmit={submit} noValidate>
        <div className="brand">
          <BrandMark />
          <div>
            <h1>Новое заведение в TS</h1>
            <p className="muted">14 дней бесплатно · карта не нужна</p>
          </div>
        </div>

        <label className="field">
          <span>Как называется заведение</span>
          <input
            id="su-name"
            required
            maxLength={VENUE_NAME_MAX}
            autoComplete="organization"
            placeholder="Например: Coffee Point"
            value={venueName}
            aria-invalid={errorOf('venueName') ? true : undefined}
            onChange={(e) => setVenueName(e.target.value)}
            autoFocus
          />
          {fieldError('venueName')}
        </label>

        <fieldset className="field kind-field">
          <legend>Что у вас</legend>
          <div className="kind-cards" role="radiogroup" aria-label="Что у вас">
            {KINDS.map((k) => (
              <button
                key={k.type}
                id={`su-kind-${k.type}`}
                type="button"
                role="radio"
                aria-checked={kind === k.type}
                className="kind-card"
                onClick={() => {
                  setKind(k.type);
                  if (serverField?.field === 'kind') setServerField(null);
                }}
              >
                {k.icon}
                <span className="kind-title">{k.title}</span>
                <span className="kind-text">{k.text}</span>
              </button>
            ))}
          </div>
          {fieldError('kind')}
        </fieldset>

        <label className="field">
          <span>Город</span>
          <select value={cityId} onChange={(e) => setCityId(e.target.value)}>
            {citiesByCountry().map((g) => (
              <optgroup key={g.country} label={g.label}>
                {g.cities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="hint">Нужен, чтобы смены и отчёты считались по вашему времени.</span>
        </label>

        <label className="field">
          <span>Почта</span>
          <input
            id="su-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            placeholder="name@mail.kz"
            value={email}
            aria-invalid={errorOf('email') ? true : undefined}
            onChange={(e) => {
              setEmail(e.target.value);
              if (serverField?.field === 'email') setServerField(null);
            }}
          />
          {fieldError('email')}
        </label>

        <div className="field">
          <label htmlFor="su-password">Пароль</label>
          <div className="pw-wrap">
            <input
              id="su-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              value={password}
              aria-invalid={errorOf('password') ? true : undefined}
              aria-describedby="su-pw-strength"
              onChange={(e) => {
                setPassword(e.target.value);
                if (serverField?.field === 'password') setServerField(null);
              }}
            />
            <button
              type="button"
              className="pw-toggle"
              aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? 'Скрыть' : 'Показать'}
            </button>
          </div>
          <div className="pw-meter" data-level={strength.level} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="hint" id="su-pw-strength">
            {strength.text}
          </span>
          {fieldError('password')}
        </div>

        {serverField && serverField.field === null && (
          <p className={created ? 'saved' : 'form-error'} role="alert">
            {serverField.text}
          </p>
        )}

        {created && serverField?.code === 'LOGIN_AFTER' ? (
          <a className="btn btn-primary btn-big-text" href="#/login">
            Войти
          </a>
        ) : (
          <button type="submit" className="btn btn-primary btn-big-text" disabled={busy}>
            {busy ? (created ? 'Входим…' : 'Создаём заведение…') : 'Создать заведение'}
          </button>
        )}

        <p className="login-alt">
          Уже есть аккаунт?{' '}
          <a className="link-inline" href="#/login">
            Войти
          </a>
        </p>
      </form>
    </main>
  );
}
