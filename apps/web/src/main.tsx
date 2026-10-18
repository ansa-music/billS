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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
