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

applyStoredTheme();

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Public demo without a server (VITE_DEMO_LOCAL=1): start the HUB inside the page first.
// Other builds drop this branch and never load the demo HUB.
if (import.meta.env.VITE_DEMO_LOCAL === '1') {
  document.getElementById('root')!.textContent = 'Запускаем демо-клуб…';
  void import('./demo-hub/boot.ts')
    .then((m) => m.startDemoHub())
    .catch((err: unknown) => console.error('[demo] the in-browser HUB did not start', err))
    .then(render);
} else {
  render();
}
