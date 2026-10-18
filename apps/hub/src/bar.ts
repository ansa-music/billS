import { randomUUID } from 'node:crypto';
import type {
  CatalogView,
  CategoryView,
  CreateCategoryRequest,
  CreateOrderRequest,
  CreateProductRequest,
  OrderView,
  ProductView,
  UpdateCategoryRequest,
  UpdateProductRequest,
} from '@bills/domain';
import { CANCEL_REASON_MIN, ORDER_NOTE_MAX, orderItemAmount, orderTotal, validateOrderItems } from '@bills/domain';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import type { OrderRow, SessionRow } from './views.ts';
import { clubId, loadOrder, toOrderViews } from './views.ts';

export interface BarServiceDeps {
  db: Db;
  clock: Clock;
  events: HubEvents;
}

const CATEGORY_NAME_MAX = 60;
const PRODUCT_NAME_MAX = 80;

interface CategoryRow {
  id: string;
  club_id: string;
  name: string;
  sort_order: number;
  is_active: number;
}

interface ProductRow {
  id: string;
  club_id: string;
  category_id: string;
  name: string;
  price: number;
  is_active: number;
  stock: number | null;
  sort_order: number;
}

function toCategoryView(r: CategoryRow): CategoryView {
  return { id: r.id, name: r.name, sortOrder: r.sort_order, isActive: r.is_active === 1 };
}

function toProductView(r: ProductRow): ProductView {
  return {
    id: r.id,
    categoryId: r.category_id,
    name: r.name,
    price: r.price,
    isActive: r.is_active === 1,
    stock: r.stock,
    sortOrder: r.sort_order,
  };
}

function cleanName(raw: string | undefined, max: number, what: string): string {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (name.length === 0) throw new HubError(422, 'NAME_REQUIRED', `Укажите название ${what}`);
  if (name.length > max) throw new HubError(422, 'NAME_TOO_LONG', `Название ${what} — не длиннее ${max} символов`);
  return name;
}

function checkPrice(price: unknown): number {
  if (!Number.isInteger(price) || (price as number) < 0) {
    throw new HubError(422, 'PRICE_INVALID', 'Цена должна быть целым числом не меньше нуля');
  }
  return price as number;
}

function checkStock(stock: unknown): number | null {
  if (stock === null || stock === undefined) return null;
  if (!Number.isInteger(stock) || (stock as number) < 0) {
    throw new HubError(422, 'STOCK_INVALID', 'Остаток должен быть целым числом не меньше нуля');
  }
  return stock as number;
}

/**
 * Catalog (categories, products, stock) and orders on games. Every command
 * is one transaction with an audit record; the HUB exposes it as `hub.bar`.
 */
export class BarService {
  readonly deps: BarServiceDeps;

  constructor(deps: BarServiceDeps) {
    this.deps = deps;
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  /** Everything, inactive rows included: the admin page shows them. */
  catalog(): CatalogView {
    const db = this.deps.db;
    const club = clubId(db);
    const categories = all<CategoryRow>(
      db,
      'SELECT * FROM product_categories WHERE club_id = ? ORDER BY sort_order, name',
      club,
    ).map(toCategoryView);
    const products = all<ProductRow>(db, 'SELECT * FROM products WHERE club_id = ? ORDER BY sort_order, name', club).map(
      toProductView,
    );
    return { categories, products };
  }

  createCategory(input: CreateCategoryRequest & { actor: string }): CategoryView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const name = cleanName(input.name, CATEGORY_NAME_MAX, 'категории');
      this.#assertCategoryNameFree(club, name, null);
      const max =
        one<{ m: number | null }>(db, 'SELECT MAX(sort_order) AS m FROM product_categories WHERE club_id = ?', club)?.m ??
        0;
      const id = randomUUID();
      run(
        db,
        `INSERT INTO product_categories (id, club_id, name, sort_order, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        id,
        club,
        name,
        max + 1,
        now,
        now,
      );
      record(db, now, {
        actor: input.actor,
        action: 'category.created',
        entityType: 'category',
        entityId: id,
        data: { name, sortOrder: max + 1 },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'catalog' }));
      return this.#category(club, id);
    });
  }

  updateCategory(input: UpdateCategoryRequest & { id: string; actor: string }): CategoryView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const current = this.#categoryRow(club, input.id);
      const name = input.name === undefined ? current.name : cleanName(input.name, CATEGORY_NAME_MAX, 'категории');
      const isActive = input.isActive ?? current.is_active === 1;
      if (isActive && (name !== current.name || !current.is_active)) this.#assertCategoryNameFree(club, name, current.id);
      const sortOrder = input.sortOrder ?? current.sort_order;
      if (!Number.isInteger(sortOrder)) throw new HubError(422, 'SORT_INVALID', 'Порядок должен быть целым числом');
      run(
        db,
        'UPDATE product_categories SET name = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?',
        name,
        sortOrder,
        isActive ? 1 : 0,
        now,
        current.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'category.updated',
        entityType: 'category',
        entityId: current.id,
        data: { name, sortOrder, isActive, was: toCategoryView(current) },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'catalog' }));
      return this.#category(club, current.id);
    });
  }

  createProduct(input: CreateProductRequest & { actor: string }): ProductView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const category = this.#categoryRow(club, input.categoryId);
      const name = cleanName(input.name, PRODUCT_NAME_MAX, 'товара');
      const price = checkPrice(input.price);
      const stock = checkStock(input.stock);
      const max =
        one<{ m: number | null }>(db, 'SELECT MAX(sort_order) AS m FROM products WHERE category_id = ?', category.id)?.m ??
        0;
      const id = randomUUID();
      run(
        db,
        `INSERT INTO products (id, club_id, category_id, name, price, is_active, stock, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        id,
        club,
        category.id,
        name,
        price,
        stock,
        max + 1,
        now,
        now,
      );
      record(db, now, {
        actor: input.actor,
        action: 'product.created',
        entityType: 'product',
        entityId: id,
        data: { categoryId: category.id, name, price, stock, sortOrder: max + 1 },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'catalog' }));
      return this.#product(club, id);
    });
  }

  updateProduct(input: UpdateProductRequest & { id: string; actor: string }): ProductView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const current = this.#productRow(club, input.id);
      const categoryId = input.categoryId === undefined ? current.category_id : this.#categoryRow(club, input.categoryId).id;
      const name = input.name === undefined ? current.name : cleanName(input.name, PRODUCT_NAME_MAX, 'товара');
      const price = input.price === undefined ? current.price : checkPrice(input.price);
      const stock = input.stock === undefined ? current.stock : checkStock(input.stock);
      const sortOrder = input.sortOrder ?? current.sort_order;
      if (!Number.isInteger(sortOrder)) throw new HubError(422, 'SORT_INVALID', 'Порядок должен быть целым числом');
      const isActive = input.isActive ?? current.is_active === 1;
      run(
        db,
        `UPDATE products SET category_id = ?, name = ?, price = ?, stock = ?, sort_order = ?, is_active = ?, updated_at = ?
         WHERE id = ?`,
        categoryId,
        name,
        price,
        stock,
        sortOrder,
        isActive ? 1 : 0,
        now,
        current.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'product.updated',
        entityType: 'product',
        entityId: current.id,
        data: { categoryId, name, price, stock, sortOrder, isActive, was: toProductView(current) },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'catalog' }));
      return this.#product(club, current.id);
    });
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  /** Every order of a game, cancelled ones included, newest first. */
  ordersOfSession(sessionId: string): OrderView[] {
    const db = this.deps.db;
    const club = clubId(db);
    const session = one<{ id: string }>(db, 'SELECT id FROM table_sessions WHERE id = ? AND club_id = ?', sessionId, club);
    if (!session) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
    return toOrderViews(
      db,
      all<OrderRow>(db, 'SELECT * FROM bar_orders WHERE session_id = ? ORDER BY created_at DESC, id DESC', sessionId),
    );
  }

  /**
   * Adds an order to a running or stopped-but-unpaid game. Title and price of
   * every line are snapshots; tracked stock goes down right away.
   */
  createOrder(input: CreateOrderRequest & { sessionId: string; actor: string }): OrderView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const session = one<SessionRow>(
        db,
        'SELECT * FROM table_sessions WHERE id = ? AND club_id = ?',
        input.sessionId,
        club,
      );
      if (!session) throw new HubError(404, 'SESSION_NOT_FOUND', 'Игра не найдена');
      if (session.status !== 'ACTIVE' && session.status !== 'AWAITING_PAYMENT') {
        throw new HubError(409, 'SESSION_NOT_ORDERABLE', 'На эту игру нельзя добавить заказ');
      }

      const problems = validateOrderItems(input.items);
      if (problems.length) throw new HubError(422, 'ORDER_INVALID', problems.join('; '));

      const note = (input.note ?? '').trim();
      if (note.length > ORDER_NOTE_MAX) {
        throw new HubError(422, 'NOTE_TOO_LONG', `Комментарий — не длиннее ${ORDER_NOTE_MAX} символов`);
      }

      const lines = input.items.map((it) => {
        const p = one<ProductRow & { category_active: number }>(
          db,
          `SELECT p.*, c.is_active AS category_active FROM products p
           JOIN product_categories c ON c.id = p.category_id
           WHERE p.id = ? AND p.club_id = ?`,
          it.productId,
          club,
        );
        if (!p) throw new HubError(422, 'PRODUCT_NOT_AVAILABLE', 'Товар не найден в меню');
        if (!p.is_active || !p.category_active) {
          throw new HubError(422, 'PRODUCT_NOT_AVAILABLE', `Товар недоступен: ${p.name}`);
        }
        if (p.stock !== null && it.qty > p.stock) {
          throw new HubError(409, 'OUT_OF_STOCK', `Нет в наличии: ${p.name} (осталось ${p.stock})`);
        }
        return { product: p, qty: it.qty, price: p.price, amount: orderItemAmount(p.price, it.qty) };
      });

      const total = orderTotal(lines);
      const id = randomUUID();
      run(
        db,
        `INSERT INTO bar_orders (id, club_id, session_id, table_id, status, note, total, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`,
        id,
        club,
        session.id,
        session.table_id,
        note || null,
        total,
        now,
        input.actor,
        now,
      );
      lines.forEach((line, i) => {
        // Line ids carry the line number so the lines keep the waiter's order (views sort by created_at, id).
        run(
          db,
          `INSERT INTO bar_order_items (id, order_id, product_id, title, price, qty, amount, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          `${id}-${String(i + 1).padStart(2, '0')}`,
          id,
          line.product.id,
          line.product.name,
          line.price,
          line.qty,
          line.amount,
          now,
        );
        if (line.product.stock !== null) {
          run(
            db,
            'UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ? AND stock IS NOT NULL',
            line.qty,
            now,
            line.product.id,
          );
        }
      });
      record(db, now, {
        actor: input.actor,
        action: 'order.created',
        entityType: 'order',
        entityId: id,
        data: {
          sessionId: session.id,
          tableId: session.table_id,
          total,
          note: note || null,
          items: lines.map((l) => ({ productId: l.product.id, title: l.product.name, price: l.price, qty: l.qty, amount: l.amount })),
        },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'order', tableId: session.table_id }));
      return loadOrder(db, id);
    });
  }

  /** Cancels an open order with a reason while the game is not closed yet; tracked stock comes back. */
  cancelOrder(input: { orderId: string; reason: string; actor: string }): OrderView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const order = one<OrderRow>(db, 'SELECT * FROM bar_orders WHERE id = ? AND club_id = ?', input.orderId, club);
      if (!order) throw new HubError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
      const reason = (input.reason ?? '').trim();
      if (reason.length < CANCEL_REASON_MIN) throw new HubError(422, 'REASON_REQUIRED', 'Укажите причину');
      if (order.status !== 'OPEN') throw new HubError(409, 'ORDER_NOT_OPEN', 'Заказ уже отменён');
      const session = one<{ status: string }>(db, 'SELECT status FROM table_sessions WHERE id = ?', order.session_id);
      if (!session || session.status === 'CLOSED') {
        throw new HubError(409, 'SESSION_CLOSED', 'Игра уже закрыта — заказ нельзя отменить');
      }

      const items = all<{ product_id: string; qty: number }>(
        db,
        'SELECT product_id, qty FROM bar_order_items WHERE order_id = ?',
        order.id,
      );
      for (const it of items) {
        run(
          db,
          'UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ? AND stock IS NOT NULL',
          it.qty,
          now,
          it.product_id,
        );
      }
      run(
        db,
        `UPDATE bar_orders SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?
         WHERE id = ?`,
        now,
        input.actor,
        reason,
        now,
        order.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'order.cancelled',
        entityType: 'order',
        entityId: order.id,
        data: { sessionId: order.session_id, tableId: order.table_id, total: order.total, reason },
      });
      afterCommit(db, () => this.deps.events.changed({ kind: 'order', tableId: order.table_id }));
      return loadOrder(db, order.id);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  #categoryRow(club: string, id: string): CategoryRow {
    const row = one<CategoryRow>(this.deps.db, 'SELECT * FROM product_categories WHERE id = ? AND club_id = ?', id, club);
    if (!row) throw new HubError(404, 'CATEGORY_NOT_FOUND', 'Категория не найдена');
    return row;
  }

  #productRow(club: string, id: string): ProductRow {
    const row = one<ProductRow>(this.deps.db, 'SELECT * FROM products WHERE id = ? AND club_id = ?', id, club);
    if (!row) throw new HubError(404, 'PRODUCT_NOT_FOUND', 'Товар не найден');
    return row;
  }

  #category(club: string, id: string): CategoryView {
    return toCategoryView(this.#categoryRow(club, id));
  }

  #product(club: string, id: string): ProductView {
    return toProductView(this.#productRow(club, id));
  }

  /** Active categories must have distinct names (case-insensitive; SQLite's lower() is ASCII-only, so compare here). */
  #assertCategoryNameFree(club: string, name: string, exceptId: string | null): void {
    const wanted = name.toLocaleLowerCase('ru');
    const active = all<{ id: string; name: string }>(
      this.deps.db,
      'SELECT id, name FROM product_categories WHERE club_id = ? AND is_active = 1',
      club,
    );
    const clash = active.find((c) => c.id !== exceptId && c.name.toLocaleLowerCase('ru') === wanted);
    if (clash) throw new HubError(409, 'CATEGORY_EXISTS', `Категория «${name}» уже есть`);
  }
}
