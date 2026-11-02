import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CounterBoardView } from '@bills/domain';
import { BrandMark } from '../BrandMark.tsx';
import { formatClock } from '../format.ts';
import { Icon } from '../icons.tsx';
import { useFullscreen } from '../kiosk.ts';
import { hrefFor } from '../router.tsx';
import { BOARD_POLL_MS, chime, fetchCounterBoard, useCounterEvents, usePolling, useSoundSetting } from './cafe.ts';
import { useAudioUnlock, useScreenAwake } from './staff-device.ts';
import './cafe.css';

/** How long a number that just became ready stays highlighted. */
const FRESH_MS = 12_000;
/** The buttons fade out after this long without a touch or a mouse move (a TV shows numbers only). */
const IDLE_MS = 6000;

type Entry = CounterBoardView['ready'][number];

/**
 * #/board — the guest screen for a TV above the counter or a tablet on it: numbers being made
 * and numbers ready to collect, readable from across the room. The numbers fill their half of
 * the screen — as big as the count allows, never a scrollbar — on a 16:9 TV and on a portrait
 * tablet alike. A chime when a number becomes ready (the first tap unlocks the sound). Public
 * and read-only, so it opens without a key (App renders it before the login check).
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
  // HUB counter events refresh at once; the poll is the fallback (and covers a lost stream).
  const events = useCounterEvents();
  const { data, error } = usePolling(fetchCounterBoard, BOARD_POLL_MS, events);
  const [soundOn, setSoundOn] = useSoundSetting();
  const audio = useAudioUnlock(soundOn);
  const fullscreen = useFullscreen();
  useScreenAwake();

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

  // Buttons show on a touch or a mouse move and fade away after a while.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), IDLE_MS);
    };
    wake();
    const types = ['pointermove', 'pointerdown', 'keydown'] as const;
    for (const type of types) document.addEventListener(type, wake, { passive: true });
    return () => {
      clearTimeout(t);
      for (const type of types) document.removeEventListener(type, wake);
    };
  }, []);

  const boardTitle = title ?? data?.title ?? 'Заказы';
  const boardLogo = logoUrl ?? data?.logoUrl ?? null;
  const zone = timeZone ?? data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const preparing = data?.preparing ?? [];
  const ready = data?.ready ?? [];
  const locked = soundOn && !audio.unlocked;

  return (
    <main className="gb" data-idle={(idle && !locked) || undefined}>
      <header className="gb-head">
        <div className="gb-brand">
          {boardLogo ? <img className="gb-logo" src={boardLogo} alt="" /> : <BrandMark className="gb-mark" />}
          <h1>{boardTitle}</h1>
        </div>
        <div className="gb-tools">
          {error && <span className="gb-offline">Нет связи</span>}
          <span className="gb-clock">{formatClock(Date.now() + offset, zone)}</span>
          {locked ? (
            <button type="button" className="gb-btn gb-btn-sound" onClick={() => void audio.unlock().then((ok) => ok && chime('ready'))}>
              <Icon name="volume" size={22} /> Включить звук
            </button>
          ) : (
            <button
              type="button"
              className="gb-icon gb-fade"
              aria-label={soundOn ? 'Выключить звук' : 'Включить звук'}
              title={soundOn ? 'Выключить звук' : 'Включить звук'}
              onClick={() => setSoundOn(!soundOn)}
            >
              <Icon name={soundOn ? 'volume' : 'mute'} />
            </button>
          )}
          {fullscreen.supported && (
            <button
              type="button"
              className="gb-icon gb-fade"
              onClick={fullscreen.toggle}
              aria-label={fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран'}
              title={fullscreen.active ? 'Выйти из полноэкранного режима' : 'На весь экран'}
            >
              <Icon name={fullscreen.active ? 'fullscreen-exit' : 'fullscreen'} />
            </button>
          )}
          {signedIn && (
            <a className="gb-icon gb-fade" href={hrefFor('/barista')} aria-label="Назад в TS" title="Назад в TS">
              <Icon name="close" />
            </a>
          )}
        </div>
      </header>

      <div className="gb-cols" aria-live="polite">
        <section className="gb-col" data-kind="preparing" aria-labelledby="gb-preparing">
          <h2 id="gb-preparing">Готовится</h2>
          <FitNumbers list={preparing} fresh={null} empty={data ? 'Пока пусто' : 'Загрузка…'} maxFont={220} />
        </section>
        <section className="gb-col" data-kind="ready" aria-labelledby="gb-ready">
          <h2 id="gb-ready">Готово — заберите</h2>
          <FitNumbers list={ready} fresh={fresh} empty={data ? '—' : ''} maxFont={320} />
        </section>
      </div>
    </main>
  );
}

/** Width of one digit and the cell's padding, in em of the number (Inter, bold, tabular digits). */
const DIGIT_EM = 0.62;
const PAD_X_EM = 0.8;
/** Height of the number line, and with a guest's name under it. */
const LINE_EM = 1.25;
const NAMED_EM = 1.6;
/** Below this the numbers would not read from across the room: the rest becomes «+N». */
const MIN_FONT = 30;

interface BoardFit {
  /** Columns of the grid. */
  cols: number;
  /** Font size of the numbers, px. */
  font: number;
  /** How many entries are shown; the rest is summed up in a «+N» cell. */
  shown: number;
}

/**
 * The biggest numbers that fit `count` cells into a `width` × `height` box with `gap` between
 * them: every column count is tried, the one giving the largest font wins (capped at `maxFont`).
 * When even MIN_FONT does not fit them all, as many as fit are shown and the last cell says «+N».
 */
function fitBoard(count: number, width: number, height: number, digits: number, named: boolean, gap: number, maxFont: number): BoardFit {
  if (count <= 0 || width <= 0 || height <= 0) return { cols: 1, font: 0, shown: 0 };
  const cellEmW = Math.max(1, digits) * DIGIT_EM + PAD_X_EM;
  const cellEmH = named ? NAMED_EM : LINE_EM;
  const fontFor = (cols: number, n: number) => {
    const rows = Math.ceil(n / cols);
    const cellW = (width - gap * (cols - 1)) / cols;
    const cellH = (height - gap * (rows - 1)) / rows;
    return Math.min(cellW / cellEmW, cellH / cellEmH, maxFont);
  };
  let best = { cols: 1, font: 0 };
  for (let cols = 1; cols <= count; cols++) {
    const font = fontFor(cols, count);
    if (font > best.font) best = { cols, font };
  }
  if (best.font >= MIN_FONT) return { ...best, font: Math.floor(best.font), shown: count };
  // Too many for the box: the grid at the smallest readable size, the last cell is «+N».
  const cols = Math.max(1, Math.floor((width + gap) / (MIN_FONT * cellEmW + gap)));
  const rows = Math.max(1, Math.floor((height + gap) / (MIN_FONT * cellEmH + gap)));
  return { cols, font: MIN_FONT, shown: Math.max(0, cols * rows - 1) };
}

function FitNumbers({
  list,
  fresh,
  empty,
  maxFont,
}: {
  list: Entry[];
  fresh: ReadonlyMap<number, number> | null;
  empty: string;
  maxFont: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1 ? s : { w: r.width, h: r.height }));
    };
    measure();
    // Rotation and window resizes at once; the observer catches the rest (the header growing, a font loading).
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  const digits = list.reduce((d, e) => Math.max(d, String(e.number).length), 1);
  const named = list.some((e) => e.guestName);
  const gap = Math.max(8, Math.round(Math.min(size.w, size.h) * 0.025));
  const fit = fitBoard(list.length, size.w, size.h, digits, named, gap, Math.min(maxFont, size.h * 0.62));
  const shown = list.slice(0, fit.shown);
  const more = list.length - shown.length;

  return (
    <div className="gb-fit" ref={box}>
      {list.length === 0 ? (
        <p className="gb-empty">{empty}</p>
      ) : (
        <ul className="gb-numbers" style={{ gridTemplateColumns: `repeat(${fit.cols}, minmax(0, 1fr))`, gap, fontSize: fit.font }}>
          {shown.map((e) => (
            <li key={e.number} data-fresh={fresh?.has(e.number) || undefined}>
              <span className="gb-num">{e.number}</span>
              {e.guestName && <span className="gb-name">{e.guestName}</span>}
            </li>
          ))}
          {more > 0 && (
            <li className="gb-more">
              <span className="gb-num">+{more}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
