import type { CloseShiftResponse, RoleSet, ShiftView } from '@bills/domain';
import { can } from '@bills/domain';

/**
 * Blind cash count: someone without `stats.view` (a cashier, a barista) opens and closes the
 * shift and enters the counted cash, but never sees what the drawer should hold or the
 * shift's money. Every route that hands out a shift passes it through here.
 */
export function shiftFor(roles: RoleSet, shift: ShiftView): ShiftView;
export function shiftFor(roles: RoleSet, shift: ShiftView | null): ShiftView | null;
export function shiftFor(roles: RoleSet, shift: ShiftView | null): ShiftView | null {
  if (!shift || can(roles, 'stats.view')) return shift;
  return { ...shift, expectedCash: null, difference: null };
}

/** The close of a shift: the Z report only for `stats.view`. */
export function closeFor(roles: RoleSet, res: CloseShiftResponse): CloseShiftResponse {
  if (can(roles, 'stats.view')) return res;
  return { shift: shiftFor(roles, res.shift), report: null };
}
