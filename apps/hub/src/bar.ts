import { randomUUID } from 'node:crypto';
import type {
  CatalogView,
  CategoryView,
  CreateCategoryRequest,
  CreateOrderRequest,
  CreateProductRequest,
  OrderView,
  ProductOptionGroup,
  ProductView,
  UpdateCategoryRequest,
  UpdateProductRequest,
} from '@bills/domain';
import { CANCEL_REASON_MIN, normalizeOptionGroups, ORDER_NOTE_MAX, orderTotal, validateOptionGroups } from '@bills/domain';
import { attachOrder, detachOrder, netPaidOn, openCheckOfGame, voidCheckIfEmpty } from './check-orders.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { afterCommit, all, one, run, transaction } from './db.ts';
import { HubError } from './errors.ts';
import type { HubEvents } from './events.ts';
import { record } from './journal.ts';
import type { ProductRow } from './order-lines.ts';
import { auditLines, insertOrderLines, parseOptions, priceOrderLines, returnOrderStock } from './order-lines.ts';
import type { OrderRow, SessionRow } from './views.ts';
import { clubId, loadCheck, loadOrder, toOrderViews } from './views.ts';

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
    options: parseOptions(r.options),
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

/** Option groups from the menu editor, as stored (JSON); 422 OPTIONS_INVALID names every problem. */
function checkOptions(options: unknown): ProductOptionGroup[] {
  const problems = validateOptionGroups(options);
  if (problems.length) throw new HubError(422, 'OPTIONS_INVALID', problems.join('; '));
  return normalizeOptionGroups((options ?? []) as ProductOptionGroup[]);
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
      const options = checkOptions(input.options);
      const max =
        one<{ m: number | null }>(db, 'SELECT MAX(sort_order) AS m FROM products WHERE category_id = ?', category.id)?.m ??
        0;
      const id = randomUUID();
      run(
        db,
        `INSERT INTO products (id, club_id, category_id, name, price, is_active, stock, sort_order, created_at, updated_at, options)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        id,
        club,
        category.id,
        name,
        price,
        stock,
        max + 1,
        now,
        now,
        JSON.stringify(options),
      );
      record(db, now, {
        actor: input.actor,
        action: 'product.created',
        entityType: 'product',
        entityId: id,
        data: { categoryId: category.id, name, price, stock, sortOrder: max + 1, ...(options.length ? { options } : {}) },
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
      const options = input.options === undefined ? parseOptions(current.options) : checkOptions(input.options);
      run(
        db,
        `UPDATE products SET category_id = ?, name = ?, price = ?, stock = ?, sort_order = ?, is_active = ?, options = ?,
           updated_at = ?
         WHERE id = ?`,
        categoryId,
        name,
        price,
        stock,
        sortOrder,
        isActive ? 1 : 0,
        JSON.stringify(options),
        now,
        current.id,
      );
      record(db, now, {
        actor: input.actor,
        action: 'product.updated',
        entityType: 'product',
        entityId: current.id,
        data: { categoryId, name, price, stock, sortOrder, isActive, options, was: toProductView(current) },
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
   * every line are snapshots; tracked stock goes down right away. When the game is
   * already on an open check, the order joins that check at once.
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

      const note = (input.note ?? '').trim();
      if (note.length > ORDER_NOTE_MAX) {
        throw new HubError(422, 'NOTE_TOO_LONG', `Комментарий — не длиннее ${ORDER_NOTE_MAX} символов`);
      }
      const lines = priceOrderLines(db, club, input.items);

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
      insertOrderLines(db, id, lines, now);
      record(db, now, {
        actor: input.actor,
        action: 'order.created',
        entityType: 'order',
        entityId: id,
        data: { sessionId: session.id, tableId: session.table_id, total, note: note || null, items: auditLines(lines) },
      });
      const checkId = openCheckOfGame(db, session.id);
      if (checkId) {
        attachOrder(db, checkId, id, input.actor, now);
        loadCheck(db, checkId); // the stored discount must still fit
        afterCommit(db, () => this.deps.events.changed({ kind: 'check' }));
      }
      afterCommit(db, () => this.deps.events.changed({ kind: 'order', tableId: session.table_id }));
      return loadOrder(db, id);
    });
  }

  /**
   * Cancels an open order with a reason, only before it is paid: an order on a check
   * with money on it stays. Its lines leave the check; tracked stock comes back.
   */
  cancelOrder(input: { orderId: string; reason: string; actor: string }): OrderView {
    const db = this.deps.db;
    const now = this.deps.clock.now();
    return transaction(db, () => {
      const club = clubId(db);
      const order = one<OrderRow>(db, 'SELECT * FROM bar_orders WHERE id = ? AND club_id = ?', input.orderId, club);
      if (!order) throw new HubError(404, 'ORDER_NOT_FOUND', 'Заказ не найден');
      if (order.counter_number !== null) {
        throw new HubError(409, 'COUNTER_ORDER', 'Это заказ у стойки — отмените его на экране стойки');
      }
      const reason = (input.reason ?? '').trim();
      if (reason.length < CANCEL_REASON_MIN) throw new HubError(422, 'REASON_REQUIRED', 'Укажите причину');
      if (order.status !== 'OPEN') {
        throw new HubError(
          409,
          'ORDER_NOT_OPEN',
          order.status === 'CLOSED' ? 'Заказ уже оплачен — оформите возврат по счёту' : 'Заказ уже отменён',
        );
      }
      if (order.check_id && netPaidOn(db, order.check_id) > 0) {
        throw new HubError(409, 'CHECK_HAS_PAYMENTS', 'По счёту с этим заказом уже есть оплата — заказ нельзя отменить');
      }

      returnOrderStock(db, order.id, now);
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
        data: { sessionId: order.session_id, tableId: order.table_id, total: order.total, reason, checkId: order.check_id },
      });
      if (order.check_id) {
        detachOrder(db, order.id, input.actor, now);
        if (!voidCheckIfEmpty(db, order.check_id, input.actor, now)) loadCheck(db, order.check_id);
        afterCommit(db, () => this.deps.events.changed({ kind: 'check' }));
      }
      afterCommit(db, () => this.deps.events.changed({ kind: 'order', tableId: order.table_id ?? undefined }));
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
