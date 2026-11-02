import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { BookPage } from './BookPage.tsx';
import { bookRefOf } from './book-words.ts';
import { TrialViewPage } from './TrialViewPage.tsx';
import { viewTokenOf } from './trial-view.ts';
import './styles.css';

/**
 * The guest's booking page (#/book/<club>) and the coffee-shop owner's phone page (#/v/<token>) need
 * no account: they render on their own, without the cabinet's sign-in, Realtime or supabase-js.
 * Everything else is the cabinet.
 */
function Root() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const view = viewTokenOf(hash);
  if (view) return <TrialViewPage key={view} token={view} />;
  const ref = bookRefOf(hash);
  return ref ? <BookPage key={ref} refId={ref} /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
