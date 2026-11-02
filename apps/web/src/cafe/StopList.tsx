import { useState } from 'react';
import type { ProductView } from '@bills/domain';
import { command } from '../api.ts';
import { Modal } from '../cash/Modal.tsx';
import { sortCatalog, useCatalog } from '../pages/bar/useCatalog.tsx';

/**
 * «Стоп-лист» on the barista's screen (`catalog.stop`): put a product off the counter when it
 * runs out and back when it is there again. Only this — prices and the menu itself are the
 * manager's and the administrator's («Меню», `catalog.edit`).
 */
export function StopListDialog({ actor, onClose, notify }: { actor: string; onClose: () => void; notify: (m: string) => void }) {
  const { catalog, error, reload } = useCatalog();
  const [busy, setBusy] = useState<string | null>(null);
  const sorted = catalog ? sortCatalog(catalog) : null;
  const categories = sorted ? sorted.categories.filter((c) => c.isActive) : [];

  const toggle = async (p: ProductView) => {
    if (busy) return;
    setBusy(p.id);
    try {
      // Only `isActive`: the HUB takes this as the stop list, not a menu edit.
      await command<ProductView>(`/api/bar/products/${p.id}/update`, actor, { isActive: !p.isActive });
      notify(p.isActive ? `«${p.name}» — нет в наличии` : `«${p.name}» снова в продаже`);
      await reload();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Стоп-лист" onClose={onClose} className="modal-wide">
      <p className="hint">Нажмите на позицию, которая закончилась: на кассе она пропадёт. Нажмите ещё раз, когда появится.</p>
      {error ? (
        <p className="form-error">{error}</p>
      ) : !sorted ? (
        <p className="muted">Загрузка…</p>
      ) : (
        categories.map((c) => {
          const items = sorted.products.filter((p) => p.categoryId === c.id);
          if (items.length === 0) return null;
          return (
            <section key={c.id} className="stop-group" aria-label={c.name}>
              <h3 className="cash-sub">{c.name}</h3>
              <ul className="stop-list">
                {items.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="stop-item"
                      aria-pressed={!p.isActive}
                      disabled={busy !== null}
                      onClick={() => void toggle(p)}
                    >
                      <span>{p.name}</span>
                      <span className={`tag ${p.isActive ? 'tag-ok' : 'tag-danger'}`}>{p.isActive ? 'есть' : 'нет в наличии'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </Modal>
  );
}
