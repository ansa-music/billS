import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { RosterPerson } from '@bills/domain';
import { SHORT_KEY_LENGTH, deviceNameFromUserAgent, isDemoKeyShape, keyKindOf, nameInitials, normalizeAccessKey, rolesLabel } from '@bills/domain';
import { HubRequestError } from './api.ts';
import { readDevice, useAuth, writeDevice } from './auth.ts';
import { BrandMark } from './BrandMark.tsx';
import { DemoKeys, useDemo } from './demo.tsx';
import { navigate, useLocation } from './router.tsx';
import { fetchRoster } from './onboarding/setup.ts';
import { Field, Page } from './ui.tsx';
import './onboarding/onboarding.css';

const LONG_PLACEHOLDER = 'TECH-XXXX-XXXX-XXXX-XXXX';
const LONG_HINT = 'Длинный ключ выглядит как TECH-XXXX-XXXX-XXXX-XXXX или MGR-XXXX-XXXX-XXXX-XXXX.';
const BAD_KEY = 'Неверный ключ';
/** How often the list of names is refreshed while the screen waits (people arrive from the cabinet). */
const ROSTER_REFRESH_MS = 15_000;

/**
 * Who is signing in: a person picked on «Кто на смене?», anyone with six digits (no list, or «меня
 * нет в списке»), or support with a long key.
 */
type View = { kind: 'roster' } | { kind: 'keypad'; person: RosterPerson | null } | { kind: 'support' };

/** Which screen is really shown: the list only when there is somebody on it (never in the demo). */
function effectiveKind(view: View, demo: boolean, roster: RosterPerson[] | null): View['kind'] {
  if (view.kind === 'roster' && (demo || !roster || roster.length === 0)) return 'keypad';
  return view.kind;
}

function secondsLeft(until: number | null, now: number): number {
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/** This tablet's name in the list of logins: the one set before, else one made from the browser. */
function deviceName(): string {
  const saved = readDevice().trim();
  if (saved) return saved;
  const auto = deviceNameFromUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  writeDevice(auto);
  return auto;
}

/**
 * Sign in. «Кто на смене?» — tiles with the names of the people who have a six-digit key
 * (GET /api/auth/roster, names and roles only); a tap opens a big keypad for that person's key.
 * Without a list (switched off, nobody yet) the keypad comes straight away. «Вход поддержки»
 * takes a long key (TECH-…, MGR-…, OWNER-…). The device name is filled in from the browser and
 * can be changed at the bottom. `#/login?key=…` prefills the key for QR links; nothing is sent
 * before «Войти». After too many wrong keys the HUB answers 429 and the screen counts down.
 * The demo HUB keeps its «Войти как …» buttons and four-digit keys.
 */
export function LoginPage({ next }: { next: string }) {
  const { login } = useAuth();
  const { demo } = useDemo();
  const { query } = useLocation();
  const linkKey = normalizeAccessKey(query.get('key') ?? '');
  const [roster, setRoster] = useState<RosterPerson[] | null>(null);
  const [view, setView] = useState<View>(() =>
    linkKey && !/^\d+$/.test(linkKey) ? { kind: 'support' } : linkKey ? { kind: 'keypad', person: null } : { kind: 'roster' },
  );
  const [key, setKey] = useState(linkKey);
  const [device, setDevice] = useState(deviceName);
  const [editDevice, setEditDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);

  // A link with ?key= may arrive while this page is already shown (logout → link): prefill then too.
  useEffect(() => {
    if (!linkKey) return;
    setKey(linkKey);
    setView(/^\d+$/.test(linkKey) ? { kind: 'keypad', person: null } : { kind: 'support' });
  }, [linkKey]);

  // The names: now, and again every little while — people added in the cabinet arrive by sync.
  useEffect(() => {
    if (demo) return;
    let alive = true;
    const load = () => void fetchRoster().then((people) => alive && people !== null && setRoster(people));
    load();
    const t = setInterval(load, ROSTER_REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [demo]);

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
  const locked = wait > 0;
  const digits = demo ? 4 : SHORT_KEY_LENGTH;

  const go = useCallback((v: View) => {
    setView(v);
    setKey('');
    setError(null);
    if (v.kind === 'support') setTimeout(() => input.current?.focus(), 0);
  }, []);

  const submit = async (candidate: string) => {
    if (busy || locked) return;
    const normalized = normalizeAccessKey(candidate);
    const kind = keyKindOf(normalized) ?? (demo && isDemoKeyShape(normalized) ? 'short' : null);
    if (!normalized) return setError('Введите ключ');
    if (!kind) return setError(/^\d+$/.test(normalized) ? `Ключ — ${digits} цифр` : LONG_HINT);
    setError(null);
    setBusy(true);
    try {
      const d = device.trim().slice(0, 120);
      writeDevice(d);
      await login(normalized, d || undefined);
      navigate(!next || next === '/login' ? '/' : next);
    } catch (err) {
      if (err instanceof HubRequestError && err.status === 429) {
        setNow(Date.now());
        setLockedUntil(Date.now() + (err.retryAfterMs ?? 30_000));
        setError(null);
        setKey('');
      } else if (err instanceof HubRequestError && err.status === 401) {
        setError(BAD_KEY);
        setShake((n) => n + 1);
        if (kind === 'short') setKey('');
      } else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const press = (digit: string) => {
    if (busy || locked) return;
    setError(null);
    const k = (/^\d*$/.test(key) ? key + digit : digit).slice(0, digits);
    setKey(k);
    // The last digit signs in at once: nothing else to press on a tablet.
    if (k.length === digits) void submit(k);
  };
  const erase = () => {
    setError(null);
    setKey((k) => k.slice(0, -1));
  };

  // A hardware keyboard works on the keypad too (a computer at the counter): digits, ⌫ and Enter.
  const keypadShown = effectiveKind(view, demo, roster) === 'keypad';
  const pressRef = useRef({ press, erase, submit: () => void submit(key) });
  pressRef.current = { press, erase, submit: () => void submit(key) };
  useEffect(() => {
    if (!keypadShown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (/^\d$/.test(e.key)) pressRef.current.press(e.key);
      else if (e.key === 'Backspace') pressRef.current.erase();
      else if (e.key === 'Enter') pressRef.current.submit();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keypadShown]);

  const people = roster ?? [];
  const showRoster = effectiveKind(view, demo, roster) === 'roster';
  // No list to pick from (still loading, switched off, nobody yet, or the demo): the keypad straight away.
  const effective: View = view.kind === 'roster' && !showRoster ? { kind: 'keypad', person: null } : view;

  const notices = (
    <>
      {locked && (
        <p className="field-error login-locked" role="alert">
          Слишком много попыток, подождите {wait} с.
        </p>
      )}
      {error && !locked && (
        <p className="field-error login-error" role="alert">
          {error}
        </p>
      )}
    </>
  );

  const deviceRow = !demo && (
    <div className="login-device">
      {editDevice ? (
        <Field label="Название устройства" hint="Видно в списке входов, чтобы отличать планшеты.">
          <input
            type="text"
            value={device}
            maxLength={120}
            autoComplete="off"
            autoFocus
            onChange={(e) => setDevice(e.target.value)}
            onBlur={() => {
              const d = device.trim() || deviceNameFromUserAgent(navigator.userAgent, navigator.maxTouchPoints ?? 0);
              setDevice(d);
              writeDevice(d);
              setEditDevice(false);
            }}
          />
        </Field>
      ) : (
        <p className="muted">
          Это устройство: {device}{' '}
          <button type="button" className="onboarding-link" onClick={() => setEditDevice(true)}>
            изменить
          </button>
        </p>
      )}
    </div>
  );

  if (showRoster) {
    return (
      <section className="page login-page">
        <header className="onboarding-head">
          <BrandMark className="onboarding-mark" />
          <h1 className="page-title">Кто на смене?</h1>
        </header>
        <ul className="roster" aria-label="Сотрудники">
          {people.map((p) => (
            <li key={p.id}>
              <button type="button" className="roster-tile" onClick={() => go({ kind: 'keypad', person: p })}>
                <span className="roster-avatar" aria-hidden="true">
                  {nameInitials(p.name)}
                </span>
                <span className="roster-name">{p.name}</span>
                <span className="roster-role">{rolesLabel(p.roles)}</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="login-links">
          <button type="button" className="onboarding-link" onClick={() => go({ kind: 'keypad', person: null })}>
            Меня нет в списке
          </button>
          <button type="button" className="onboarding-link" onClick={() => go({ kind: 'support' })}>
            Вход поддержки
          </button>
        </p>
        {deviceRow}
      </section>
    );
  }

  if (effective.kind === 'support') {
    const normalized = normalizeAccessKey(key);
    const onSubmit = (e: FormEvent) => {
      e.preventDefault();
      void submit(key);
    };
    return (
      <Page title="Вход поддержки" subtitle="Для управляющего и поддержки TS: длинный ключ из букв и цифр.">
        <form className="form login-form" onSubmit={onSubmit} autoComplete="off">
          <Field label="Длинный ключ" hint="Регистр и пробелы не важны — ключ подправится сам.">
            <input
              ref={input}
              className="login-key"
              data-kind="long"
              type="text"
              value={key}
              placeholder={LONG_PLACEHOLDER}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              maxLength={60}
              onChange={(e) => {
                setKey(e.target.value.toUpperCase());
                setError(null);
              }}
              onBlur={() => setKey(normalized)}
            />
          </Field>
          {notices}
          <div className="form-actions">
            <button type="submit" className="btn btn-primary login-submit" disabled={busy || locked || !normalized}>
              {busy ? 'Проверяем…' : locked ? `Подождите ${wait} с` : 'Войти'}
            </button>
            <button type="button" className="btn" onClick={() => go({ kind: 'roster' })}>
              Назад
            </button>
          </div>
        </form>
        <aside className="login-help">
          <p>
            При первом запуске TS без кабинета ключ поддержки записан в файл <code>first-run-keys.txt</code> рядом с базой данных.
          </p>
        </aside>
        {deviceRow}
      </Page>
    );
  }

  // The keypad: for the person picked, or anyone with a key.
  const person = effective.kind === 'keypad' ? effective.person : null;
  return (
    <section className="page login-page">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <h1 className="page-title">{person ? person.name : 'Вход по ключу'}</h1>
      </header>
      <form
        className="login-pad"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(key);
        }}
        autoComplete="off"
      >
        {person ? (
          <div className="login-person">
            <span className="roster-avatar roster-avatar-big" aria-hidden="true">
              {nameInitials(person.name)}
            </span>
            <span className="roster-role">{rolesLabel(person.roles)}</span>
          </div>
        ) : null}
        <p className="login-ask">
          {demo
            ? 'Демо: наберите ключ из 4 цифр или нажмите «Войти как …» ниже.'
            : person
              ? 'Введите свой ключ — 6 цифр'
              : 'Введите свой ключ — 6 цифр. Его выдаёт управляющий.'}
        </p>
        <div key={shake} className="keypad" data-shake={shake > 0 || undefined} role="group" aria-label="Цифровая клавиатура">
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
          <button type="submit" className="keypad-key keypad-enter" disabled={busy || locked || key.length !== digits} aria-label="Войти">
            {busy ? '…' : 'Войти'}
          </button>
        </div>
        {notices}
      </form>
      {!demo && (
        <p className="login-links">
          {people.length > 0 && (
            <button type="button" className="onboarding-link" onClick={() => go({ kind: 'roster' })}>
              ← Другой сотрудник
            </button>
          )}
          <button type="button" className="onboarding-link" onClick={() => go({ kind: 'support' })}>
            Вход поддержки
          </button>
        </p>
      )}
      <DemoKeys busy={busy || locked} onLogin={(k) => void submit(k)} />
      {deviceRow}
    </section>
  );
}
