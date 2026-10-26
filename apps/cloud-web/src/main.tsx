import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { BookPage } from './BookPage.tsx';
import { bookRefOf } from './book-words.ts';
import './styles.css';

/**
 * The guest's booking page (#/book/<club>) needs no account: it renders on its own, without the
 * cabinet's sign-in, Realtime or supabase-js. Everything else is the cabinet.
 */
function Root() {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const ref = bookRefOf(hash);
  return ref ? <BookPage key={ref} refId={ref} /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
