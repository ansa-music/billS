import { useEffect, useRef, useState } from 'react';
import type { CounterBoardView } from '@bills/domain';
import { BrandMark } from '../BrandMark.tsx';
import { formatClock } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useFullscreen, useWakeLock } from '../kiosk.ts';
import { hrefFor } from '../router.tsx';
import { audioReady, BOARD_POLL_MS, chime, fetchCounterBoard, unlockAudio, usePolling, useSoundSetting } from './cafe.ts';
import './cafe.css';

/** How long a number that just became ready stays highlighted. */
const FRESH_MS = 12_000;

type Entry = CounterBoardView['ready'][number];

/**
 * #/board — the guest screen for a TV above the counter: numbers being made and
 * numbers ready to collect, with a chime when one becomes ready. Public and
 * read-only, so it opens without a key (App renders it before the login check).
 */
export function BoardPage({
  title,
  logoUrl,
  timeZone,
  signedIn,
}: {
  /** Club title and logo when someone is signed in on this screen; a TV without a key shows what the board sends. */
  title: string | null;
  logoUrl: string | null;
  timeZone: string | null;
  signedIn: boolean;
}) {
  const { data, error } = usePolling(fetchCounterBoard, BOARD_POLL_MS);
  const [soundOn, setSoundOn] = useSoundSetting();
  const [unlocked, setUnlocked] = useState(audioReady);
  const fullscreen = useFullscreen();
  useWakeLock();

  // Numbers that just turned ready → highlight (and chime once).
  const [fresh, setFresh] = useState<ReadonlyMap<number, number>>(new Map());
  const seenReady = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!data) return;
    const now = Date.now();
    const ready = new Set(data.ready.map((r) => r.number));
    if (seenReady.current) {
      const added = [...ready].filter((n) => !seenReady.current!.has(n));
      if (added.length > 0) {
        setFresh((prev) => {
          const next = new Map(prev);
          for (const n of added) next.set(n, now);
          return next;
        });
        if (soundOn) chime('ready');
      }
    }
    seenReady.current = ready;
  }, [data, soundOn]);

  // Drop old highlights.
  useEffect(() => {
    if (fresh.size === 0) return;
    const t = setTimeout(() => {
      const now = Date.now();
      setFresh((prev) => new Map([...prev].filter(([, at]) => now - at < FRESH_MS)));
    }, 1000);
    return () => clearTimeout(t);
  }, [fresh]);

  // The board's clock runs on the HUB time.
  const [offset, setOffset] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (data) setOffset(data.now - Date.now());
  }, [data]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  const boardTitle = title ?? (data as (CounterBoardView & { title?: string | null }) | null)?.title ?? 'Заказы';
  const boardLogo = logoUrl ?? (data as (CounterBoardView & { logoUrl?: string | null }) | null)?.logoUrl ?? null;
  const zone =
    timeZone ??
    (data as (CounterBoardView & { timezone?: string | null }) | null)?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;

  const preparing = data?.preparing ?? [];
  const ready = data?.ready ?? [];

  return (
    <main className="board" aria-live="polite">
      <header className="board-head">
        <div className="board-brand">
          {boardLogo ? <img className="board-logo" src={boardLogo} alt="" /> : <BrandMark className="board-mark" />}
          <h1>{boardTitle}</h1>
        </div>
        <div className="board-tools">
          {error && <span className="board-offline">Нет связи</span>}
          <span className="board-clock">{formatClock(Date.now() + offset, zone)}</span>
          {soundOn && !unlocked ? (
            <button
              type="button"
              className="btn board-btn"
              onClick={() => void unlockAudio().then((ok) => setUnlocked(ok))}
            >
              <Icon name="volume" size={18} /> Включить звук
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn board-icon"
              aria-label={soundOn ? 'Выключить звук' : 'Включить звук'}
              title={soundOn ? 'Выключить звук' : 'Включить звук'}
              onClick={() => {
                setSoundOn(!soundOn);
                if (!soundOn) void unlockAudio().then((ok) => setUnlocked(ok));
              }}
            >
              <Icon name={soundOn ? 'volume' : 'mute'} />
            </button>
          )}
          {fullscreen.supported && (
            <button
              type="button"
              className="icon-btn board-icon"
              onClick={fullscreen.toggle}
              aria-label={fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран'}
              title={fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран'}
            >
              <Icon name={fullscreen.active ? 'fullscreen-exit' : 'fullscreen'} />
            </button>
          )}
          {signedIn && (
            <a className="icon-btn board-icon" href={hrefFor('/barista')} aria-label="Назад в TS" title="Назад в TS">
              <Icon name="close" />
            </a>
          )}
        </div>
      </header>

      <div className="board-cols">
        <section className="board-col" data-kind="preparing" aria-labelledby="board-preparing">
          <h2 id="board-preparing">Готовится</h2>
          <BoardNumbers list={preparing} fresh={null} empty={data ? 'Пока пусто' : 'Загрузка…'} />
        </section>
        <section className="board-col" data-kind="ready" aria-labelledby="board-ready">
          <h2 id="board-ready">Готово — заберите</h2>
          <BoardNumbers list={ready} fresh={fresh} empty={data ? '—' : ''} />
        </section>
      </div>
    </main>
  );
}

function BoardNumbers({ list, fresh, empty }: { list: Entry[]; fresh: ReadonlyMap<number, number> | null; empty: string }) {
  if (list.length === 0) return <p className="board-empty">{empty}</p>;
  return (
    <ul className="board-numbers">
      {list.map((e) => (
        <li key={e.number} data-fresh={fresh?.has(e.number) || undefined}>
          <span className="board-number">{e.number}</span>
          {e.guestName && <span className="board-guest">{e.guestName}</span>}
        </li>
      ))}
    </ul>
  );
}
