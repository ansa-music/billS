import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { HubSetupLampDriver, HubSetupRequest, HubSetupStatus } from '@bills/domain';
import { parseHubSetupCode } from '@bills/domain';
import { BrandMark } from '../BrandMark.tsx';
import { QrCode } from '../QrCode.tsx';
import { Field } from '../ui.tsx';
import { codeFromLocation, fetchSetupStatus, saveSetup, SetupError, setupErrorText, SIGNUP_URL, waitUntilConnected } from './setup.ts';
import './onboarding.css';

type Phase = 'form' | 'saving' | 'restarting' | 'done' | 'slow';

const LAMP_CHOICES: Array<{ value: HubSetupLampDriver; title: string; hint: string }> = [
  { value: 'simulator', title: 'Нет / пока не знаю', hint: 'Свет включают вручную. Подключить управление можно позже.' },
  { value: 'esp32-http', title: 'Плата ESP32', hint: 'Коробка с реле, которую ставит мастер по свету.' },
  { value: 'modbus-tcp', title: 'Модуль Modbus', hint: 'Промышленный модуль реле с сетевым кабелем.' },
];

/**
 * «Подключите кассу к кабинету»: the first screen of a fresh club HUB. Three steps — register in
 * the cabinet (link + QR), paste the connection code, press «Подключить» — then a wait while the
 * HUB restarts with the cloud (POST /api/setup, see setup.ts), then «Готово!» and the login.
 * The lamp controller hides under a closed «Есть управление светом над столами?».
 */
export function ConnectPage({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [code, setCode] = useState(() => codeFromLocation());
  const [touched, setTouched] = useState(() => code !== '');
  const [status, setStatus] = useState<HubSetupStatus | null>(null);
  const [driver, setDriver] = useState<HubSetupLampDriver>('simulator');
  const [esp32Host, setEsp32Host] = useState('');
  const [esp32Token, setEsp32Token] = useState('');
  const [modbusHost, setModbusHost] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<SetupError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  // The code arrived in the address (#code=…): take it, then clean the address so it is not left on screen.
  useEffect(() => {
    if (codeFromLocation()) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`);
    void fetchSetupStatus().then(setStatus);
    return () => abort.current?.abort();
  }, []);

  const parsed = parseHubSetupCode(code);
  const codeProblem = code.trim() === '' ? null : parsed.ok ? null : parsed.message;
  const lampsPreset = status?.lampsPreset ?? null;

  const waitForRestart = async () => {
    setPhase('restarting');
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    const ok = await waitUntilConnected(ctl.signal);
    if (!ctl.signal.aborted) setPhase(ok ? 'done' : 'slow');
  };

  const connect = async (skipCheck = false, e?: FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (phase === 'saving') return;
    if (!parsed.ok) {
      setError(new SetupError(422, 'SETUP_INVALID', code.trim() ? parsed.message : 'Вставьте код подключения из кабинета', false, 'code'));
      return;
    }
    const body: HubSetupRequest = { code: code.trim(), skipCheck };
    if (!lampsPreset) {
      body.lamps =
        driver === 'esp32-http'
          ? { driver, esp32Host: esp32Host.trim(), ...(esp32Token.trim() ? { esp32Token: esp32Token.trim() } : {}) }
          : driver === 'modbus-tcp'
            ? { driver, modbusHost: modbusHost.trim() }
            : { driver: 'simulator' };
    }
    setError(null);
    setPhase('saving');
    try {
      const res = await saveSetup(body);
      setWarning(res.checked ? null : 'Связь с кабинетом проверим позже: касса подключится сама, как только у этого компьютера появится интернет.');
      await waitForRestart();
    } catch (err) {
      const se = err instanceof SetupError ? err : new SetupError(0, 'ERROR', (err as Error).message);
      // Someone (another tab) has just connected it: wait for the restart like after our own save.
      if (se.code === 'SETUP_DONE') return void waitForRestart();
      setError(se);
      setPhase('form');
    }
  };

  if (phase === 'restarting' || phase === 'done' || phase === 'slow') {
    return (
      <section className="page onboarding" aria-live="polite">
        <header className="onboarding-head">
          <BrandMark className="onboarding-mark" />
          <h1 className="page-title">
            {phase === 'done' ? 'Готово! Касса подключена' : phase === 'slow' ? 'Касса ещё перезапускается' : 'Подключаем кассу…'}
          </h1>
        </header>
        {phase === 'restarting' && (
          <div className="onboarding-card onboarding-wait">
            <span className="onboarding-spinner" aria-hidden="true" />
            <p>Программа TS перезапускается, чтобы связаться с кабинетом. Это займёт до минуты — ничего не нажимайте.</p>
          </div>
        )}
        {phase === 'slow' && (
          <div className="onboarding-card">
            <p>
              Код сохранён, но программа TS ещё не ответила. Если она не запустилась сама, включите компьютер с TS заново или запустите
              TS ещё раз, затем нажмите «Проверить ещё раз».
            </p>
            <div className="onboarding-actions">
              <button type="button" className="btn btn-primary btn-large" onClick={() => void waitForRestart()}>
                Проверить ещё раз
              </button>
            </div>
          </div>
        )}
        {phase === 'done' && (
          <div className="onboarding-card onboarding-done">
            <p className="onboarding-big">Войдите своим ключом из кабинета.</p>
            <p>
              Ключ из 6 цифр показан в кабинете на шаге «Войдите в кассу». Сотрудники появятся здесь сами через минуту после того, как вы
              добавите их в кабинете.
            </p>
            {warning && <p className="onboarding-note">{warning}</p>}
            <div className="onboarding-actions">
              <button type="button" className="btn btn-primary btn-large" onClick={onDone}>
                Войти
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  const saving = phase === 'saving';
  const fieldError = error?.field === 'code' ? setupErrorText(error) : touched ? codeProblem : null;
  const otherError = error && error.field !== 'code' ? setupErrorText(error) : null;

  return (
    <section className="page onboarding">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Подключите кассу к кабинету</h1>
          <p className="page-lead">Это нужно один раз. Займёт пару минут.</p>
        </div>
      </header>

      <form className="onboarding-steps" onSubmit={(e) => void connect(false, e)} autoComplete="off">
        <ol className="onboarding-list">
          <li className="onboarding-card onboarding-step">
            <div className="onboarding-step-body">
              <h2>
                <span className="onboarding-num" aria-hidden="true">
                  1
                </span>
                Зарегистрируйтесь в кабинете
              </h2>
              <p>Откройте кабинет TS на телефоне или компьютере и создайте своё заведение — это бесплатно.</p>
              <p className="muted">Уже есть кабинет — пропустите этот шаг.</p>
              <a className="btn" href={SIGNUP_URL} target="_blank" rel="noreferrer">
                Открыть кабинет
              </a>
            </div>
            <figure className="onboarding-qr">
              <QrCode value={SIGNUP_URL} size={128} label="QR-код: регистрация в кабинете TS" />
              <figcaption>Наведите камеру телефона</figcaption>
            </figure>
          </li>

          <li className="onboarding-card onboarding-step">
            <div className="onboarding-step-body">
              <h2>
                <span className="onboarding-num" aria-hidden="true">
                  2
                </span>
                Вставьте код подключения
              </h2>
              <Field
                label="Код подключения"
                error={fieldError}
                hint={parsed.ok ? '✓ Код распознан' : 'В кабинете на шаге «Вставьте код подключения» нажмите «Скопировать» и вставьте сюда.'}
              >
                <textarea
                  className="onboarding-code"
                  value={code}
                  rows={3}
                  placeholder="TS1.…"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-invalid={fieldError ? true : undefined}
                  disabled={saving}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setError(null);
                  }}
                  onBlur={() => setTouched(true)}
                />
              </Field>
            </div>
          </li>

          <li className="onboarding-card onboarding-step">
            <div className="onboarding-step-body">
              <h2>
                <span className="onboarding-num" aria-hidden="true">
                  3
                </span>
                Нажмите «Подключить»
              </h2>
              {!lampsPreset && (
                <details className="onboarding-lamps">
                  <summary>Есть управление светом над столами? (только для бильярда)</summary>
                  <div className="onboarding-lamp-choices" role="radiogroup" aria-label="Управление светом">
                    {LAMP_CHOICES.map((c) => (
                      <label key={c.value} className="onboarding-choice">
                        <input
                          type="radio"
                          name="lamps"
                          value={c.value}
                          checked={driver === c.value}
                          disabled={saving}
                          onChange={() => setDriver(c.value)}
                        />
                        <span>
                          <strong>{c.title}</strong>
                          <span className="muted">{c.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  {driver === 'esp32-http' && (
                    <div className="form-row">
                      <Field label="Адрес платы" hint="Написан на коробке или в инструкции, например 192.168.1.50">
                        <input value={esp32Host} placeholder="192.168.1.50" disabled={saving} onChange={(e) => setEsp32Host(e.target.value)} />
                      </Field>
                      <Field label="Пароль платы" hint="Если есть">
                        <input value={esp32Token} disabled={saving} onChange={(e) => setEsp32Token(e.target.value)} />
                      </Field>
                    </div>
                  )}
                  {driver === 'modbus-tcp' && (
                    <Field label="Адрес модуля" hint="Например 192.168.1.60">
                      <input value={modbusHost} placeholder="192.168.1.60" disabled={saving} onChange={(e) => setModbusHost(e.target.value)} />
                    </Field>
                  )}
                </details>
              )}
              {otherError && (
                <div className="onboarding-error" role="alert">
                  <p>{otherError}</p>
                  {error?.canSkip && (
                    <>
                      <p className="muted">
                        Нет интернета прямо сейчас? Можно сохранить код без проверки — касса подключится к кабинету сама, когда интернет
                        появится.
                      </p>
                      <button type="button" className="btn" disabled={saving} onClick={() => void connect(true)}>
                        Сохранить без проверки
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="onboarding-actions">
                <button type="submit" className="btn btn-primary btn-large" disabled={saving}>
                  {saving ? 'Проверяем код…' : 'Подключить'}
                </button>
              </div>
            </div>
          </li>
        </ol>
      </form>

      <p className="onboarding-foot muted">
        <button type="button" className="onboarding-link" onClick={onSkip}>
          Войти без подключения (поддержка TS)
        </button>
      </p>
    </section>
  );
}
