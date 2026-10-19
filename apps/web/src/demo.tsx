import { useEffect, useState } from 'react';
import type { DemoInfo } from '@bills/domain';
import { DEMO_KEYS } from '@bills/domain';
import { hubUrl } from './api.ts';
import { DEMO_LOCAL, resetDemo } from './demo-hub/storage.ts';

/**
 * Public demo (the screen on a static host talking to a demo HUB with
 * HUB_DEMO=1). The banner shows when the HUB answers GET /api/demo — or right
 * away when the build says VITE_DEMO=1, so it is there while a sleeping free
 * server wakes up. A real club's HUB has no /api/demo: nothing is shown.
 * With VITE_DEMO_LOCAL=1 the demo HUB runs inside the page (demo-hub/boot.ts) and
 * answers /api/demo itself; the banner then also offers «Сбросить демо».
 */

const BUILT_AS_DEMO = import.meta.env.VITE_DEMO === '1' || DEMO_LOCAL;

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
export function DemoBanner() {
  const { demo } = useDemo();
  if (!demo) return null;
  return (
    <div className="pwa-banner demo-banner" role="note">
      <p className="pwa-banner-text">
        <strong>Демо</strong> — данные сбрасываются каждую ночь. Лампы и ИБП здесь симулируются: попробуйте раздел
        «Оборудование».
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

/** Demo keys under the login form: one tap fills the key in. */
export function DemoKeys({ onPick }: { onPick: (key: string) => void }) {
  const { demo, keys } = useDemo();
  if (!demo) return null;
  return (
    <aside className="login-help demo-keys" aria-label="Демо-ключи">
      <p>
        <strong>Демо — данные сбрасываются каждую ночь.</strong> Войдите любым ключом (нажмите, чтобы подставить).{' '}
        {DEMO_LOCAL
          ? 'Клуб работает прямо в браузере и хранится только на этом устройстве.'
          : 'Бесплатный сервер засыпает без посетителей: первый вход после паузы может занять до минуты.'}
      </p>
      <ul className="demo-keys-list">
        {keys.map((k) => (
          <li key={k.key}>
            <button type="button" className="btn demo-key" onClick={() => onPick(k.key)}>
              <span className="demo-key-role">{k.label}</span>
              <code>{k.key}</code>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
