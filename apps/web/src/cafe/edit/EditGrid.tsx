import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { TileLook } from './useTileLook.ts';
import { photoOf } from './useTileLook.ts';
import './edit.css';

export const ACCENTS = ['#e8590c', '#d6336c', '#ae3ec9', '#4263eb', '#1c7ed6', '#0ca678', '#74b816', '#495057'];
export const BADGES = ['🔥', '⭐', '🆕', '🌱', '❄️', '☕', 'Хит', 'Сезон'];

export interface EditTile {
  id: string;
  name: string;
  price: string;
  hue: number;
}

/** Style vars a dressed tile needs, in and out of edit mode. */
export function lookStyle(hue: number, look: TileLook | undefined): CSSProperties {
  return {
    '--hue': hue,
    ...(look?.accent ? { '--tile-accent': look.accent } : {}),
  } as CSSProperties;
}

/** The full-bleed photo layer of a tile (with the readable gradient on top). */
export function TilePhoto({ look }: { look: TileLook | undefined }) {
  if (!look?.photo) return null;
  const [x, y] = look.focus ?? [50, 50];
  return (
    <span className="ts-tile-photo" aria-hidden="true">
      <img src={look.photo} alt="" draggable={false} style={{ objectPosition: `${x}% ${y}%` }} />
    </span>
  );
}

export function TileBadge({ look }: { look: TileLook | undefined }) {
  return look?.badge ? <span className="ts-tile-badge">{look.badge}</span> : null;
}

const imageOf = (list: DataTransferItemList | FileList | null | undefined): File | null => {
  if (!list) return null;
  const items: (File | DataTransferItem)[] = Array.from(list as ArrayLike<File | DataTransferItem>);
  for (const item of items) {
    const file = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
    if (file && file.type.startsWith('image/')) return file;
  }
  return null;
};

interface Props {
  tiles: EditTile[];
  looks: Record<string, TileLook>;
  patch: (id: string, change: Partial<TileLook> | null) => void;
  reorder: (ids: string[], from: string, to: string) => void;
  reset: () => void;
  undo: () => boolean;
  onDone: () => void;
}

/** The menu grid in design mode: selling is paused, tiles take photos, colours, badges and new places. */
export function EditGrid({ tiles, looks, patch, reorder, reset, undo, onDone }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const target = useRef<string | null>(null);
  const ids = tiles.map((t) => t.id);

  const setPhoto = async (id: string, file: File) => {
    try {
      patch(id, { photo: await photoOf(file), focus: [50, 50] });
      setNote(null);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Не удалось добавить фото');
    }
  };

  // Ctrl+V pastes a photo onto the selected tile, Ctrl+Z undoes, Escape leaves.
  const live = useRef({ selected, setPhoto, undo, onDone });
  live.current = { selected, setPhoto, undo, onDone };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const id = live.current.selected;
      const file = imageOf(e.clipboardData?.items);
      if (!id || !file) return;
      e.preventDefault();
      void live.current.setPhoto(id, file);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        if (!live.current.undo()) setNote('Отменять нечего');
      } else if (e.key === 'Escape') {
        live.current.onDone();
      }
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Dragging the photo inside the tile moves its focal point.
  const startFocus = (id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (!looks[id]?.photo || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const box = (e.currentTarget.closest('.ts-edit-tile') as HTMLElement).getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, f: looks[id]?.focus ?? [50, 50] };
    let last = start.f;
    const move = (ev: PointerEvent) => {
      const fx = Math.min(100, Math.max(0, start.f[0] - ((ev.clientX - start.x) / box.width) * 100));
      const fy = Math.min(100, Math.max(0, start.f[1] - ((ev.clientY - start.y) / box.height) * 100));
      last = [Math.round(fx), Math.round(fy)];
      const img = (e.target as HTMLElement).closest('.ts-edit-tile')?.querySelector('img');
      if (img) img.style.objectPosition = `${last[0]}% ${last[1]}%`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (last !== start.f) patch(id, { focus: last });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const sel = selected ? looks[selected] : undefined;
  const selTile = tiles.find((t) => t.id === selected);

  return (
    <div className="ts-edit">
      <div className="ts-edit-bar" role="toolbar" aria-label="Дизайн витрины">
        <span className="ts-edit-hint">
          {selTile
            ? `«${selTile.name}»: перетащите фото на плитку, вставьте Ctrl+V или выберите файл`
            : 'Выберите плитку. Перетаскивайте плитки, чтобы поменять порядок.'}
        </span>
        <button type="button" className="ts-edit-btn" onClick={() => !undo() && setNote('Отменять нечего')}>
          ↶ Отменить
        </button>
        <button
          type="button"
          className="ts-edit-btn"
          onClick={() => {
            if (window.confirm('Сбросить фото, цвета, значки и порядок всех плиток?')) reset();
          }}
        >
          Сбросить
        </button>
        <button type="button" className="ts-edit-btn ts-edit-done" onClick={onDone}>
          Готово
        </button>
      </div>
      {note && (
        <p className="ts-edit-note" role="status">
          {note}
        </p>
      )}

      {selTile && (
        <div className="ts-edit-panel" aria-label={`Оформление: ${selTile.name}`}>
          <button type="button" className="ts-edit-btn" onClick={() => fileRef.current?.click()}>
            📷 {sel?.photo ? 'Заменить фото' : 'Добавить фото'}
          </button>
          {sel?.photo && (
            <button type="button" className="ts-edit-btn" onClick={() => patch(selTile.id, { photo: undefined, focus: undefined })}>
              Убрать фото
            </button>
          )}
          <span className="ts-edit-group" role="group" aria-label="Цвет">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                className="ts-swatch"
                style={{ background: c }}
                aria-label={`Цвет ${c}`}
                aria-pressed={sel?.accent === c}
                onClick={() => patch(selTile.id, { accent: sel?.accent === c ? undefined : c })}
              />
            ))}
          </span>
          <span className="ts-edit-group" role="group" aria-label="Значок">
            {BADGES.map((b) => (
              <button
                key={b}
                type="button"
                className="ts-badge-pick"
                aria-pressed={sel?.badge === b}
                onClick={() => patch(selTile.id, { badge: sel?.badge === b ? undefined : b })}
              >
                {b}
              </button>
            ))}
            <input
              className="ts-badge-input"
              placeholder="Свой"
              maxLength={8}
              aria-label="Свой значок"
              value={sel?.badge && !BADGES.includes(sel.badge) ? sel.badge : ''}
              onChange={(e) => patch(selTile.id, { badge: e.target.value.trim() || undefined })}
            />
          </span>
          <button type="button" className="ts-edit-btn" onClick={() => patch(selTile.id, null)}>
            Очистить плитку
          </button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          const id = target.current ?? selected;
          if (file && id) void setPhoto(id, file);
          e.target.value = '';
        }}
      />

      <div className="pos-tiles ts-edit-tiles" role="listbox" aria-label="Плитки товаров">
        {tiles.map((t) => {
          const look = looks[t.id];
          return (
            <div
              key={t.id}
              role="option"
              tabIndex={0}
              aria-selected={selected === t.id}
              className="pos-tile ts-tile ts-edit-tile"
              data-photo={look?.photo ? '' : undefined}
              data-dragging={dragging === t.id || undefined}
              data-over={over === t.id || undefined}
              style={lookStyle(t.hue, look)}
              draggable
              onClick={() => setSelected(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSelected(t.id);
                }
              }}
              onDragStart={(e) => {
                setDragging(t.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/x-ts-tile', t.id);
              }}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = dragging ? 'move' : 'copy';
                if (over !== t.id) setOver(t.id);
              }}
              onDragLeave={() => setOver((o) => (o === t.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const file = imageOf(e.dataTransfer.files);
                if (file) {
                  setSelected(t.id);
                  void setPhoto(t.id, file);
                  return;
                }
                const from = e.dataTransfer.getData('text/x-ts-tile') || dragging;
                if (from) reorder(ids, from, t.id);
                setDragging(null);
              }}
            >
              <TilePhoto look={look} />
              {look?.photo && (
                <span
                  className="ts-focus-grip"
                  title="Потяните, чтобы выбрать, какая часть фото видна"
                  onPointerDown={(e) => startFocus(t.id, e)}
                >
                  ✥
                </span>
              )}
              <TileBadge look={look} />
              <span className="pos-tile-name">{t.name}</span>
              <span className="pos-tile-foot">
                <span className="pos-tile-price">{t.price}</span>
              </span>
              <span className="ts-edit-controls">
                <button
                  type="button"
                  className="ts-mini"
                  aria-label="Выбрать фото"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(t.id);
                    target.current = t.id;
                    fileRef.current?.click();
                  }}
                >
                  📷
                </button>
                {look?.photo && (
                  <button
                    type="button"
                    className="ts-mini"
                    aria-label="Убрать фото"
                    onClick={(e) => {
                      e.stopPropagation();
                      patch(t.id, { photo: undefined, focus: undefined });
                    }}
                  >
                    ✕
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
