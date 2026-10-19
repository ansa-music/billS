import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import QRCode from 'qrcode';
import type {
  ClubSummary,
  CreateOwnerKeyResponse,
  DevicePlatform,
  OwnerKeyView,
  PushKind,
  PushRule,
  PushSettingsView,
  TestPushResponse,
} from '@bills/domain';
import { PUSH_KINDS, pushRuleAllows } from '@bills/domain';
import {
  createOwnerKey,
  fetchOverview,
  fetchOwnerKeys,
  fetchPushSettings,
  removeDevice,
  revokeOwnerKey,
  sendTestPush,
  updatePushRules,
} from './api.ts';
import { formatDateTime } from './format.ts';
import { enablePhonePush, usePhonePushStatus } from './phonePush.ts';
import type { PhonePushStatus } from './phonePush.ts';
import { nativeBridge } from './platform.ts';
import { Section, loadingText } from './shared.tsx';

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  android: 'Android',
  ios: 'iPhone',
  web: 'Браузер',
};

function when(ms: number): string {
  return formatDateTime(ms, LOCAL_ZONE);
}

/** The «all clubs» value of a kind: its all-clubs rule, else the default. */
function allClubsValue(rules: PushRule[], kind: PushKind): boolean {
  const forAll = rules.find((r) => r.kind === kind && r.clubId === null);
  if (forAll) return forAll.enabled;
  return PUSH_KINDS.find((k) => k.kind === kind)?.defaultOn ?? false;
}

/** «All clubs» sets the kind for every club: the per-club rules of that kind go away. */
function toggleAll(rules: PushRule[], kind: PushKind): PushRule[] {
  const enabled = !allClubsValue(rules, kind);
  return [...rules.filter((r) => r.kind !== kind), { kind, clubId: null, enabled }];
}

/** A club rule that only repeats the all-clubs value is dropped, so the list stays short. */
function toggleClub(rules: PushRule[], kind: PushKind, clubId: string): PushRule[] {
  const enabled = !pushRuleAllows(rules, kind, clubId);
  const rest = rules.filter((r) => !(r.kind === kind && r.clubId === clubId));
  if (enabled === allClubsValue(rules, kind)) return rest;
  return [...rest, { kind, clubId, enabled }];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function RulesTable({
  rules,
  clubs,
  onChange,
  saving,
  error,
}: {
  rules: PushRule[];
  clubs: ClubSummary[];
  onChange: (next: PushRule[]) => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <Section
      title="Что присылать"
      aside={saving ? <span className="hint">Сохраняем…</span> : <span className="saved">Сохраняется сразу</span>}
    >
      <p className="hint">
        «Все клубы» задаёт вид уведомлений для всех клубов сразу; галочка в колонке клуба — своя настройка для этого
        клуба.
      </p>
      <div className="grid-wrap rules-wrap">
        <table className="grid rules-grid">
          <thead>
            <tr>
              <th className="rules-kind">Уведомление</th>
              <th className="rules-cell">Все клубы</th>
              {clubs.map((c) => (
                <th key={c.id} className="rules-cell" title={c.name}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PUSH_KINDS.map((k) => {
              const all = allClubsValue(rules, k.kind);
              return (
                <tr key={k.kind}>
                  <td className="rules-kind">{k.label}</td>
                  <td className="rules-cell">
                    <input
                      type="checkbox"
                      className="rules-check"
                      checked={all}
                      aria-label={`${k.label}: все клубы`}
                      onChange={() => onChange(toggleAll(rules, k.kind))}
                    />
                  </td>
                  {clubs.map((c) => {
                    const own = rules.some((r) => r.kind === k.kind && r.clubId === c.id);
                    return (
                      <td key={c.id} className="rules-cell" data-own={own || undefined}>
                        <input
                          type="checkbox"
                          className="rules-check"
                          checked={pushRuleAllows(rules, k.kind, c.id)}
                          aria-label={`${k.label}: ${c.name}`}
                          title={own ? 'Своя настройка клуба' : 'Как для всех клубов'}
                          onChange={() => onChange(toggleClub(rules, k.kind, c.id))}
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// This phone (app only)
// ---------------------------------------------------------------------------

function phoneStatusText(s: PhonePushStatus): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (s.state) {
    case 'on':
      return { text: 'Уведомления включены', tone: 'ok' };
    case 'pending':
      return { text: 'Включаем уведомления…', tone: 'muted' };
    case 'denied':
      return {
        text: 'Уведомления запрещены в настройках телефона. Разрешите их для приложения TS и нажмите «Включить уведомления».',
        tone: 'warn',
      };
    case 'unavailable':
      return { text: `Уведомления недоступны: ${s.message}`, tone: 'warn' };
    case 'error':
      return { text: `Не удалось зарегистрировать телефон в облаке: ${s.message}`, tone: 'warn' };
    case 'idle':
      return { text: 'Уведомления ещё не включены', tone: 'muted' };
  }
}

function ThisPhone() {
  const bridge = nativeBridge();
  const status = usePhonePushStatus();
  if (!bridge) return null;
  const { text, tone } = phoneStatusText(status);
  return (
    <Section title="Этот телефон">
      <p className="phone-status" data-tone={tone}>
        {text}
      </p>
      <div className="row wrap">
        <button
          type="button"
          className="btn btn-primary"
          disabled={status.state === 'pending'}
          onClick={() => void enablePhonePush()}
        >
          Включить уведомления
        </button>
      </div>
      <dl className="facts">
        <div>
          <dt>Адрес облака</dt>
          <dd className="break">{bridge.cloudUrl() ?? '—'}</dd>
        </div>
        <div>
          <dt>Телефон</dt>
          <dd>{bridge.deviceName()}</dd>
        </div>
        <div>
          <dt>Версия приложения</dt>
          <dd>{bridge.appVersion()}</dd>
        </div>
      </dl>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

function testResultText(r: TestPushResponse, devices: number): string {
  if (!r.pushEnabled) return 'Push-уведомления на облаке выключены — ничего не отправлено.';
  if (devices === 0 && r.sent === 0 && r.failed === 0) {
    return 'Нет устройств: войдите в приложение TS на телефоне и включите уведомления.';
  }
  return r.failed > 0 ? `Отправлено: ${r.sent}, не доставлено: ${r.failed}.` : `Отправлено: ${r.sent}.`;
}

function Devices({ settings, reload }: { settings: PushSettingsView; reload: () => Promise<void> }) {
  const bridge = nativeBridge();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string, name: string) {
    if (!confirm(`Удалить «${name}» из списка? На него перестанут приходить уведомления.`)) return;
    setBusy(id);
    setError(null);
    try {
      await removeDevice(id);
      if (bridge && bridge.deviceId() === id) await bridge.setDeviceId(null);
      await reload();
    } catch (e) {
      setError(`Не удалось удалить: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setError(null);
    setResult(null);
    try {
      const r = await sendTestPush();
      setResult(testResultText(r, settings.devices.length));
      await reload();
    } catch (e) {
      setError(`Не удалось отправить: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section title="Устройства">
      {settings.devices.length === 0 ? (
        <p className="empty">Пока ни одного телефона. Войдите в приложение TS на телефоне — он появится здесь.</p>
      ) : (
        <ul className="plain-list">
          {settings.devices.map((d) => (
            <li key={d.id} className="list-item">
              <div className="list-main">
                <strong>
                  {d.name || PLATFORM_LABEL[d.platform]}
                  {bridge?.deviceId() === d.id && <span className="tag tag-new">этот телефон</span>}
                </strong>
                <span className="hint">
                  {PLATFORM_LABEL[d.platform]} · добавлено {when(d.createdAt)}
                </span>
                {d.lastError && <span className="form-error">Последняя ошибка: {d.lastError}</span>}
              </div>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy !== null}
                onClick={() => void remove(d.id, d.name || PLATFORM_LABEL[d.platform])}
              >
                Удалить
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row wrap">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void test()}>
          {busy === 'test' ? 'Отправляем…' : 'Отправить тестовое уведомление'}
        </button>
      </div>
      {result && (
        <p className="saved" role="status">
          {result}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Owner keys
// ---------------------------------------------------------------------------

function QrImage({ text }: { text: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(text, { width: 640, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then((url) => {
        if (!cancelled) setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
  }, [text]);
  return (
    <div className="qr">{src ? <img src={src} alt="QR-код для входа с телефона" /> : <span className="hint">QR…</span>}</div>
  );
}

function NewKey({ created, onDone }: { created: CreateOwnerKeyResponse; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const keyRef = useRef<HTMLElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      // No clipboard (http, old browser): select the text so the owner copies it by hand.
      const el = keyRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
  }

  return (
    <div className="new-key">
      <p className="new-key-warn">
        <strong>Ключ показывается один раз.</strong> Отсканируйте QR приложением TS на телефоне или введите ключ
        вручную. Облако хранит только его отпечаток — потом ключ не посмотреть, можно только создать новый.
      </p>
      <QrImage text={created.qr} />
      <div className="key-line">
        <code ref={keyRef} className="key-text">
          {created.key}
        </code>
        <button type="button" className="btn btn-small" onClick={() => void copy()}>
          {copied ? 'Скопировано' : 'Скопировать'}
        </button>
      </div>
      <button type="button" className="btn" onClick={onDone}>
        Готово
      </button>
    </div>
  );
}

function Keys() {
  const [keys, setKeys] = useState<OwnerKeyView[] | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateOwnerKeyResponse | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(await fetchOwnerKeys());
      setLoadError(null);
    } catch (e) {
      setLoadError(e as Error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createOwnerKey(label.trim() || undefined);
      setCreated(res);
      setLabel('');
      await load();
    } catch (err) {
      setError(`Не удалось создать ключ: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: OwnerKeyView) {
    const name = k.label ? `${k.prefix} («${k.label}»)` : k.prefix;
    if (!confirm(`Отозвать ключ ${name}? Войти по нему больше не получится; телефоны, которые уже вошли, останутся в кабинете.`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await revokeOwnerKey(k.id);
      await load();
    } catch (err) {
      setError(`Не удалось отозвать: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Ключи для входа с телефона">
      <p className="hint">
        Ключ позволяет войти в приложение TS на телефоне без пароля: отсканируйте QR или введите ключ. Каждому телефону
        — свой ключ, чтобы потерянный можно было отозвать отдельно.
      </p>
      {created ? (
        <NewKey created={created} onDone={() => setCreated(null)} />
      ) : (
        <form className="row wrap key-form" onSubmit={create}>
          <label className="field grow">
            <span>Подпись (необязательно)</span>
            <input
              type="text"
              maxLength={80}
              placeholder="Например: телефон Айдара"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Создать ключ для телефона
          </button>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {keys === null ? (
        <p className="empty">{loadingText(loadError, 'ключи')}</p>
      ) : keys.length === 0 ? (
        <p className="empty">Ключей пока нет</p>
      ) : (
        <ul className="plain-list">
          {keys.map((k) => (
            <li key={k.id} className="list-item">
              <div className="list-main">
                <strong>
                  <code>{k.prefix}…</code>
                  {k.label && <span className="key-label">{k.label}</span>}
                </strong>
                <span className="hint">
                  создан {when(k.createdAt)} · {k.lastUsedAt ? `последний вход ${when(k.lastUsedAt)}` : 'входов не было'}
                </span>
              </div>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void revoke(k)}>
                Отозвать
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function Phone() {
  const [settings, setSettings] = useState<PushSettingsView | null>(null);
  const [clubs, setClubs] = useState<ClubSummary[]>([]);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  /** Rules as the cloud last confirmed them: the rollback point for a failed save. */
  const confirmed = useRef<PushRule[]>([]);
  const seq = useRef(0);
  const inFlight = useRef(0);

  const reload = useCallback(async () => {
    try {
      const next = await fetchPushSettings();
      // Devices and the FCM flag always refresh; rules only when no toggle is being saved.
      if (inFlight.current === 0) confirmed.current = next.rules;
      setSettings((s) => (inFlight.current > 0 && s ? { ...next, rules: s.rules } : next));
      setLoadError(null);
    } catch (e) {
      setLoadError(e as Error);
    }
  }, []);

  useEffect(() => {
    void reload();
    fetchOverview()
      .then((o) => setClubs(o.clubs))
      .catch(() => undefined); // without the club list the table shows only «Все клубы»
  }, [reload]);

  // This phone just registered (on start, after sign-in or by the button): show it in the device list.
  const phoneState = usePhonePushStatus().state;
  useEffect(() => {
    if (phoneState === 'on') void reload();
  }, [phoneState, reload]);

  /** Optimistic: the table changes at once, the full list goes to the cloud, a failure rolls back. */
  async function changeRules(next: PushRule[]) {
    if (!settings) return;
    const mine = ++seq.current;
    inFlight.current += 1;
    setSettings({ ...settings, rules: next });
    setSaving(true);
    setRulesError(null);
    try {
      const saved = await updatePushRules(next);
      confirmed.current = saved.rules;
      if (mine === seq.current) setSettings(saved);
    } catch (e) {
      if (mine === seq.current) {
        setSettings((s) => (s ? { ...s, rules: confirmed.current } : s));
        setRulesError(`Не удалось сохранить: ${(e as Error).message}`);
      }
    } finally {
      inFlight.current -= 1;
      if (inFlight.current === 0) setSaving(false);
    }
  }

  return (
    <main className="phone-page">
      <header className="club-page-head">
        <div>
          <a className="back" href="#/">
            ← Все клубы
          </a>
          <h2>Телефон и уведомления</h2>
        </div>
      </header>

      {settings === null ? (
        <p className="boot-inline">{loadingText(loadError, 'настройки уведомлений')}</p>
      ) : (
        <>
          {!settings.pushEnabled && (
            <p className="notice" role="status">
              Push-уведомления на облаке выключены: не задан ключ FCM. Правила сохраняются, но ничего не отправляется.
            </p>
          )}
          <ThisPhone />
          <RulesTable
            rules={settings.rules}
            clubs={clubs}
            onChange={(next) => void changeRules(next)}
            saving={saving}
            error={rulesError}
          />
          <Devices settings={settings} reload={reload} />
        </>
      )}
      <Keys />
    </main>
  );
}
