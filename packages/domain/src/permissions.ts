/**
 * Who may do what. One table for the HUB and every screen: the UI hides or
 * disables buttons by it, and the HUB enforces it on every route (http/command.ts)
 * for the employee signed in with an access key.
 */

export const ROLES = ['owner', 'manager', 'cashier', 'waiter', 'superadmin'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Владелец',
  manager: 'Управляющий',
  cashier: 'Кассир',
  waiter: 'Официант',
  superadmin: 'Платформа',
};

/** Roles a person with the given role may assign to others. */
export const ASSIGNABLE_ROLES: Record<Role, readonly Role[]> = {
  owner: ['owner', 'manager', 'cashier', 'waiter'],
  manager: ['manager', 'cashier', 'waiter'],
  cashier: [],
  waiter: [],
  superadmin: ['owner', 'manager', 'cashier', 'waiter', 'superadmin'],
};

const STAFF: readonly Role[] = ['owner', 'manager', 'cashier', 'waiter'];
const CASH: readonly Role[] = ['owner', 'manager', 'cashier'];
const ADMIN: readonly Role[] = ['owner', 'manager'];
const OWNER: readonly Role[] = ['owner'];
const NOBODY: readonly Role[] = [];

/**
 * action → roles allowed to do it. The platform super admin (our support)
 * may do everything, see `can`.
 */
export const ACTIONS = {
  // Hall
  'hall.view': STAFF,
  'hall.edit': ADMIN, // floor plan editor
  'checks.view': CASH, // unpaid and paid checks of the day
  'stats.view': CASH, // day summary
  'tariffs.view': STAFF, // read-only tariff map and calculator
  'equipment.view': ADMIN, // lamps, controller, simulator
  'table.open': STAFF,
  'table.stop': STAFF,
  'alert.resolve': CASH,
  // Bar
  'order.create': STAFF,
  'order.cancel': CASH,
  'catalog.view': STAFF,
  'catalog.edit': ADMIN,
  // Club settings
  'settings.view': ADMIN,
  'club.edit': OWNER, // name, time zone, currency
  'tables.edit': ADMIN,
  'tariffs.edit': ADMIN,
  'display.edit': ADMIN, // hall screen look
  'rules.edit': ADMIN,
  // Staff
  'staff.view': ADMIN,
  'staff.edit': ADMIN,
  'audit.view': ADMIN,
  // Money (stage 2 screens)
  'shift.open': CASH,
  'shift.close': CASH,
  'payment.take': CASH,
  'discount.apply': ADMIN,
  'refund.approve': ADMIN,
  'cancel.approve': ADMIN,
  // Cash desk (stage 2 HTTP): checks and the cash shift
  'check.edit': CASH, // create a check, add or remove its lines
  'game.cancel': CASH, // void an unpaid game (the domain still asks for a manager's approval)
  'shift.cash': CASH, // cash in / cash out of the drawer
  // Equipment and power (stages 5 and 7)
  'lamp.blink': ADMIN, // flash a lamp from the screen
  'lamps.manual': CASH, // switch the emergency manual mode on
  'lamps.manual_off': ADMIN, // …and off: the controller is back
  'power.edit': ADMIN, // what to do with games on power loss
  // Owner cabinet and platform
  'reports.view': ADMIN,
  'company.view': OWNER,
  'platform.view': NOBODY,
} as const satisfies Record<string, readonly Role[]>;

export type Action = keyof typeof ACTIONS;

export const ACTION_NAMES = Object.keys(ACTIONS) as Action[];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** True when the role may perform the action. Unknown or missing role → false. */
export function can(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  if (role === 'superadmin') return true;
  return (ACTIONS[action] as readonly Role[]).includes(role);
}

export function allowedActions(role: Role | null | undefined): Action[] {
  return ACTION_NAMES.filter((a) => can(role, a));
}

/** May `by` give `target` role to someone (create or change)? */
export function canAssignRole(by: Role | null | undefined, target: Role): boolean {
  if (!by) return false;
  return ASSIGNABLE_ROLES[by].includes(target);
}
