import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { BrandMark } from '../BrandMark.tsx';
import { Field } from '../ui.tsx';
import type { NewTrial } from '../demo-hub/boot.ts';
import { restoreBackup, TRIAL_DAYS } from '../demo-hub/trial-store.ts';
import '../onboarding/onboarding.css';
import './trial.css';

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
          Запишите его. Код спросят при входе в кассу. Если забудете — он есть в полосе «Пробная версия» → «Код управляющего».
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
