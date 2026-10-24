/**
 * «Первые шаги» (#/start) and its short card on the overview and venues pages: seven steps from
 * a fresh signup to the first shift. Numbers — onboarding-load.ts; rules — onboarding.ts.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import { BUSINESS_TYPE_LABEL, downloadPath } from '@bills/domain';
import type { DownloadKind } from '@bills/domain';
import { CopyValue } from './cabinet-ui.tsx';
import { ConnectCash } from './ConnectCash.tsx';
import { clubHref, usePoll } from './hooks.ts';
import { loadOnboarding } from './onboarding-load.ts';
import type { OnboardingClub, StepId, StepsDone } from './onboarding.ts';
import {
  STEP_IDS,
  currentStep,
  doneCount,
  hideChecklist,
  isChecklistHidden,
  pickClub,
  readMarks,
  setMark,
  stepsDone,
} from './onboarding.ts';
import { forgetManagerKey, readManagerKey } from './signup.ts';
import { loadingText } from './shared.tsx';

const CABINET_SITE = 'https://ts-cabinet.pages.dev';

/**
 * Short download link: this site's /download/<kind> (a Cloudflare Pages Function), or the main
 * cabinet site's where there is none (GitHub Pages copy, localhost).
 */
export function downloadHref(kind: DownloadKind): string {
  const { hostname, origin } = location;
  const own = /^https:/.test(origin) && !hostname.endsWith('github.io') && hostname !== 'localhost' && !/^127\./.test(hostname);
  return `${own ? origin : CABINET_SITE}${downloadPath(kind)}`;
}

export function useOnboarding() {
  return usePoll(loadOnboarding, 30_000);
}

interface StepText {
  title: string;
  text: string;
}

function stepText(id: StepId, club: OnboardingClub): StepText {
  const cafe = club.businessType === 'cafe';
  switch (id) {
    case 'created':
      return {
        title: 'Заведение создано',
        text: `«${club.name}»${club.businessType ? ` — ${BUSINESS_TYPE_LABEL[club.businessType].toLowerCase()}` : ''}. Пробный период уже включён.`,
      };
    case 'install':
      return {
        title: 'Установите TS на компьютер кассы или мини-ПК',
        text: 'Программа работает в заведении даже без интернета: касса, смены и отчёты.',
      };
    case 'connect':
      return {
        title: 'Подключите кассу',
        text: 'Вставьте код в программу TS на кассе — она сама свяжется с этим кабинетом.',
      };
    case 'login':
      return {
        title: 'Войдите в кассу',
        text: 'На экране входа в кассе выберите себя и введите свой ключ из шести цифр.',
      };
    case 'staff':
      return {
        title: 'Добавьте сотрудников',
        text: cafe
          ? 'Бариста и кассирам — у каждого свой ключ входа, так видно, кто работал.'
          : 'Администраторам и кассирам — у каждого свой ключ входа, так видно, кто работал.',
      };
    case 'menu':
      return cafe
        ? {
            title: 'Заполните меню',
            text: 'Меню кофейни заполняется прямо в кассе: «Меню» → «Добавить». Шаг отметится, когда касса подключится.',
          }
        : {
            title: 'Настройте тарифы',
            text: 'Сколько стоит час игры: днём, вечером и в выходные.',
          };
    case 'shift':
      return {
        title: 'Проведите первую смену',
        text: 'Откройте смену в кассе и примите первый заказ — выручка появится в кабинете.',
      };
  }
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Пройдено шагов">
      <span className="progress-fill" style={{ width: `${(done / total) * 100}%` }} />
    </div>
  );
}

function StepItem({
  n,
  id,
  club,
  done,
  current,
  open,
  onToggle,
  children,
}: {
  n: number;
  id: StepId;
  club: OnboardingClub;
  done: boolean;
  current: boolean;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const t = stepText(id, club);
  return (
    <li className="step" data-state={done ? 'done' : current ? 'current' : 'todo'} data-open={open || undefined}>
      <button type="button" className="step-head" aria-expanded={open} onClick={onToggle}>
        <span className="step-num" aria-hidden="true">
          {done ? '✓' : n}
        </span>
        <span className="step-titles">
          <span className="step-title">
            {t.title}
            {done && <span className="visually-hidden"> — готово</span>}
          </span>
          <span className="step-text">{t.text}</span>
        </span>
      </button>
      {open && children && <div className="step-body">{children}</div>}
    </li>
  );
}

function StepActions({
  id,
  club,
  done,
  onMark,
  onJump,
}: {
  id: StepId;
  club: OnboardingClub;
  done: StepsDone;
  onMark: (mark: 'installed' | 'loggedIn') => void;
  onJump: (id: StepId) => void;
}) {
  switch (id) {
    case 'created':
      return null;
    case 'install':
      return (
        <>
          <div className="dl-pair">
            <a className="btn btn-primary btn-big" href={downloadHref('windows')}>
              <span>Скачать для Windows</span>
              <small>компьютер кассы</small>
            </a>
            <a className="btn btn-big" href={downloadHref('minipc')}>
              <span>Скачать для мини-ПК</span>
              <small>образ на флешку</small>
            </a>
          </div>
          <p className="hint">
            Другие системы и инструкции — на странице{' '}
            <a className="link-inline" href="#/apps">
              «Скачать»
            </a>
            .
          </p>
          {!done.install && (
            <p className="step-skip">
              Уже стоит?{' '}
              <button type="button" className="link-inline" onClick={() => onMark('installed')}>
                Дальше
              </button>
            </p>
          )}
        </>
      );
    case 'connect':
      return <ConnectCash clubId={club.clubId} clubName={club.name} hubConnected={club.hubConnected} autoIssue />;
    case 'login': {
      const stored = readManagerKey(club.clubId);
      if (done.login) return <p className="hint">Готово — вы уже входили в кассу.</p>;
      return stored ? (
        <>
          <div className="login-key">
            <span className="copy-label">Ваш ключ входа</span>
            <CopyValue value={stored.key} big />
          </div>
          <p className="hint">Запишите его или запомните: в кабинете он показывается только до входа в кассу.</p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              forgetManagerKey();
              onMark('loggedIn');
            }}
          >
            Я вошёл — дальше
          </button>
        </>
      ) : (
        <>
          <p className="hint">Ключ показывается один раз. Если он потерялся — выдайте себе новый на странице сотрудников.</p>
          <div className="row wrap">
            <a className="btn btn-primary" href={clubHref(club.clubId, 'staff')}>
              Выдать ключ
            </a>
            <button type="button" className="btn" onClick={() => onMark('loggedIn')}>
              Я уже вошёл
            </button>
          </div>
        </>
      );
    }
    case 'staff':
      return (
        <a className="btn btn-primary" href={clubHref(club.clubId, 'staff')}>
          Открыть сотрудников
        </a>
      );
    case 'menu':
      return club.businessType === 'cafe' ? (
        done.menu ? null : (
          <button type="button" className="btn btn-primary" onClick={() => onJump('connect')}>
            Сначала подключить кассу
          </button>
        )
      ) : (
        <a className="btn btn-primary" href={clubHref(club.clubId, 'tariffs')}>
          Открыть тарифы
        </a>
      );
    case 'shift':
      return (
        <a className="btn btn-primary" href={clubHref(club.clubId, 'shifts')}>
          Смотреть смены
        </a>
      );
  }
}

export function StartPage({ companyId }: { companyId: string }) {
  const { data, error, reload } = useOnboarding();
  const [wanted, setWanted] = useState<string | null>(null);
  const [open, setOpen] = useState<StepId | 'none' | null>(null);
  const [, bump] = useState(0);

  if (!data) return <p className="boot-inline">{loadingText(error, 'первые шаги')}</p>;

  const club = pickClub(data.clubs, readMarks, wanted);
  if (!club) {
    return (
      <div className="start-page">
        <div className="empty-state">
          <h2>Заведений пока нет</h2>
          <p className="muted">Добавьте первое заведение — и кабинет покажет, что делать дальше.</p>
          <a className="btn btn-primary" href="#/company">
            Добавьте первое заведение
          </a>
        </div>
      </div>
    );
  }

  const done = stepsDone(club, readMarks(club.clubId));
  const now = currentStep(done);
  const count = doneCount(done);
  const shown = open ?? now;

  const mark = (m: 'installed' | 'loggedIn') => {
    setMark(club.clubId, m);
    setOpen(null);
    bump((x) => x + 1);
  };

  return (
    <div className="start-page">
      <header className="start-head">
        <div>
          <h2>Первые шаги</h2>
          <p className="muted">
            {now ? 'Семь простых шагов — и заведение работает в TS. Кабинет запоминает, что уже сделано.' : 'Всё готово — заведение работает в TS.'}
          </p>
        </div>
        <div className="start-progress">
          <span className="start-count">
            {count} из {STEP_IDS.length}
          </span>
          <ProgressBar done={count} total={STEP_IDS.length} />
        </div>
      </header>

      {data.clubs.length > 1 && (
        <label className="field start-club">
          <span>Заведение</span>
          <select
            value={club.clubId}
            onChange={(e) => {
              setWanted(e.target.value);
              setOpen(null);
            }}
          >
            {data.clubs.map((c) => (
              <option key={c.clubId} value={c.clubId}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <ol className="steps-list">
        {STEP_IDS.map((id, i) => (
          <StepItem
            key={id}
            n={i + 1}
            id={id}
            club={club}
            done={done[id]}
            current={id === now}
            open={shown === id}
            onToggle={() => setOpen(shown === id ? 'none' : id)}
          >
            <StepActions
              id={id}
              club={club}
              done={done}
              onMark={mark}
              onJump={(to) => {
                setOpen(to);
                void reload();
              }}
            />
          </StepItem>
        ))}
      </ol>

      {!now && (
        <div className="start-done">
          <p>
            <strong>Отлично!</strong> Все шаги пройдены. Отчёты по сменам и выручке — на странице «Обзор».
          </p>
          <div className="row wrap">
            <a
              className="btn btn-primary"
              href="#/"
              onClick={() => {
                hideChecklist(companyId);
              }}
            >
              Скрыть подсказки
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/** «Первые шаги · 3 из 7» on the overview and venues pages until the checklist is hidden. */
export function StartCard({ companyId }: { companyId: string }) {
  const { data } = useOnboarding();
  const [hidden, setHidden] = useState(() => isChecklistHidden(companyId));
  if (hidden || !data) return null;
  const club = pickClub(data.clubs, readMarks);
  if (!club) return null;
  const done = stepsDone(club, readMarks(club.clubId));
  const now = currentStep(done);
  const count = doneCount(done);
  const next = now ? stepText(now, club) : null;
  return (
    <section className="start-card" aria-label="Первые шаги">
      <div className="start-card-main">
        <span className="start-card-kicker">
          Первые шаги · {count} из {STEP_IDS.length}
        </span>
        <ProgressBar done={count} total={STEP_IDS.length} />
        {next ? (
          <p>
            <strong>Дальше: {next.title}.</strong> <span className="muted">{next.text}</span>
          </p>
        ) : (
          <p>
            <strong>Всё готово!</strong> <span className="muted">Заведение работает в TS.</span>
          </p>
        )}
      </div>
      {next ? (
        <a className="btn btn-primary" href="#/start">
          Продолжить
        </a>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => {
            hideChecklist(companyId);
            setHidden(true);
          }}
        >
          Скрыть
        </button>
      )}
    </section>
  );
}
