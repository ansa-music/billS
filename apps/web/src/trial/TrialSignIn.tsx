import { useEffect, useReducer, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { MoveEvent, TrialMoveFinish } from '@bills/domain';
import { formatCafeCodeInput, linkFromHash, linkHash, MOVE_START, moveReducer, normalizeCafeCode, TRIAL_MOVE } from '@bills/domain';
import { BrandMark } from '../BrandMark.tsx';
import { Field } from '../ui.tsx';
import { MOVE_AVAILABLE, MoveHttpError, moveCheckCall, moveFinishCall, moveStartCall, saveMovedTrial } from '../demo-hub/trial-move.ts';
import { restoreBackup, TRIAL_DAYS } from '../demo-hub/trial-store.ts';
import '../onboarding/onboarding.css';
import './trial.css';
import './trial-move.css';

/**
 * The first screen of a browser that has no coffee shop yet (VITE_TRIAL=1): «Новая кофейня — 14 дней
 * бесплатно» or «У меня уже есть TS — войти» — someone who already has a café is never steered into making
 * a second, empty one. «Войти» offers, in plain words: move the cash desk here (the café code,
 * demo-hub/trial-move.ts), work together with the cash desk (a device link, «Подключить устройство»),
 * or restore a «Скачать копию» file.
 */

export type TrialEntryMode = 'choose' | 'new' | 'signin';

/** TrialWelcome.tsx shows this until «Новая кофейня» is chosen. */
export function TrialEntry({ mode, onMode, onRestored }: { mode: 'choose' | 'signin'; onMode: (m: TrialEntryMode) => void; onRestored: () => void }) {
  if (mode === 'signin') return <TrialSignIn onBack={() => onMode('choose')} onDone={onRestored} />;
  return <TrialChoice onNew={() => onMode('new')} onSignIn={() => onMode('signin')} />;
}

function Screen({ title, lead, children, onBack }: { title: string; lead?: ReactNode; children: ReactNode; onBack?: () => void }) {
  return (
    <section className="page onboarding trial-welcome">
      <header className="onboarding-head">
        <BrandMark className="onboarding-mark" />
        <div>
          <h1 className="page-title">{title}</h1>
          {lead && <p className="page-lead">{lead}</p>}
        </div>
      </header>
      {children}
      {onBack && (
        <p className="onboarding-foot">
          <button type="button" className="onboarding-link" onClick={onBack}>
            ← Назад
          </button>
        </p>
      )}
    </section>
  );
}

function TrialChoice({ onNew, onSignIn }: { onNew: () => void; onSignIn: () => void }) {
  return (
    <Screen title="TS для кофейни" lead="Касса, экран бариста и отчёты прямо в браузере. Ничего не нужно устанавливать.">
      <div className="trial-choice">
        <button type="button" className="trial-choice-card" data-kind="new" onClick={onNew}>
          <strong>Новая кофейня — {TRIAL_DAYS} дней бесплатно</strong>
          <span>Первый раз в TS: название кофейни, ваше имя — и можно принимать заказы.</span>
        </button>
        <button type="button" className="trial-choice-card" data-kind="signin" onClick={onSignIn}>
          <strong>У меня уже есть TS — войти</strong>
          <span>Кофейня уже работает на другом компьютере: перенести кассу сюда или работать вместе с ней.</span>
        </button>
      </div>
      <p className="onboarding-note trial-choice-note">
        Уже вводили название кофейни на другом компьютере? Выберите «У меня уже есть TS» — иначе получится вторая, пустая кофейня.
      </p>
    </Screen>
  );
}

type Way = 'move' | 'together' | 'restore';

function TrialSignIn({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [way, setWay] = useState<Way | null>(null);
  const [moved, setMoved] = useState(false);
  if (way === 'move') {
    return (
      <Screen
        title="Перенести кассу на этот компьютер"
        lead="Этот компьютер станет кассой, а старый перестанет принимать заказы."
        {...(moved ? {} : { onBack: () => setWay(null) })}
      >
        <TrialMoveIn onDone={onDone} onFinished={() => setMoved(true)} />
      </Screen>
    );
  }
  if (way === 'together') {
    return (
      <Screen title="Работать вместе с кассой" lead="Касса остаётся на старом компьютере, а этот подключается к ней — как планшет сотрудника." onBack={() => setWay(null)}>
        <TrialTogether />
      </Screen>
    );
  }
  if (way === 'restore') {
    return (
      <Screen title="Восстановить из копии" lead="Если на старом компьютере нажимали «Скачать копию», а сам он больше не работает." onBack={() => setWay(null)}>
        <TrialRestore onDone={onDone} />
      </Screen>
    );
  }
  return (
    <Screen title="Войти в свою кофейню" lead="Данные кофейни хранятся на компьютере, где работает касса. Как вы хотите работать здесь?" onBack={onBack}>
      <div className="trial-choice trial-ways">
        <button type="button" className="trial-choice-card" data-kind="signin" onClick={() => setWay('move')}>
          <strong>Перенести кассу на этот компьютер</strong>
          <span>Касса будет здесь, старый компьютер перестанет принимать заказы. Понадобится код кофейни.</span>
        </button>
        <button type="button" className="trial-choice-card" onClick={() => setWay('together')}>
          <strong>Работать вместе с кассой</strong>
          <span>Старый компьютер остаётся кассой, этот подключается к нему — как планшет сотрудника.</span>
        </button>
        <button type="button" className="trial-choice-card" onClick={() => setWay('restore')}>
          <strong>Восстановить из копии</strong>
          <span>Есть файл «Скачать копию», а старого компьютера больше нет.</span>
        </button>
      </div>
    </Screen>
  );
}

/** «Работать вместе с кассой»: the two steps, and a field for a link that came by WhatsApp or e-mail. */
function TrialTogether() {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const open = (e: FormEvent) => {
    e.preventDefault();
    const at = text.indexOf('#/link/');
    const target = at >= 0 ? linkFromHash(text.slice(at).trim()) : null;
    if (!target) {
      setError('Это не ссылка с кассы. Скопируйте её целиком: на кассе «Подключить устройство» → «Скопировать ссылку».');
      return;
    }
    // main.tsx sees the new address and opens this page as a device of that cash desk.
    window.location.hash = linkHash(target.secret, target.view);
  };
  return (
    <div className="onboarding-card trial-form">
      <ol className="trial-move-steps">
        <li>
          <strong>На кассе</strong> (старом компьютере) войдите кодом директора или управляющего и нажмите внизу меню <strong>«Пробная» → «Подключить устройство»</strong>.
        </li>
        <li>
          Нажмите <strong>«Скопировать ссылку»</strong> или <strong>«Отправить в WhatsApp»</strong> и откройте эту ссылку <strong>здесь</strong>, на этом компьютере (например, в WhatsApp на компьютере). Или вставьте её сюда:
        </li>
      </ol>
      <form className="trial-watch-link" onSubmit={open} noValidate autoComplete="off">
        <input
          value={text}
          placeholder="Ссылка с кассы"
          aria-label="Ссылка с кассы"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
        />
        <button type="submit" className="btn">
          Открыть
        </button>
      </form>
      {error && (
        <p className="trial-watch-error" role="alert">
          {error}
        </p>
      )}
      <p className="onboarding-note">Здесь входят своим кодом. Касса должна оставаться открытой: этот компьютер работает через неё и сам данные не хранит.</p>
    </div>
  );
}

function TrialRestore({ onDone }: { onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="onboarding-card trial-form">
      <p>Выберите файл «….ts-backup.json», который скачали на старом компьютере («Пробная» → «Скачать копию»).</p>
      <p className="onboarding-note">Если старый компьютер ещё работает, лучше «Перенести кассу на этот компьютер»: так данные будут самые свежие и не получится двух касс.</p>
      <div className="onboarding-actions">
        <button type="button" className="btn btn-primary btn-large" onClick={() => file.current?.click()}>
          Выбрать файл копии
        </button>
      </div>
      {error && (
        <p className="trial-watch-error" role="alert">
          {error}
        </p>
      )}
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          restoreBackup(f)
            .then(onDone)
            .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Не удалось прочитать копию'));
        }}
      />
    </div>
  );
}

/** «14:32» today, «2 ноября, 14:32» another day. */
export function moveTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  return new Date(now).toDateString() === d.toDateString()
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

function failed(err: unknown): MoveEvent {
  return err instanceof MoveHttpError ? { type: 'failed', code: err.code, message: err.message } : { type: 'failed', code: 'ERROR', message: '' };
}

/**
 * The move itself (on the welcome screen, and on a cash desk that was moved away — «Вернуть кассу сюда»,
 * `replacing`): the café code → wait for the old cash desk's fresh copy (or agree to the older one) →
 * this computer becomes the cash desk → «Перейти ко входу» (the page reloads into the café).
 */
export function TrialMoveIn({ onDone, replacing = false, onFinished }: { onDone: () => void; replacing?: boolean; onFinished?: () => void }) {
  const [s, dispatch] = useReducer(moveReducer, MOVE_START);
  // The computer the cash desk leaves: «старый» on a new computer, «другой» when it comes back to an old one.
  const away = replacing
    ? { is: 'другой компьютер', from: 'с другого компьютера', on: 'на другом компьютере' }
    : { is: 'старый компьютер', from: 'со старого компьютера', on: 'на старом компьютере' };
  const [code, setCode] = useState('');
  const [typoError, setTypoError] = useState<string | null>(null);
  // The cloud's last answer is hidden as soon as the person corrects the code.
  const [editing, setEditing] = useState(false);
  const [saveError, setSaveError] = useState<TrialMoveFinish | null>(null);
  const typed = useRef('');
  const finishing = useRef<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const norm = normalizeCafeCode(code);
    if (!norm) {
      setTypoError('В коде кофейни 12 букв и цифр, например K7F3-92QX-M4P8.');
      return;
    }
    typed.current = norm;
    setEditing(false);
    dispatch({ type: 'submit' });
    moveStartCall(norm).then(
      (answer) => dispatch({ type: 'started', answer, now: Date.now() }),
      (err: unknown) => dispatch(failed(err)),
    );
  };

  // Waiting for the fresh copy: ask every 3 s, and watch the clock (a lost answer is just asked again).
  const waitingTicket = s.step === 'waiting' ? s.ticket : null;
  useEffect(() => {
    if (!waitingTicket) return;
    let stop = false;
    const poll = () =>
      moveCheckCall(waitingTicket).then(
        (state) => {
          if (!stop) dispatch({ type: 'polled', state, now: Date.now() });
        },
        (err: unknown) => {
          if (!stop && !(err instanceof MoveHttpError && err.status === 0)) dispatch(failed(err));
        },
      );
    const p = setInterval(() => void poll(), TRIAL_MOVE.pollEveryMs);
    const c = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 1000);
    return () => {
      stop = true;
      clearInterval(p);
      clearInterval(c);
    };
  }, [waitingTicket]);

  const save = (f: TrialMoveFinish) =>
    saveMovedTrial(f, typed.current).then(
      () => {
        setSaveError(null);
        dispatch({ type: 'finished', snapshotAt: f.snapshotAt });
        onFinished?.();
      },
      // The cloud already made this computer the cash desk: keep the café in memory and let the person try again.
      () => setSaveError(f),
    );

  // Taking over: once per ticket (a ticket finishes once; StrictMode runs effects twice).
  useEffect(() => {
    if (s.step !== 'moving' || finishing.current === s.ticket) return;
    finishing.current = s.ticket;
    moveFinishCall(s.ticket, s.acceptOlder).then(save, (err: unknown) => dispatch(failed(err)));
  }, [s]);

  if (saveError) {
    return (
      <div className="onboarding-card trial-form">
        <p className="trial-watch-error" role="alert">
          Касса уже перенесена сюда, но браузер не сохранил данные. Не закрывайте эту страницу и нажмите «Сохранить ещё раз». Если не помогает — освободите место на диске или откройте TS в Chrome или Edge (не в режиме «инкогнито»).
        </p>
        <div className="onboarding-actions">
          <button type="button" className="btn btn-primary btn-large" onClick={() => void save(saveError)}>
            Сохранить ещё раз
          </button>
        </div>
      </div>
    );
  }

  switch (s.step) {
    case 'code':
    case 'checking': {
      const error = typoError ?? (s.step === 'code' && !editing ? s.error : null);
      return (
        <form className="onboarding-card trial-form" onSubmit={submit} autoComplete="off" noValidate>
          {!MOVE_AVAILABLE && <p className="trial-watch-error">В этой версии нет связи с TS. Перенесите данные через «Скачать копию» и «Восстановить из копии».</p>}
          {replacing && (
            <p className="trial-move-warn">Данные этого компьютера заменятся данными кассы. Если здесь есть что-то важное, сначала нажмите «Скачать копию».</p>
          )}
          <Field
            label="Код кофейни"
            error={error}
            hint="12 букв и цифр. Он виден на компьютере, где сейчас касса: внизу меню «Пробная» → «Код кофейни» (его видят директор и управляющий)."
          >
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
              // Read-only, not disabled, while checking: the field keeps the focus for a correction.
              readOnly={s.step === 'checking'}
              onChange={(e) => {
                setCode(formatCafeCodeInput(e.target.value));
                setTypoError(null);
                setEditing(true);
              }}
            />
          </Field>
          <div className="onboarding-actions">
            <button type="submit" className="btn btn-primary btn-large" disabled={s.step === 'checking' || !MOVE_AVAILABLE}>
              {s.step === 'checking' ? 'Проверяем код…' : 'Продолжить'}
            </button>
          </div>
          <p className="onboarding-note">
            После переноса войдите своим кодом — тем же, что и раньше. Заявку на пробную версию ещё не подтвердили? Тогда кода кофейни пока
            нет — дождитесь подтверждения на компьютере, где отправляли заявку.
          </p>
        </form>
      );
    }
    case 'waiting':
      return (
        <div className="onboarding-card onboarding-wait trial-form" aria-live="polite">
          <p>
            <strong>«{s.venue}»</strong> — код подошёл.
          </p>
          <div className="onboarding-spinner" aria-hidden="true" />
          <p>
            Получаем свежие данные {away.from}… Обычно это до минуты. Не закрывайте TS {away.on}.
          </p>
          {s.snapshotAt !== null && (
            <div className="onboarding-actions">
              <button type="button" className="btn btn-ghost" onClick={() => dispatch({ type: 'stopWaiting' })}>
                Не ждать — перенести данные на {moveTime(s.snapshotAt)}
              </button>
            </div>
          )}
        </div>
      );
    case 'older':
      return (
        <div className="onboarding-card trial-form">
          <p>
            <strong>«{s.venue}»</strong> — {away.is} {s.reason === 'offline' ? 'сейчас не на связи с TS.' : 'не ответил.'}
          </p>
          <p className="trial-move-warn">
            Перенесём данные на <strong>{moveTime(s.snapshotAt)}</strong> — если {away.on} что-то делали позже, это не перенесётся.
          </p>
          <div className="onboarding-actions">
            <button type="button" className="btn btn-primary btn-large" onClick={() => dispatch({ type: 'confirmOlder' })}>
              Перенести данные на {moveTime(s.snapshotAt)}
            </button>
          </div>
          <p className="onboarding-note">
            Чтобы перенести всё до последнего заказа: откройте TS {away.on} с интернетом, там «Пробная» → «Перенести кассу на другой компьютер», и введите код здесь ещё раз.
          </p>
          <p className="onboarding-foot">
            <button type="button" className="onboarding-link" onClick={() => dispatch({ type: 'back' })}>
              Ввести код ещё раз
            </button>
          </p>
        </div>
      );
    case 'empty':
      return (
        <div className="onboarding-card trial-form">
          <p>
            {s.venue ? <strong>«{s.venue}»: </strong> : null}
            {away.is} ещё не отправлял данные в TS — переносить пока нечего.
          </p>
          <p className="onboarding-note">
            Откройте TS {away.on} с интернетом и нажмите там «Пробная» → «Перенести кассу на другой компьютер», затем введите код здесь ещё раз. Или «Скачать копию» там и «Восстановить из копии» здесь.
          </p>
          <div className="onboarding-actions">
            <button type="button" className="btn btn-primary" onClick={() => dispatch({ type: 'back' })}>
              Ввести код ещё раз
            </button>
          </div>
        </div>
      );
    case 'moving':
      return (
        <div className="onboarding-card onboarding-wait trial-form" aria-live="polite">
          <div className="onboarding-spinner" aria-hidden="true" />
          <p>Переносим кассу «{s.venue}» на этот компьютер…</p>
        </div>
      );
    case 'done':
      return (
        <div className="onboarding-card onboarding-done trial-form" aria-live="polite">
          <p>
            <strong>Готово! Касса «{s.venue}» теперь на этом компьютере.</strong>
          </p>
          <p>
            Данные на {moveTime(s.snapshotAt)}. {replacing ? 'Другой' : 'Старый'} компьютер покажет «Касса перенесена» и перестанет принимать заказы.
          </p>
          <ol className="trial-next">
            <li>Войдите своим кодом — тем же, что и раньше.</li>
            <li>Телефоны и планшеты сотрудников подключите заново: «Пробная» → «Подключить устройство».</li>
          </ol>
          <div className="onboarding-actions">
            <button type="button" className="btn btn-primary btn-large" onClick={onDone}>
              Перейти ко входу
            </button>
          </div>
        </div>
      );
  }
}
