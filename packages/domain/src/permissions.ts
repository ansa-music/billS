/**
 * Who may do what. One table for the HUB, the cloud and every screen: the UI
 * hides or disables buttons by it, the HUB enforces it on every route
 * (http/command.ts) for the person signed in with a key.
 *
 * Two sides:
 *  - the platform: the owner of TS (`owner`) and the support team (`tech`) —
 *    long keys, they manage clients and their licenses;
 *  - a client: the manager (`manager`, the company that bought TS) and the
 *    staff the manager hires in a branch. A staff member holds a *set* of roles
 *    (waiter + cashier…); their rights are the union.
 */

import type { BusinessType } from './cafe.ts';

/**
 * The kind of venue a check is made for (club setting `business.type`). Words and a few rights
 * differ in a coffee shop (CAFE_ROLE_LABEL, CAFE_ASSIGNABLE_ROLES, CAFE_GRANTS); null or absent
 * means a billiard club, whose words and rights are the defaults.
 */
export type Business = BusinessType | null | undefined;

export const PLATFORM_ROLES = ['owner', 'tech'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Roles of the people a manager hires in a branch. Any non-empty combination. */
export const STAFF_ROLES = ['admin', 'senior', 'cashier', 'bartender', 'waiter'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLES = ['owner', 'tech', 'manager', ...STAFF_ROLES] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Владелец платформы',
  tech: 'Техподдержка',
  manager: 'Управляющий',
  admin: 'Администратор',
  senior: 'Старший смены',
  cashier: 'Кассир',
  bartender: 'Бармен / бариста',
  waiter: 'Официант',
};

/**
 * A coffee shop names its people its own way (client feedback): the company's manager is
 * «Директор», the branch administrator is «Управляющий», the bartender is «Бариста». The role
 * codes stay the same; only the words differ, and only in a coffee shop.
 */
export const CAFE_ROLE_LABEL: Partial<Record<Role, string>> = {
  manager: 'Директор',
  admin: 'Управляющий',
  bartender: 'Бариста',
};

/** The word for a role in this kind of venue; billiard words by default. */
export function roleLabel(role: Role, business?: Business): string {
  return (business === 'cafe' ? CAFE_ROLE_LABEL[role] : undefined) ?? ROLE_LABEL[role];
}

/** Roles that stand alone: a person is the owner, or tech, or a manager — never combined. */
export const EXCLUSIVE_ROLES: readonly Role[] = ['owner', 'tech', 'manager'];

/** Roles that sign in with a long key (OWNER-…, TECH-…, MGR-…); everyone else gets a short one. */
export const LONG_KEY_ROLES: readonly Role[] = ['owner', 'tech', 'manager'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isPlatformRole(role: Role): role is PlatformRole {
  return (PLATFORM_ROLES as readonly Role[]).includes(role);
}

export function isStaffRole(role: Role): role is StaffRole {
  return (STAFF_ROLES as readonly Role[]).includes(role);
}

/** A single role or a set, as screens and the HUB pass them around. */
export type RoleSet = Role | readonly Role[] | null | undefined;

function asList(roles: RoleSet): readonly Role[] {
  if (!roles) return [];
  return typeof roles === 'string' ? [roles] : roles;
}

/**
 * Validates and orders a role set: known roles, no duplicates, at least one,
 * an exclusive role (owner / tech / manager) alone. Returns the canonical list
 * (in ROLES order) or an error message in Russian.
 */
export function normalizeRoles(
  input: readonly unknown[],
  business?: Business,
): { ok: true; roles: Role[] } | { ok: false; message: string } {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, message: 'Выберите хотя бы одну роль' };
  const set = new Set<Role>();
  for (const r of input) {
    if (!isRole(r)) return { ok: false, message: 'Неизвестная роль' };
    set.add(r);
  }
  const roles = ROLES.filter((r) => set.has(r));
  const exclusive = roles.filter((r) => EXCLUSIVE_ROLES.includes(r));
  if (exclusive.length > 0 && roles.length > 1) {
    return { ok: false, message: `Роль «${roleLabel(exclusive[0]!, business)}» не совмещается с другими` };
  }
  return { ok: true, roles };
}

/** The role shown first and used for the key prefix: the highest in ROLES order. */
export function primaryRole(roles: RoleSet): Role | null {
  const list = asList(roles);
  return ROLES.find((r) => list.includes(r)) ?? null;
}

/** "Официант + кассир"; a coffee shop's words with `business = 'cafe'` («Бариста», «Директор»…). */
export function rolesLabel(roles: RoleSet, business?: Business): string {
  const list = ROLES.filter((r) => asList(roles).includes(r));
  if (list.length === 0) return '—';
  const text = list.map((r) => roleLabel(r, business).toLowerCase()).join(' + ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Does this person sign in with a long key (platform, manager) rather than a short one? */
export function usesLongKey(roles: RoleSet): boolean {
  return asList(roles).some((r) => LONG_KEY_ROLES.includes(r));
}

/** Roles a person with the given role may give to others (hire, edit, issue keys). */
export const ASSIGNABLE_ROLES: Record<Role, readonly Role[]> = {
  owner: ['owner', 'tech', 'manager', ...STAFF_ROLES],
  tech: ['manager', ...STAFF_ROLES],
  manager: [...STAFF_ROLES],
  admin: [],
  senior: [],
  cashier: [],
  bartender: [],
  waiter: [],
};

/**
 * A coffee shop: its «Управляющий» (admin) hires, edits and keys the staff below them — never
 * an administrator or a manager (client feedback). Everyone else as in ASSIGNABLE_ROLES.
 */
export const CAFE_ASSIGNABLE_ROLES: Partial<Record<Role, readonly Role[]>> = {
  admin: ['senior', 'cashier', 'bartender', 'waiter'],
};

/** Roles someone holding `role` may give in this kind of venue. */
export function assignableRoles(role: Role, business?: Business): readonly Role[] {
  return (business === 'cafe' ? CAFE_ASSIGNABLE_ROLES[role] : undefined) ?? ASSIGNABLE_ROLES[role];
}

/** May someone holding `by` give every role of `target` (create or change)? */
export function canAssignRoles(by: RoleSet, target: RoleSet, business?: Business): boolean {
  const mine = asList(by);
  const theirs = asList(target);
  if (mine.length === 0 || theirs.length === 0) return false;
  return theirs.every((t) => mine.some((m) => isRole(m) && assignableRoles(m, business).includes(t)));
}

/** Kept for older call sites: one target role. */
export function canAssignRole(by: RoleSet, target: Role, business?: Business): boolean {
  return canAssignRoles(by, [target], business);
}

const PLATFORM: readonly Role[] = ['owner', 'tech'];
const M: readonly Role[] = ['manager'];
/** Everyone working in a branch. */
const STAFF: readonly Role[] = [...M, ...STAFF_ROLES];
const FLOOR: readonly Role[] = [...M, 'admin', 'senior', 'cashier', 'waiter'];
const CASH: readonly Role[] = [...M, 'admin', 'senior', 'cashier'];
const SENIOR: readonly Role[] = [...M, 'admin', 'senior'];
const ADMIN: readonly Role[] = [...M, 'admin'];
const BAR: readonly Role[] = [...M, 'admin', 'senior', 'cashier', 'bartender', 'waiter'];
/** The stop list: whoever stands at the bar (a barista included) puts a product off and back. */
const BAR_STOP: readonly Role[] = [...M, 'admin', 'senior', 'cashier', 'bartender'];
/**
 * The counter of a coffee shop: the cashier, the barista and the waiter take orders and move them
 * along. A coffee shop has no tables to serve, so without these a waiter would see no page at all;
 * the counter exists only in a coffee shop (`business.type = cafe`). Taking the money with the
 * order also needs `payment.take` (the HUB checks both): a plain waiter sends the order to the
 * barista without payment and the till settles the check later.
 */
const COUNTER: readonly Role[] = [...CASH, 'bartender', 'waiter'];

/**
 * action → roles allowed to do it. The platform roles (owner, tech) may do
 * everything in a club; see `can`. Platform-only actions list them explicitly.
 */
export const ACTIONS = {
  // Hall
  'hall.view': STAFF,
  'hall.edit': ADMIN, // floor plan editor
  // Checks of the day, one by one (no day or shift totals): the cash desk and the barista.
  'checks.view': [...CASH, 'bartender'],
  // Money of the day and the shift: revenue, X and Z reports, cash expected in the drawer.
  // Not for a cashier or a barista: they count the drawer blind at close.
  'stats.view': SENIOR,
  'tariffs.view': STAFF, // read-only tariff map and calculator
  'equipment.view': SENIOR, // lamps, controller, simulator
  'table.open': FLOOR, // start a new game
  'table.continue': FLOOR, // pause, resume, transfer a game that is already running
  'table.stop': FLOOR,
  'alert.resolve': CASH,
  // Bar
  'order.create': BAR,
  'order.cancel': [...CASH, 'bartender'],
  'catalog.view': STAFF,
  // The menu itself (prices, products, categories, tile looks): a barista does not change it.
  'catalog.edit': ADMIN,
  // Stop list: put a product off the menu and back when it runs out («нет в наличии»).
  'catalog.stop': BAR_STOP,
  // Coffee shop counter (cafe.ts)
  'counter.take': COUNTER, // take an order at the counter (POST /api/counter/orders); its payment also needs payment.take
  'counter.stage': COUNTER, // move an order NEW → PREPARING → READY → ISSUED
  // Cancel (delete) a counter order or a coffee shop check: only the manager and the administrator.
  // Nothing is erased: the order stays CANCELLED with who and why, and shows in «Архив».
  'counter.cancel': ADMIN,
  // Raw materials of a coffee shop (stock.ts): levels, recipes, deliveries, counts.
  'stock.view': SENIOR, // levels, movements, recipes, counts
  'stock.edit': ADMIN, // ingredients, recipes (граммовка), inventory counts
  'stock.supply': [...M, 'admin', 'senior', 'cashier', 'bartender'], // receive a delivery (a barista too)
  'stock.writeoff': SENIOR, // write off spilled or spoilt stock, with a reason
  // Club settings
  'settings.view': ADMIN,
  'club.edit': M, // name, time zone, currency
  'tables.edit': ADMIN,
  'tariffs.edit': ADMIN,
  'display.edit': ADMIN, // hall screen look
  'rules.edit': ADMIN,
  // Staff
  'staff.view': ADMIN,
  'staff.edit': M, // hire, change roles, issue and revoke keys (a coffee shop's admin too: CAFE_GRANTS)
  // Remove a person for good: gone from the staff list, the login and every picker; the name stays in
  // the journal, receipts and reports. Only in a coffee shop (CAFE_ONLY_ACTIONS), only its director.
  'staff.delete': M,
  'audit.view': SENIOR,
  // Money
  'shift.open': CASH,
  'shift.close': CASH,
  'payment.take': CASH,
  'discount.apply': SENIOR,
  'refund.approve': SENIOR,
  'cancel.approve': SENIOR,
  'check.edit': CASH, // create a check, add or remove its lines
  'game.cancel': CASH, // void an unpaid game (the domain still asks for an approval)
  'shift.cash': CASH, // cash in / cash out of the drawer
  // The shift's money: cash expected in the drawer, the X and Z reports (screen and print). Whoever
  // opens and closes a shift without it counts the drawer blind (apps/hub/src/blind.ts).
  'shift.report': SENIOR,
  // Equipment and power
  'lamp.blink': SENIOR,
  'lamps.manual': CASH, // switch the emergency manual mode on
  'lamps.manual_off': SENIOR, // …and off: the controller is back
  'power.edit': ADMIN,
  // Company (the client) and the license
  'reports.view': ADMIN,
  'company.view': M,
  'branches.edit': M, // create branches within the license
  'license.view': M,
  'license.install': M, // paste a signed license into this HUB (the signature is what counts)
  // Platform (TS side)
  'platform.view': PLATFORM,
  'clients.edit': PLATFORM, // create clients, extend or block their licenses
  'platform.staff': ['owner'], // hire the support team
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof ACTIONS;

export const ACTION_NAMES = Object.keys(ACTIONS) as Action[];

/**
 * A coffee shop adds these rights on top of ACTIONS (client feedback):
 *  - the barista is often alone at the counter: opens and closes the cash shift, counts the
 *    drawer, takes the X and Z reports, and settles a «счёт потом» check (a shift does not close
 *    while one is open; the counter already takes payment) — still no menu, revenue page,
 *    refunds, discounts, staff or settings;
 *  - the waiter takes an order with its money (card, QR, cash), as the counter always allowed;
 *    without an open shift they still send it to the barista «без оплаты»;
 *  - its «Управляющий» (admin) hires and keys the staff below them (CAFE_ASSIGNABLE_ROLES).
 */
export const CAFE_GRANTS: Partial<Record<Action, readonly Role[]>> = {
  'shift.open': ['bartender'],
  'shift.close': ['bartender'],
  'shift.cash': ['bartender'],
  'shift.report': ['bartender'],
  'payment.take': ['bartender', 'waiter'],
  'staff.edit': ['admin'],
};

/** Actions that exist only in a coffee shop: nobody may do them in a billiard club, the platform neither. */
export const CAFE_ONLY_ACTIONS: ReadonlySet<Action> = new Set<Action>(['staff.delete']);

const PLATFORM_ONLY: ReadonlySet<Action> = new Set<Action>(['platform.view', 'clients.edit', 'platform.staff']);

function roleCan(role: Role, action: Action): boolean {
  if (role === 'owner') return true;
  if (role === 'tech') return action !== 'platform.staff';
  if (PLATFORM_ONLY.has(action)) return false;
  return (ACTIONS[action] as readonly Role[]).includes(role);
}

/**
 * True when any of the roles may perform the action (rights are the union). Unknown or missing → false.
 * `business` is the kind of venue: a coffee shop adds CAFE_GRANTS and opens CAFE_ONLY_ACTIONS;
 * without it (or for billiards) the table above is the whole answer.
 */
export function can(roles: RoleSet, action: Action, business?: Business): boolean {
  const cafe = business === 'cafe';
  if (!cafe && CAFE_ONLY_ACTIONS.has(action)) return false;
  const extra = cafe ? CAFE_GRANTS[action] : undefined;
  return asList(roles).some((r) => isRole(r) && (roleCan(r, action) || (extra?.includes(r) ?? false)));
}

export function allowedActions(roles: RoleSet, business?: Business): Action[] {
  return ACTION_NAMES.filter((a) => can(roles, a, business));
}

// ── License gate ────────────────────────────────────────────────────────────

/** Paid parts of TS a license switches on. */
export const LICENSE_MODULES = ['bar', 'cloud', 'hardware'] as const;
export type LicenseModule = (typeof LICENSE_MODULES)[number];

export const MODULE_LABEL: Record<LicenseModule, string> = {
  bar: 'Бар и меню',
  cloud: 'Облако и отчёты сети',
  hardware: 'Оборудование (лампы, ИБП)',
};

/** Actions that need a module; everything else is in every license. */
export const ACTION_MODULE: Partial<Record<Action, LicenseModule>> = {
  'order.create': 'bar',
  'order.cancel': 'bar',
  'catalog.view': 'bar',
  'catalog.edit': 'bar',
  'catalog.stop': 'bar',
  'counter.take': 'bar',
  'counter.cancel': 'bar',
  'counter.stage': 'bar',
  'stock.view': 'bar',
  'stock.edit': 'bar',
  'stock.supply': 'bar',
  'stock.writeoff': 'bar',
  'equipment.view': 'hardware',
  'lamp.blink': 'hardware',
  'power.edit': 'hardware',
};

/**
 * What still works when the license is over (or blocked, or missing): looking
 * at everything, finishing and paying for games already running, the cash
 * shift, alerts and the emergency manual mode. New games, orders and any
 * settings change are refused. Data is never deleted.
 */
export const READ_ONLY_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'hall.view',
  'checks.view',
  'stats.view',
  'tariffs.view',
  'equipment.view',
  'table.continue',
  'table.stop',
  'alert.resolve',
  'catalog.view',
  'counter.stage',
  'stock.view',
  'settings.view',
  'staff.view',
  'audit.view',
  'shift.open',
  'shift.close',
  'payment.take',
  'discount.apply',
  'refund.approve',
  'cancel.approve',
  'check.edit',
  'game.cancel',
  'shift.cash',
  'shift.report',
  'lamps.manual',
  'lamps.manual_off',
  'reports.view',
  'company.view',
  'license.view',
  'license.install',
  'platform.view',
  'clients.edit',
  'platform.staff',
]);

/** The part of a license status the permission check needs. null = licenses are not enforced here. */
export interface LicenseGate {
  readOnly: boolean;
  modules: Record<LicenseModule, boolean>;
}

export type Decision = 'ok' | 'forbidden' | 'read_only' | 'module_off';

/**
 * The full check: role first, then the license. The platform (owner, tech) is
 * never limited by a client's license — support must be able to fix things.
 */
export function decide(roles: RoleSet, action: Action, license: LicenseGate | null | undefined, business?: Business): Decision {
  if (!can(roles, action, business)) return 'forbidden';
  if (!license) return 'ok';
  if (asList(roles).some((r) => isPlatformRole(r))) return 'ok';
  const mod = ACTION_MODULE[action];
  if (mod && !license.modules[mod]) return 'module_off';
  if (license.readOnly && !READ_ONLY_ACTIONS.has(action)) return 'read_only';
  return 'ok';
}

/** `can` with the license applied, for screens: hide what the HUB would refuse anyway. */
export function canNow(roles: RoleSet, action: Action, license: LicenseGate | null | undefined, business?: Business): boolean {
  return decide(roles, action, license, business) === 'ok';
}
