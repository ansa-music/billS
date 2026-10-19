import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { CategoryView, CreateProductRequest, ProductView, UpdateProductRequest } from '@bills/domain';
import { formatMoney } from '@bills/domain';
import { OfflineBanner } from '../OfflineBanner.tsx';
import { Empty, Field, Loading, Modal, Page, Section, Toast, useToast } from '../ui.tsx';
import { useCommands, useHub } from '../useHub.tsx';
import { parseMajor, toMajorText } from './bar/money.tsx';
import { sortCatalog, useCatalog } from './bar/useCatalog.tsx';
import './bar.css';

type Filter = 'all' | 'inactive' | string;

type CategoryDraft = { mode: 'new' } | { mode: 'edit'; category: CategoryView };
type ProductDraft = { mode: 'new'; categoryId: string } | { mode: 'edit'; product: ProductView };

/** Catalog admin (#/bar): categories, products, prices, stock. Owner and manager. */
export function BarMenuPage() {
  const { state, online, blockedReason } = useHub();
  const editBlocked = blockedReason('catalog.edit');
  const { toast, show, clear } = useToast();
  const { run, busy } = useCommands(show);
  const { catalog, error, reload } = useCatalog();
  const [filter, setFilter] = useState<Filter>('all');
  const [categoryDraft, setCategoryDraft] = useState<CategoryDraft | null>(null);
  const [productDraft, setProductDraft] = useState<ProductDraft | null>(null);

  const sorted = useMemo(() => (catalog ? sortCatalog(catalog) : null), [catalog]);
  const locked = busy.size > 0 || !online || editBlocked !== null;

  // The selected category may have been removed by another screen.
  useEffect(() => {
    if (filter !== 'all' && filter !== 'inactive' && sorted && !sorted.categories.some((c) => c.id === filter)) {
      setFilter('all');
    }
  }, [filter, sorted]);

  if (!state || !sorted) {
    return (
      <Page title="Бар и меню">
        {error ? <p className="bar-error">{error}</p> : <Loading online={online} />}
      </Page>
    );
  }

  const currency = state.club.currency;
  const categories = sorted.categories;
  const byId = new Map(categories.map((c) => [c.id, c]));
  const selectedCategory = filter !== 'all' && filter !== 'inactive' ? byId.get(filter) : undefined;

  const shown = sorted.products.filter((p) => {
    const categoryActive = byId.get(p.categoryId)?.isActive ?? false;
    if (filter === 'all') return p.isActive && categoryActive;
    if (filter === 'inactive') return !p.isActive || !categoryActive;
    return p.categoryId === filter;
  });

  const afterChange = async (message: string) => {
    show(message);
    await reload();
  };

  const toggleProduct = async (p: ProductView) => {
    const res = await run<ProductView>(`product:${p.id}`, `/api/bar/products/${p.id}/update`, { isActive: !p.isActive });
    if (res) await afterChange(res.isActive ? `«${res.name}» снова в меню` : `«${res.name}» скрыт из меню`);
  };

  return (
    <Page
      title="Бар и меню"
      subtitle="Категории, товары, цены и остатки. Официанты видят только активные товары активных категорий."
      actions={
        <>
          <button type="button" className="btn" disabled={locked} onClick={() => setCategoryDraft({ mode: 'new' })}>
            Добавить категорию
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={locked || categories.length === 0}
            onClick={() =>
              setProductDraft({ mode: 'new', categoryId: selectedCategory?.id ?? categories.find((c) => c.isActive)?.id ?? '' })
            }
          >
            Добавить товар
          </button>
        </>
      }
    >
      <OfflineBanner online={online} />
      {editBlocked && <p className="blocked-note">{editBlocked}</p>}
      {error && <p className="bar-error">{error}</p>}

      <Section
        title="Категории"
        aside={
          selectedCategory && (
            <button
              type="button"
              className="btn btn-small"
              disabled={locked}
              onClick={() => setCategoryDraft({ mode: 'edit', category: selectedCategory })}
            >
              Изменить «{selectedCategory.name}»
            </button>
          )
        }
      >
        <div className="bar-chips" role="group" aria-label="Категории">
          <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            Все
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className="chip"
              data-off={c.isActive ? undefined : ''}
              aria-pressed={filter === c.id}
              onClick={() => setFilter(c.id)}
            >
              {c.name}
              {!c.isActive && <span className="chip-note"> · выкл</span>}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={filter === 'inactive'} onClick={() => setFilter('inactive')}>
            Неактивные
          </button>
        </div>
        {categories.length === 0 && <Empty>Категорий пока нет — добавьте первую.</Empty>}
      </Section>

      <Section
        title={
          filter === 'all'
            ? 'Товары в меню'
            : filter === 'inactive'
              ? 'Скрытые товары'
              : `Товары: ${selectedCategory?.name ?? ''}`
        }
        aside={<span className="muted">{shown.length}</span>}
      >
        {shown.length === 0 ? (
          <Empty>
            {filter === 'inactive' ? 'Скрытых товаров нет.' : 'Товаров нет. Нажмите «Добавить товар».'}
          </Empty>
        ) : (
          <table className="bar-products">
            <thead>
              <tr>
                <th>Название</th>
                <th>Категория</th>
                <th className="num">Цена</th>
                <th>Остаток</th>
                <th>В меню</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const category = byId.get(p.categoryId);
                const hidden = !p.isActive || !(category?.isActive ?? false);
                return (
                  <tr key={p.id} data-inactive={hidden ? '' : undefined}>
                    <td className="cell-name">
                      <span className="bar-product-name">{p.name}</span>
                    </td>
                    <td className="cell-category">
                      <span className="cell-label">Категория: </span>
                      {category?.name ?? '—'}
                      {category && !category.isActive && <span className="tag tag-muted"> выкл</span>}
                    </td>
                    <td className="num cell-price">
                      <span className="bar-money">{formatMoney(p.price, currency)}</span>
                    </td>
                    <td className="cell-stock">
                      <span className="cell-label">Остаток: </span>
                      {p.stock === null ? (
                        <span className="muted">не учитывается</span>
                      ) : p.stock === 0 ? (
                        <span className="tag tag-danger">нет в наличии</span>
                      ) : (
                        <span className="bar-money">{p.stock} шт.</span>
                      )}
                    </td>
                    <td className="cell-active">
                      <label className="bar-switch" data-on={p.isActive ? '' : undefined}>
                        <input
                          type="checkbox"
                          checked={p.isActive}
                          disabled={locked}
                          onChange={() => void toggleProduct(p)}
                        />
                        {p.isActive ? 'в меню' : 'скрыт'}
                      </label>
                    </td>
                    <td className="cell-actions">
                      <div className="actions">
                        <button
                          type="button"
                          className="btn btn-small"
                          disabled={locked}
                          onClick={() => setProductDraft({ mode: 'edit', product: p })}
                        >
                          Изменить
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      {categoryDraft && (
        <CategoryModal
          draft={categoryDraft}
          busy={locked}
          onClose={() => setCategoryDraft(null)}
          onSave={async (body) => {
            const res =
              categoryDraft.mode === 'new'
                ? await run<CategoryView>('category', '/api/bar/categories', body)
                : await run<CategoryView>(
                    `category:${categoryDraft.category.id}`,
                    `/api/bar/categories/${categoryDraft.category.id}/update`,
                    body,
                  );
            if (!res) return;
            setCategoryDraft(null);
            if (categoryDraft.mode === 'new') setFilter(res.id);
            await afterChange(categoryDraft.mode === 'new' ? `Категория «${res.name}» добавлена` : 'Категория сохранена');
          }}
        />
      )}

      {productDraft && (
        <ProductModal
          draft={productDraft}
          categories={categories}
          currency={currency}
          busy={locked}
          onClose={() => setProductDraft(null)}
          onSave={async (body) => {
            const res =
              productDraft.mode === 'new'
                ? await run<ProductView>('product', '/api/bar/products', body)
                : await run<ProductView>(
                    `product:${productDraft.product.id}`,
                    `/api/bar/products/${productDraft.product.id}/update`,
                    body,
                  );
            if (!res) return;
            setProductDraft(null);
            await afterChange(productDraft.mode === 'new' ? `Товар «${res.name}» добавлен` : 'Товар сохранён');
          }}
        />
      )}

      <Toast message={toast} onClose={clear} />
    </Page>
  );
}

/** Like Field, but a <div>: for switches, which are labels of their own. */
function Block({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function CategoryModal({
  draft,
  busy,
  onClose,
  onSave,
}: {
  draft: CategoryDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (body: { name: string; sortOrder?: number; isActive?: boolean }) => Promise<void>;
}) {
  const editing = draft.mode === 'edit' ? draft.category : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [sortOrder, setSortOrder] = useState(editing ? String(editing.sortOrder) : '');
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Укажите название');
    if (trimmed.length > 60) return setError('Не длиннее 60 символов');
    const order = Number(sortOrder);
    if (editing && (!Number.isInteger(order) || order < 0)) return setError('Порядок — целое число');
    setError(null);
    void onSave(editing ? { name: trimmed, sortOrder: order, isActive } : { name: trimmed });
  };

  return (
    <Modal open title={editing ? 'Категория' : 'Новая категория'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Название" error={error}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus required />
        </Field>
        {editing && (
          <div className="form-row">
            <Field label="Порядок" hint="Меньше — выше в списке">
              <input type="number" min={0} step={1} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
            </Field>
            <Block label="Статус" hint="Товары выключенной категории официантам не предлагаются">
              <label className="bar-switch" data-on={isActive ? '' : undefined}>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                {isActive ? 'активна' : 'выключена'}
              </label>
            </Block>
          </div>
        )}
        <div className="row wrap modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editing ? 'Сохранить' : 'Добавить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ProductModal({
  draft,
  categories,
  currency,
  busy,
  onClose,
  onSave,
}: {
  draft: ProductDraft;
  categories: CategoryView[];
  currency: string;
  busy: boolean;
  onClose: () => void;
  onSave: (body: CreateProductRequest | UpdateProductRequest) => Promise<void>;
}) {
  const editing = draft.mode === 'edit' ? draft.product : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [categoryId, setCategoryId] = useState(draft.mode === 'edit' ? draft.product.categoryId : draft.categoryId);
  const [price, setPrice] = useState(editing ? toMajorText(editing.price, currency) : '');
  const [tracked, setTracked] = useState(editing ? editing.stock !== null : false);
  const [stock, setStock] = useState(editing?.stock != null ? String(editing.stock) : '0');
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [error, setError] = useState<string | null>(null);

  // A product may sit in a category that is now off: keep it selectable so the form can be saved as is.
  const options = categories.filter((c) => c.isActive || c.id === categoryId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return setError('Укажите название');
    if (trimmed.length > 80) return setError('Не длиннее 80 символов');
    if (!categoryId) return setError('Выберите категорию');
    const minor = parseMajor(price, currency);
    if (minor === null) return setError('Цена — число не меньше нуля, например 650 или 12,50');
    let stockValue: number | null = null;
    if (tracked) {
      const n = Number(stock);
      if (!Number.isInteger(n) || n < 0) return setError('Остаток — целое число не меньше нуля');
      stockValue = n;
    }
    setError(null);
    const body: CreateProductRequest | UpdateProductRequest = editing
      ? { name: trimmed, categoryId, price: minor, stock: stockValue, isActive }
      : { name: trimmed, categoryId, price: minor, stock: stockValue };
    void onSave(body);
  };

  return (
    <Modal open title={editing ? 'Товар' : 'Новый товар'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Название">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus required />
        </Field>
        <div className="form-row">
          <Field label="Категория">
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
              {!categoryId && <option value="">— выберите —</option>}
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {!c.isActive ? ' (выкл)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Цена, ${currency}`} hint="В обычных единицах: 650 или 12,50">
            <input
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0"
              required
            />
          </Field>
        </div>
        <div className="form-row">
          <Block label="Остаток" hint={tracked ? 'Списывается с каждым заказом' : 'Без учёта остатков'}>
            <div className="row wrap">
              <label className="bar-switch" data-on={tracked ? '' : undefined}>
                <input type="checkbox" checked={tracked} onChange={(e) => setTracked(e.target.checked)} />
                {tracked ? 'учитывать' : 'не учитывать'}
              </label>
              {tracked && (
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={stock}
                  onChange={(e) => setStock(e.target.value)}
                  aria-label="Остаток, шт."
                  style={{ width: 110 }}
                />
              )}
            </div>
          </Block>
          {editing && (
            <Block label="В меню">
              <label className="bar-switch" data-on={isActive ? '' : undefined}>
                <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                {isActive ? 'показывать' : 'скрыт'}
              </label>
            </Block>
          )}
        </div>
        {error && <p className="field-error">{error}</p>}
        <div className="row wrap modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editing ? 'Сохранить' : 'Добавить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
