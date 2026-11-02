import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Order matters: tokens and base first, then the shell, the hall, then the pages beyond it.
import '@fontsource-variable/inter';
import './styles.css';
import './shell.css';
import './hall.css';
import './plan.css';
import './sections.css';
import './app.css';
import { applyStoredTheme } from './theme.ts';
import { App } from './App.tsx';
import { watchTokenFromHash } from '@bills/domain';
import { watchToken } from './demo-hub/watch-mode.ts';

applyStoredTheme();

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Two-week browser trial (VITE_TRIAL=1 with VITE_DEMO_LOCAL=1): the coffee shop is created on the
// welcome screen and then runs in the page like the demo, kept in IndexedDB. A watch link
// (#/watch/<token>, «Смотреть с телефона») opens the cash desk's latest data read-only instead.
if (import.meta.env.VITE_DEMO_LOCAL === '1' && import.meta.env.VITE_TRIAL === '1') {
  const watching = watchToken();
  if (watching) void startWatch(watching);
  else void startTrial();
  // A watch link opened in a tab that already shows TS changes only the hash: start over as the copy.
  window.addEventListener('hashchange', () => {
    const next = watchTokenFromHash(window.location.hash);
    if (next && next !== watching) window.location.reload();
  });
} else if (import.meta.env.VITE_DEMO_LOCAL === '1') {
  // Public demo without a server (VITE_DEMO_LOCAL=1): start the HUB inside the page first.
  // Other builds drop this branch and never load the demo HUB.
  document.getElementById('root')!.textContent = 'Запускаем демо-клуб…';
  void import('./demo-hub/boot.ts')
    .then((m) => m.startDemoHub())
    .catch((err: unknown) => console.error('[demo] the in-browser HUB did not start', err))
    .then(render);
} else {
  render();
}

/**
 * A phone watching a trial cash desk: no lock, no IndexedDB — the copy lives in memory beside
 * (and never instead of) this browser's own trial. Signs in with the person's own code.
 */
async function startWatch(token: string): Promise<void> {
  const rootEl = document.getElementById('root')!;
  rootEl.textContent = 'Загружаем данные кассы…';
  // The link is remembered (watch-mode.ts); the address goes back to the app's own routes.
  if (window.location.hash.startsWith('#/watch/')) history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/login`);
  const [hub, ui] = await Promise.all([import('./demo-hub/watch-hub.ts'), import('./trial/WatchBanner.tsx')]);
  const root = createRoot(rootEl);
  rootEl.setAttribute('aria-busy', 'true');
  try {
    await hub.startWatchHub(token);
  } catch (err) {
    const problem = err instanceof hub.WatchProblem ? err : null;
    if (!problem) console.error('[watch] the copy did not open', err);
    root.render(<ui.WatchProblemScreen kind={problem?.kind ?? 'broken'} detail={problem?.message} />);
    return;
  } finally {
    rootEl.removeAttribute('aria-busy');
  }
  root.render(
    <StrictMode>
      <ui.WatchGate>
        <App />
      </ui.WatchGate>
    </StrictMode>,
  );
}

async function startTrial(): Promise<void> {
  const rootEl = document.getElementById('root')!;
  rootEl.textContent = 'Открываем кофейню…';
  const [{ hasSavedTrial, startTrialHub }, ui] = await Promise.all([import('./demo-hub/boot.ts'), import('./trial/TrialWelcome.tsx')]);
  const root = createRoot(rootEl);
  // One tab only: two in-page HUBs on the same saved coffee shop would overwrite each other.
  const locks = navigator.locks;
  if (locks) {
    const got = await new Promise<boolean>((resolve) => {
      void locks.request('ts-trial-hub', { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Held for the life of the tab.
        return lock ? new Promise<void>(() => {}) : undefined;
      });
    });
    if (!got) {
      root.render(<ui.TrialBusy />);
      return;
    }
  }
  const begin = async (fresh: Parameters<typeof startTrialHub>[0]) => {
    rootEl.setAttribute('aria-busy', 'true');
    const info = await startTrialHub(fresh);
    rootEl.removeAttribute('aria-busy');
    const app = (
      <StrictMode>
        <App />
      </StrictMode>
    );
    if (fresh) root.render(<ui.TrialReady venue={info.venue} managerKey={info.managerKey} onContinue={() => root.render(app)} />);
    else root.render(app);
  };
  if (await hasSavedTrial()) {
    await begin(null);
    return;
  }
  root.render(<ui.TrialWelcome onStart={(t) => void begin(t)} onRestored={() => window.location.reload()} />);
}
