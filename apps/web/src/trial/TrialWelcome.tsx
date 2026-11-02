import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { BrandMark } from '../BrandMark.tsx';
import { Field } from '../ui.tsx';
import type { NewTrial } from '../demo-hub/boot.ts';
import { formatTransferCode, normalizeTransferCode } from '@bills/domain';
import { restoreBackup, TRIAL_DAYS } from '../demo-hub/trial-store.ts';
import { openByTransferCode, TRIAL_CLOUD_URL } from '../demo-hub/trial-cloud.ts';
import '../onboarding/onboarding.css';
import './trial.css';

/** `#transfer=7K3MQ9TX` (the QR of «Код переноса»): the code to fill in, or null. */
export function transferCodeFromHash(hash: string): string | null {
  const m = /[#&]transfer=([A-Za-z0-9-]+)/.exec(hash);
  return m ? normalizeTransferCode(m[1]!) : null;
}

/**
 * «Уже работаете в TS?»: the code from the old device → the cloud gives the latest copy, the
 * coffee shop opens here with all its data, and the old device stops taking orders.
 */
export function TrialTransfer({ initial, onBack }: { initial: string; onBack: () => void }) {
  const [code, setCode] = useState(initial ? formatTransferCode(initial) : '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const norm = normalizeTransferCode(code);
    if (!norm) {
      setError('Код — 8 знаков, например 7K3M-Q9TX');
      return;
    }
    setBusy(true);
    setError(null);
    openByTransferCode(norm)
      .then((r) => setDone(r.venue))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Не получилось открыть по коду'))
      .finally(() => setBusy(false));
  };

  if (done !== null) {
    return (
      <section className="page onboarding trial-welcome">
        <header className="onboarding-head">
          <BrandMark className="onboarding-mark" />
          <div>
            <h1 className="page-title">«{done}» открыта на этом устройстве</h1>
            <p className="page-lead">Все данные на месте. Войдите своим кодом, как раньше. На старом устройстве касса теперь только для просмотра.</p>
          </div>
        </header>
        <div className="onboarding-actions">
          <button
            type="button"
            className="btn btn-primary btn-large"
            onClick={() => {
              history.replaceState(null, '', window.location.pathname + window.location.search);
              window.location.reload();
            }}
          >
            Перейти ко входу
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Открыть по коду переноса</h1>
          <p className="page-lead">На старом устройстве: внизу меню «Пробная» (или «Настройки» → «Облако и перенос») → «Получить код переноса».</p>
        </div>
      </header>
      <form className="onboarding-card trial-form" onSubmit={submit} autoComplete="off" noValidate>
        <Field label="Код переноса" error={error}>
          <input
            className="trial-code-input"
            value={code}
            maxLength={12}
            placeholder="7K3M-Q9TX"
            autoFocus
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError(null);
            }}
          />
        </Field>
        <div className="onboarding-actions">
          <button type="submit" className="btn btn-primary btn-large" disabled={busy}>
            {busy ? 'Открываем…' : 'Открыть кофейню'}
          </button>
        </div>
        <p className="onboarding-note">Код действует 24 часа. После переноса касса работает здесь, а на старом устройстве данные можно только смотреть.</p>
      </form>
      <p className="onboarding-foot">
        <button type="button" className="onboarding-link" onClick={onBack}>
          Назад
        </button>
      </p>
    </section>
  );
}

/**
 * First visit of the browser trial: two fields and one button. The coffee shop is created in
 * this browser, then «Готово» shows the manager's six-digit key once, big, to write down.
 * «Уже пробовали на другом устройстве?» restores a «Скачать копию» file instead.
 */
export function TrialWelcome({ onStart, onRestored }: { onStart: (t: NewTrial) => void; onRestored: () => void }) {
  const [venue, setVenue] = useState('');
  const [managerName, setManagerName] = useState('');
  const [withMenu, setWithMenu] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const fromQr = transferCodeFromHash(window.location.hash);
  const [transfer, setTransfer] = useState<string | null>(TRIAL_CLOUD_URL && fromQr ? fromQr : null);
  if (transfer !== null) return <TrialTransfer initial={transfer} onBack={() => setTransfer(null)} />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!venue.trim()) {
      setError('Напишите название кофейни');
      return;
    }
    onStart({ venue: venue.trim(), managerName: managerName.trim(), withMenu });
  };

  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">TS для кофейни — {TRIAL_DAYS} дней бесплатно</h1>
          <p className="page-lead">Касса, экран бариста и отчёты прямо в браузере. Ничего не нужно устанавливать.</p>
        </div>
      </header>

      <form className="onboarding-card trial-form" onSubmit={submit} autoComplete="off" noValidate>
        <Field label="Название кофейни" error={error}>
          <input
            value={venue}
            maxLength={80}
            placeholder="Например: Кофейня «Утро»"
            autoFocus
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setVenue(e.target.value);
              setError(null);
            }}
          />
        </Field>
        <Field label="Ваше имя" hint="Так вас будет видно в журнале и отчётах.">
          <input value={managerName} maxLength={80} placeholder="Например: Айгерим" onChange={(e) => setManagerName(e.target.value)} />
        </Field>
        <label className="trial-check">
          <input type="checkbox" checked={withMenu} onChange={(e) => setWithMenu(e.target.checked)} />
          <span>
            <strong>Заполнить меню примером</strong>
            <span className="muted">Кофе с размерами и молоком, чай, выпечка — цены потом поправите в «Меню».</span>
          </span>
        </label>
        <div className="onboarding-actions">
          <button type="submit" className="btn btn-primary btn-large">
            Начать пробный период
          </button>
        </div>
        <p className="onboarding-note">
          Всё хранится в этом браузере на этом устройстве. Работайте с одного компьютера или планшета и раз в несколько дней нажимайте «Скачать копию».
        </p>
      </form>

      {TRIAL_CLOUD_URL && (
        <p className="onboarding-foot">
          Уже работаете в TS?{' '}
          <button type="button" className="onboarding-link" onClick={() => setTransfer('')}>
            Открыть по коду переноса
          </button>
        </p>
      )}
      <p className="onboarding-foot">
        Уже пробовали на другом устройстве?{' '}
        <button type="button" className="onboarding-link" onClick={() => file.current?.click()}>
          Восстановить из копии
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            restoreBackup(f)
              .then(onRestored)
              .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Не удалось прочитать копию'));
          }}
        />
      </p>
    </section>
  );
}

/** «Готово»: the manager's key, once, big. */
export function TrialReady({ venue, managerKey, onContinue }: { venue: string; managerKey: string; onContinue: () => void }) {
  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">Готово! «{venue}» создана</h1>
          <p className="page-lead">Пробный период — {TRIAL_DAYS} дней, с сегодняшнего дня.</p>
        </div>
      </header>
      <div className="onboarding-card onboarding-done">
        <p>Ваш код входа (управляющий):</p>
        <p className="trial-key" aria-label={`Код входа ${managerKey.split('').join(' ')}`}>
          {managerKey.slice(0, 3)} {managerKey.slice(3)}
        </p>
        <p className="onboarding-note">
          Запишите его. Код спросят при входе в кассу. Если забудете — внизу меню нажмите «Пробная» → «Код управляющего».
        </p>
        <ol className="trial-next">
          <li>Войдите с этим кодом.</li>
          <li>«Смена» → «Открыть смену» и принимайте заказы на «Кассе».</li>
          <li>Сотрудников добавьте в «Сотрудники» — каждый получит свой код.</li>
        </ol>
        <div className="onboarding-actions">
          <button type="button" className="btn btn-primary btn-large" onClick={onContinue}>
            Перейти ко входу
          </button>
        </div>
      </div>
    </section>
  );
}

/** Another tab of this browser already runs the trial: two in-page HUBs would overwrite each other. */
export function TrialBusy() {
  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">TS уже открыт в другой вкладке</h1>
          <p className="page-lead">Пробная версия работает в одной вкладке браузера. Закройте эту и вернитесь в ту, или закройте ту и обновите эту страницу.</p>
        </div>
      </header>
      <div className="onboarding-actions">
        <button type="button" className="btn btn-primary btn-large" onClick={() => window.location.reload()}>
          Обновить страницу
        </button>
      </div>
    </section>
  );
}
