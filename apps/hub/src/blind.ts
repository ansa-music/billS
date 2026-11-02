import type { Business, CloseShiftResponse, RoleSet, ShiftView } from '@bills/domain';
import { can } from '@bills/domain';

/**
 * Blind cash count: someone without `shift.report` (a cashier; in a billiard club a barista too)
 * opens and closes the shift and enters the counted cash, but never sees what the drawer should
 * hold or the shift's money. Every route that hands out a shift passes it through here. A coffee
 * shop's barista has `shift.report` (CAFE_GRANTS): often alone at the counter, they close the day.
 */
export function shiftFor(roles: RoleSet, shift: ShiftView, business: Business): ShiftView;
export function shiftFor(roles: RoleSet, shift: ShiftView | null, business: Business): ShiftView | null;
export function shiftFor(roles: RoleSet, shift: ShiftView | null, business: Business): ShiftView | null {
  if (!shift || can(roles, 'shift.report', business)) return shift;
  return { ...shift, expectedCash: null, difference: null };
}

/** The close of a shift: the Z report only for `shift.report`. */
export function closeFor(roles: RoleSet, res: CloseShiftResponse, business: Business): CloseShiftResponse {
  if (can(roles, 'shift.report', business)) return res;
  return { shift: shiftFor(roles, res.shift, business), report: null };
}
