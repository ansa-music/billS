import type { CounterLineInput, ProductOptionGroup } from '@bills/domain';
import { CafeError, orderItemAmount, priceLine, validateCounterLines } from '@bills/domain';
import type { Db } from './db.ts';
import { all, one, run } from './db.ts';
import { HubError } from './errors.ts';

/**
 * Lines of a bar order — on a game or at the counter: priced from the menu with the
 * chosen options (snapshot), checked against stock, written and given back to stock.
 * Plain functions: the bar and counter services call them inside their transactions.
 */

export interface ProductRow {
  id: string;
  club_id: string;
  category_id: string;
  name: string;
  price: number;
  is_active: number;
  stock: number | null;
  sort_order: number;
  /** JSON array of ProductOptionGroup. */
  options: string;
}

export interface PricedOrderLine {
  product: ProductRow;
  qty: number;
  /** Unit price with the options, snapshot. */
  price: number;
  amount: number;
  /** «Капучино · L · Овсяное». */
  title: string;
  optionNames: string[];
}

/** Option groups as stored; a damaged value reads as none rather than breaking the menu. */
export function parseOptions(raw: string | null | undefined): ProductOptionGroup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ProductOptionGroup[]) : [];
  } catch {
    return [];
  }
}

/** Names of the chosen options as stored on a line (JSON); [] for old lines. */
export function parseOptionNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Validates and prices the lines: every product active in an active category, the
 * options valid for it (422 OPTION_*), enough stock for all lines of a product
 * together (409 OUT_OF_STOCK).
 */
export function priceOrderLines(db: Db, club: string, items: readonly CounterLineInput[]): PricedOrderLine[] {
  const problems = validateCounterLines(items);
  if (problems.length) throw new HubError(422, 'ORDER_INVALID', problems.join('; '));
  const wanted = new Map<string, number>();
  const lines = items.map((it) => {
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
    let priced;
    try {
      priced = priceLine({ name: p.name, price: p.price, options: parseOptions(p.options) }, it.options ?? []);
    } catch (e) {
      if (e instanceof CafeError) throw new HubError(422, e.code, e.message);
      throw e;
    }
    const total = (wanted.get(p.id) ?? 0) + it.qty;
    wanted.set(p.id, total);
    if (p.stock !== null && total > p.stock) {
      throw new HubError(409, 'OUT_OF_STOCK', `Нет в наличии: ${p.name} (осталось ${p.stock})`);
    }
    return {
      product: p,
      qty: it.qty,
      price: priced.unitPrice,
      amount: orderItemAmount(priced.unitPrice, it.qty),
      title: priced.title,
      optionNames: priced.optionNames,
    };
  });
  return lines;
}

/** Writes the lines of a new order and takes tracked stock down. */
export function insertOrderLines(db: Db, orderId: string, lines: readonly PricedOrderLine[], now: number): void {
  lines.forEach((line, i) => {
    // Line ids carry the line number so the lines keep the order they were taken in (views sort by created_at, id).
    run(
      db,
      `INSERT INTO bar_order_items (id, order_id, product_id, title, price, qty, amount, created_at, option_names)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `${orderId}-${String(i + 1).padStart(2, '0')}`,
      orderId,
      line.product.id,
      line.title,
      line.price,
      line.qty,
      line.amount,
      now,
      line.optionNames.length ? JSON.stringify(line.optionNames) : null,
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
}

/** Tracked stock of a cancelled order's lines comes back. */
export function returnOrderStock(db: Db, orderId: string, now: number): void {
  for (const it of all<{ product_id: string; qty: number }>(
    db,
    'SELECT product_id, qty FROM bar_order_items WHERE order_id = ?',
    orderId,
  )) {
    run(db, 'UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ? AND stock IS NOT NULL', it.qty, now, it.product_id);
  }
}

/** Lines for the audit record. */
export function auditLines(lines: readonly PricedOrderLine[]) {
  return lines.map((l) => ({
    productId: l.product.id,
    title: l.title,
    price: l.price,
    qty: l.qty,
    amount: l.amount,
    ...(l.optionNames.length ? { options: l.optionNames } : {}),
  }));
}
