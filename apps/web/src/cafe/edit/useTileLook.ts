import { useCallback, useEffect, useRef, useState } from 'react';

/** How the owner dressed one product tile. */
export interface TileLook {
  photo?: string; // data URL, ≤512px
  focus?: [number, number]; // object-position, percent
  accent?: string; // CSS colour
  badge?: string; // emoji or short label
}

export interface Looks {
  tiles: Record<string, TileLook>;
  order: string[]; // product ids, the owner's order first
}

const EMPTY: Looks = { tiles: {}, order: [] };
const DB = 'ts-pos-look';
const STORE = 'kv';
const KEY = 'looks';
const LS_KEY = 'ts.pos.look';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function load(): Promise<Looks> {
  try {
    const db = await openDb();
    const v = await new Promise<unknown>((resolve, reject) => {
      const r = db.transaction(STORE).objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (v && typeof v === 'object') return { ...EMPTY, ...(v as Looks) };
  } catch {
    /* fall back below */
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...EMPTY, ...(JSON.parse(raw) as Looks) };
  } catch {
    /* nothing saved */
  }
  return EMPTY;
}

async function save(looks: Looks) {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(looks, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return;
  } catch {
    /* fall back to localStorage */
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(looks));
  } catch {
    // Quota: keep everything but the photos.
    try {
      const tiles = Object.fromEntries(Object.entries(looks.tiles).map(([k, { photo: _p, ...rest }]) => [k, rest]));
      localStorage.setItem(LS_KEY, JSON.stringify({ ...looks, tiles }));
    } catch {
      /* give up quietly */
    }
  }
}

/** Downscales an image file to ≤512px and returns a WebP (or JPEG) data URL. */
export async function photoOf(file: Blob, max = 512): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const webp = canvas.toDataURL('image/webp', 0.82);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const UNDO_MAX = 30;

/** The owner's tile looks, persisted locally, with undo. */
export function useTileLook() {
  const [looks, setLooks] = useState<Looks>(EMPTY);
  const history = useRef<Looks[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    let live = true;
    void load().then((l) => {
      if (!live) return;
      loaded.current = true;
      setLooks(l);
    });
    return () => {
      live = false;
    };
  }, []);

  const commit = useCallback((next: (prev: Looks) => Looks) => {
    setLooks((prev) => {
      const value = next(prev);
      if (value === prev) return prev;
      history.current = [...history.current.slice(-UNDO_MAX + 1), prev];
      void save(value);
      return value;
    });
  }, []);

  const patch = useCallback(
    (id: string, change: Partial<TileLook> | null) =>
      commit((prev) => {
        const tiles = { ...prev.tiles };
        const merged = change === null ? {} : { ...tiles[id], ...change };
        for (const k of Object.keys(merged) as (keyof TileLook)[]) if (merged[k] === undefined) delete merged[k];
        if (Object.keys(merged).length) tiles[id] = merged;
        else delete tiles[id];
        return { ...prev, tiles };
      }),
    [commit],
  );

  const reorder = useCallback(
    (ids: string[], from: string, to: string) =>
      commit((prev) => {
        if (from === to) return prev;
        const list = ids.filter((id) => id !== from);
        const at = list.indexOf(to);
        list.splice(at < 0 ? list.length : at, 0, from);
        // Keep the owner's order for products not shown on this tab.
        const rest = prev.order.filter((id) => !ids.includes(id));
        return { ...prev, order: [...list, ...rest] };
      }),
    [commit],
  );

  const reset = useCallback(() => commit(() => EMPTY), [commit]);

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) return false;
    setLooks(prev);
    void save(prev);
    return true;
  }, []);

  return { looks, patch, reorder, reset, undo };
}

/** Sorts items by the owner's order; ones never moved keep their place after the moved ones' slots. */
export function ordered<T extends { id: string }>(items: T[], order: string[]): T[] {
  if (!order.length) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  return items
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (rank.get(a.t.id) ?? order.length + a.i) - (rank.get(b.t.id) ?? order.length + b.i))
    .map((x) => x.t);
}
