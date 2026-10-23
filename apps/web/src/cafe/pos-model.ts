import type {
  CounterService,
  CreateCounterOrderRequest,
  Minor,
  PaymentMethod,
  PricedLine,
  ProductOptionGroup,
  ProductView,
} from '@bills/domain';
import { minorPerMajor, ORDER_NOTE_MAX, priceLine } from '@bills/domain';
import { optionsOf } from './cafe.ts';

/**
 * Pure rules of the counter screen («Касса»): the order being taken, how it
 * becomes one HUB request, search with layout typos, round cash sums, «Хиты»
 * and parked orders kept on this device. No React here.
 */

// ── The order being taken ───────────────────────────────────────────────────

/** One line on the counter screen. `id` is stable while its options change. */
export interface Line {
  id: string;
  productId: string;
  choices: string[];
  qty: number;
  /** Preset comments («без сахара») plus free text, for the barista. */
  comments: string[];
  text: string;
}

export interface Draft {
  lines: Line[];
  service: CounterService;
  guestName: string;
}

export const emptyDraft = (service: CounterService = 'TAKEAWAY'): Draft => ({ lines: [], service, guestName: '' });

/** Comment chips on a line; free text is typed next to them. */
export const COMMENT_PRESETS = ['без сахара', 'погорячее', 'без крышки', 'с собой в подставке'] as const;

let seq = 0;
export const lineId = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

export const sameChoices = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

export const lineComment = (l: Pick<Line, 'comments' | 'text'>) =>
  [...l.comments, l.text.trim()].filter((c) => c.length > 0).join(', ');

export function tryPrice(product: ProductView, choices: readonly string[]): { priced: PricedLine | null; problem: string | null } {
  try {
    return { priced: priceLine({ name: product.name, price: product.price, options: optionsOf(product) }, choices), problem: null };
  } catch (e) {
    return { priced: null, problem: (e as Error).message };
  }
}

/**
 * Toggles a choice the way the chips work: a single-choice group swaps, a
 * required group always keeps one, an optional one clears on a second tap,
 * a multiple-choice group toggles.
 */
export function toggleChoice(groups: readonly ProductOptionGroup[], choices: readonly string[], groupId: string, choiceId: string): string[] {
  const group = groups.find((g) => g.id === groupId);
  if (!group) return [...choices];
  const has = choices.includes(choiceId);
  if (group.multiple) return has ? choices.filter((c) => c !== choiceId) : [...choices, choiceId];
  const others = choices.filter((c) => !group.choices.some((gc) => gc.id === c));
  if (has) return group.required ? [...choices] : others;
  return [...others, choiceId];
}

/**
 * The HUB request for a draft. Lines with the same product and options are
 * one HUB line (the HUB refuses repeats); their comments go to the order note
 * as «1× Капучино · L: без сахара», which the barista sees on the card.
 */
export function buildRequest(
  draft: Draft,
  byId: ReadonlyMap<string, ProductView>,
  payment: CreateCounterOrderRequest['payment'],
): CreateCounterOrderRequest {
  const merged = new Map<string, { productId: string; choices: string[]; qty: number }>();
  const notes: string[] = [];
  for (const l of draft.lines) {
    const key = `${l.productId}\n${[...l.choices].sort().join('\n')}`;
    const m = merged.get(key);
    if (m) m.qty += l.qty;
    else merged.set(key, { productId: l.productId, choices: l.choices, qty: l.qty });
    const comment = lineComment(l);
    if (comment) {
      const product = byId.get(l.productId);
      const title = product ? (tryPrice(product, l.choices).priced?.title ?? product.name) : 'Позиция';
      notes.push(`${l.qty}× ${title}: ${comment}`);
    }
  }
  let note = notes.join('; ');
  if (note.length > ORDER_NOTE_MAX) note = `${note.slice(0, ORDER_NOTE_MAX - 1)}…`;
  const name = draft.guestName.trim();
  return {
    items: [...merged.values()].map((m) => ({ productId: m.productId, qty: m.qty, ...(m.choices.length ? { options: m.choices } : {}) })),
    service: draft.service,
    ...(name ? { guestName: name } : {}),
    ...(note ? { note } : {}),
    payment,
  };
}

/** Payment parts for a method: cash may be more than due (change), card and QR exactly due. */
export function paymentParts(
  total: Minor,
  method: PaymentMethod | null,
  tendered: Minor | null,
  split?: { cash: Minor; rest: 'CARD' | 'QR' },
): CreateCounterOrderRequest['payment'] {
  if (method === null) return null;
  if (total === 0) return { parts: [] };
  if (split) {
    const cash = Math.min(split.cash, total);
    const parts: Array<{ method: PaymentMethod; amount: Minor }> = [];
    if (cash > 0) parts.push({ method: 'CASH', amount: cash });
    if (total - cash > 0) parts.push({ method: split.rest, amount: total - cash });
    return { parts };
  }
  if (method === 'CASH') return { parts: [{ method, amount: Math.max(total, tendered ?? total) }] };
  return { parts: [{ method, amount: total }] };
}

// ── Cash ────────────────────────────────────────────────────────────────────

/** Round sums a guest is likely to hand over: the next 500, 1 000, 2 000, 5 000… above the total. */
export function quickTenders(total: Minor, currency: string, count = 4): Minor[] {
  const per = minorPerMajor(currency);
  const steps = ['USD', 'EUR', 'GBP'].includes(currency) ? [5, 10, 20, 50, 100] : [500, 1000, 2000, 5000, 10000, 20000];
  const out = new Set<Minor>();
  for (const step of steps) {
    const unit = step * per;
    const up = Math.ceil(total / unit) * unit;
    if (up > total) out.add(up);
  }
  return [...out].sort((a, b) => a - b).slice(0, count);
}

// ── Search ──────────────────────────────────────────────────────────────────

const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU = 'йцукенгшщзхъфывапролджэячсмитьбюё';
const EN_TO_RU = new Map([...EN].map((c, i) => [c, RU[i]!]));
const RU_TO_EN = new Map([...RU].map((c, i) => [c, EN[i]!]));

/** «rfgexbyj» → «капучино»: text typed with the wrong keyboard layout. */
export const enToRu = (s: string) => [...s].map((c) => EN_TO_RU.get(c) ?? c).join('');
export const ruToEn = (s: string) => [...s].map((c) => RU_TO_EN.get(c) ?? c).join('');

const TRANSLIT: Array<[string, string]> = [
  ['shch', 'щ'], ['sch', 'щ'], ['ch', 'ч'], ['sh', 'ш'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'],
  ['yu', 'ю'], ['ya', 'я'], ['yo', 'ё'], ['a', 'а'], ['b', 'б'], ['c', 'к'], ['d', 'д'], ['e', 'е'],
  ['f', 'ф'], ['g', 'г'], ['h', 'х'], ['i', 'и'], ['j', 'дж'], ['k', 'к'], ['l', 'л'], ['m', 'м'],
  ['n', 'н'], ['o', 'о'], ['p', 'п'], ['q', 'к'], ['r', 'р'], ['s', 'с'], ['t', 'т'], ['u', 'у'],
  ['v', 'в'], ['w', 'в'], ['x', 'кс'], ['y', 'й'], ['z', 'з'],
];

/** «kapuchino» → «капучино»: Latin spelling of a Russian name. */
export function translit(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const hit = TRANSLIT.find(([lat]) => s.startsWith(lat, i));
    if (hit) {
      out += hit[1];
      i += hit[0].length;
    } else out += s[i++];
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Letters of `q` appear in `s` in order («кпчн» ⊂ «капучино»). */
function subsequence(s: string, q: string): boolean {
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length;
}

/**
 * How well a product name matches what was typed; 0 = not at all. Exact
 * substring beats a word start beats letters in order; the query is also
 * tried in the other keyboard layout and as Latin transliteration.
 */
export function matchScore(name: string, query: string): number {
  const n = norm(name);
  const q = norm(query);
  if (!q) return 1;
  const variants = [...new Set([q, norm(enToRu(q)), norm(ruToEn(q)), norm(translit(q))])];
  let best = 0;
  for (const v of variants) {
    if (!v) continue;
    if (n.startsWith(v) || n.split(' ').some((w) => w.startsWith(v))) best = Math.max(best, 3);
    else if (n.includes(v)) best = Math.max(best, 2);
    else if (v.length >= 3 && subsequence(n, v)) best = Math.max(best, 1);
  }
  return best;
}

export function searchProducts(products: readonly ProductView[], query: string): ProductView[] {
  return products
    .map((p) => ({ p, s: matchScore(p.name, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p);
}

// ── Device memory: «Хиты», parked orders, last order, settings ──────────────

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: the memory lasts until the page is closed.
  }
}

const HITS_KEY = 'bills.cafe.hits.v1';
const HELD_KEY = 'bills.cafe.held.v1';
const LAST_KEY = 'bills.cafe.last.v1';
const PRINT_KEY = 'bills.cafe.autoprint';

/** Sales a week ago count half: «Хиты» follow what sells now. */
const HALF_LIFE_MS = 7 * 24 * 3600_000;

type Hits = Record<string, { n: number; t: number }>;

const decayed = (h: { n: number; t: number }, now: number) => h.n * 0.5 ** ((now - h.t) / HALF_LIFE_MS);

export function recordHits(lines: readonly Pick<Line, 'productId' | 'qty'>[], now = Date.now()): void {
  const hits = read<Hits>(HITS_KEY, {});
  for (const l of lines) {
    const h = hits[l.productId];
    hits[l.productId] = { n: (h ? decayed(h, now) : 0) + l.qty, t: now };
  }
  write(HITS_KEY, hits);
}

/**
 * The «Хиты» tab: what this counter sold most lately, then the first products
 * of each category so a new device is not empty.
 */
export function topProducts(products: readonly ProductView[], limit = 12, now = Date.now()): ProductView[] {
  const hits = read<Hits>(HITS_KEY, {});
  const ranked = products
    .filter((p) => hits[p.id])
    .map((p) => ({ p, n: decayed(hits[p.id]!, now) }))
    .sort((a, b) => b.n - a.n)
    .map((x) => x.p);
  const out = ranked.slice(0, limit);
  if (out.length < limit) {
    const byCategory = new Map<string, ProductView[]>();
    for (const p of products) {
      if (out.includes(p)) continue;
      const list = byCategory.get(p.categoryId) ?? [];
      list.push(p);
      byCategory.set(p.categoryId, list);
    }
    // Round-robin: the first coffee, the first tea, the first pastry, then the second ones.
    for (let i = 0; out.length < limit; i++) {
      let added = false;
      for (const list of byCategory.values()) {
        if (list[i] && out.length < limit) {
          out.push(list[i]!);
          added = true;
        }
      }
      if (!added) break;
    }
  }
  return out;
}

/** A parked order: the guest went for a card, the queue moves on. */
export interface Held {
  id: string;
  at: number;
  draft: Draft;
  /** A request that failed keeps its idempotency key: sending the same order again is not a second one. */
  key?: { body: string; key: string };
  /** Why it is here when a payment did not go through. */
  failed?: string;
}

export const HELD_MAX = 8;
export const readHeld = () => read<Held[]>(HELD_KEY, []);
export const writeHeld = (held: readonly Held[]) => write(HELD_KEY, held.length ? held : null);

export const readLast = () => read<Draft | null>(LAST_KEY, null);
export const writeLast = (draft: Draft) => write(LAST_KEY, draft);

export const readAutoPrint = () => read<boolean>(PRINT_KEY, false);
export const writeAutoPrint = (on: boolean) => write(PRINT_KEY, on);

// ── Look ────────────────────────────────────────────────────────────────────

/** Category accent hues (OKLCH): coffee amber, tea green, pastry red, then the rest. */
const HUES = [55, 150, 25, 285, 220, 340, 100, 190];

export const categoryHue = (index: number) => HUES[((index % HUES.length) + HUES.length) % HUES.length]!;

/** Stock at or below this shows «ост. N» on the tile. */
export const LOW_STOCK = 3;
