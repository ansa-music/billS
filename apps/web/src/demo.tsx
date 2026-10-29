import { useEffect, useState } from 'react';
import type { DemoInfo } from '@bills/domain';
import { DEMO_KEYS, rolesLabel } from '@bills/domain';
import { hubUrl } from './api.ts';
import { DEMO_LOCAL, resetDemo } from './demo-hub/storage.ts';
import { currentTrial, daysLeft, downloadBackup, TRIAL, trialEndsAt } from './demo-hub/trial-store.ts';

/**
 * Public demo (the screen on a static host talking to a demo HUB with
 * HUB_DEMO=1). The banner shows when the HUB answers GET /api/demo — or right
 * away when the build says VITE_DEMO=1, so it is there while a sleeping free
 * server wakes up. A real club's HUB has no /api/demo: nothing is shown.
 * With VITE_DEMO_LOCAL=1 the demo HUB runs inside the page (demo-hub/boot.ts) and
 * answers /api/demo itself; the banner then also offers «Сбросить демо».
 */

// The browser trial runs the same in-page HUB but is the person's own coffee shop, not a demo.
const BUILT_AS_DEMO = (import.meta.env.VITE_DEMO === '1' || DEMO_LOCAL) && !TRIAL;

let cached: Promise<DemoInfo | null> | null = null;

function loadDemo(): Promise<DemoInfo | null> {
  cached ??= fetch(hubUrl('/api/demo'), { cache: 'no-store' })
    .then((res) => (res.ok ? (res.json() as Promise<DemoInfo>) : null))
    .catch(() => {
      cached = null; // asleep or offline: ask again next time
      return null;
    });
  return cached;
}

export function useDemo(): { demo: boolean; keys: DemoInfo['keys'] } {
  const [info, setInfo] = useState<DemoInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void loadDemo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);
  return { demo: BUILT_AS_DEMO || info !== null, keys: info?.keys ?? DEMO_KEYS };
}

/** Strip under the top bar on every page of the demo. */
export function DemoBanner({ cafe = false }: { cafe?: boolean }) {
  const { demo } = useDemo();
  if (TRIAL) return <TrialBanner />;
  if (!demo) return null;
  return (
    <div className="pwa-banner demo-banner" role="note">
      <p className="pwa-banner-text">
        <strong>Демо</strong> — данные сбрасываются каждую ночь.{' '}
        {cafe
          ? 'Примите заказ на «Кассе», отметьте его готовым у бариста и посмотрите номер на «Экране заказов».'
          : 'Лампы и ИБП здесь симулируются: попробуйте раздел «Оборудование».'}
      </p>
      {DEMO_LOCAL && (
        <div className="pwa-banner-actions">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              if (window.confirm('Сбросить демо-клуб? Все изменения на этом устройстве пропадут.')) resetDemo();
            }}
          >
            Сбросить демо
          </button>
        </div>
      )}
    </div>
  );
}

/** Browser trial: days left, «Скачать копию», the manager's code — on every page. */
function TrialBanner() {
  const info = currentTrial();
  const [busy, setBusy] = useState(false);
  if (!info) return null;
  const left = daysLeft(info);
  const until = new Date(trialEndsAt(info)).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return (
    <div className="pwa-banner demo-banner trial-banner" role="note">
      <p className="pwa-banner-text">
        <strong>Пробная версия</strong> —{' '}
        {left > 0 ? `осталось ${left} ${daysWord(left)} (до ${until}).` : 'пробный период закончился: данные можно смотреть и скачать, новые заказы недоступны.'} Данные хранятся
        только в этом браузере.
      </p>
      <div className="pwa-banner-actions">
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void downloadBackup().finally(() => setBusy(false));
          }}
        >
          Скачать копию
        </button>
        <button
          type="button"
          className="btn btn-small btn-ghost"
          onClick={() => {
            if (window.confirm('Показать код управляющего? Убедитесь, что экран не видят посторонние.')) {
              window.alert(`${info.managerName}: код входа ${info.managerKey}`);
            }
          }}
        >
          Код управляющего
        </button>
      </div>
    </div>
  );
}

function daysWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'день';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'дня';
  return 'дней';
}

/**
 * Demo: one big button per demo person — a single tap signs in, nothing to type.
 * The keys are four digits so they can be read out at a presentation; they work
 * only on a demo HUB.
 */
export function DemoKeys({ onLogin, busy }: { onLogin: (key: string) => void; busy?: boolean }) {
  const { demo, keys } = useDemo();
  if (!demo) return null;
  return (
    <aside className="login-help demo-keys" aria-label="Демо-вход">
      <p>
        <strong>Демо — данные сбрасываются каждую ночь.</strong> Нажмите, чтобы войти, или наберите ключ из 4 цифр.{' '}
        {DEMO_LOCAL
          ? 'Клуб работает прямо в браузере и хранится только на этом устройстве.'
          : 'Бесплатный сервер засыпает без посетителей: первый вход после паузы может занять до минуты.'}
      </p>
      <ul className="demo-keys-list demo-keys-big">
        {keys.map((k) => (
          <li key={k.key}>
            <button type="button" className="btn demo-key" disabled={busy} onClick={() => onLogin(k.key)}>
              <span className="demo-key-role">Войти как {(k.label || rolesLabel(k.roles)).toLowerCase()}</span>
              <code>{k.key}</code>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
