import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTION_NAMES,
  ACTIONS,
  allowedActions,
  can,
  canAssignRole,
  canAssignRoles,
  canNow,
  decide,
  isRole,
  normalizeRoles,
  primaryRole,
  READ_ONLY_ACTIONS,
  ROLES,
  rolesLabel,
  usesLongKey,
} from '../src/permissions.ts';
import type { LicenseGate } from '../src/permissions.ts';

const allModules = { bar: true, cloud: true, hardware: true };

test('a waiter opens tables and takes orders but does not touch settings or money', () => {
  assert.ok(can('waiter', 'table.open'));
  assert.ok(can('waiter', 'order.create'));
  assert.ok(!can('waiter', 'order.cancel'));
  assert.ok(!can('waiter', 'settings.view'));
  assert.ok(!can('waiter', 'payment.take'));
  assert.ok(!can('waiter', 'audit.view'));
});

test('a cashier handles money and alerts but not tariffs, staff or approvals', () => {
  assert.ok(can('cashier', 'payment.take'));
  assert.ok(can('cashier', 'shift.open'));
  assert.ok(can('cashier', 'alert.resolve'));
  assert.ok(!can('cashier', 'tariffs.edit'));
  assert.ok(!can('cashier', 'staff.edit'));
  assert.ok(!can('cashier', 'refund.approve'));
});

test('several roles: rights are the union (waiter + cashier)', () => {
  const both = ['waiter', 'cashier'] as const;
  assert.ok(can(both, 'order.create'));
  assert.ok(can(both, 'payment.take'));
  assert.ok(can(both, 'table.open'));
  assert.ok(!can(both, 'refund.approve'));
  assert.ok(!can(both, 'staff.edit'));
  const union = new Set([...allowedActions('waiter'), ...allowedActions('cashier')]);
  assert.deepEqual(new Set(allowedActions(both)), union);
});

test('a bartender works the bar, not the tables or the till', () => {
  assert.ok(can('bartender', 'order.create'));
  assert.ok(can('bartender', 'catalog.edit'));
  assert.ok(!can('bartender', 'table.open'));
  assert.ok(!can('bartender', 'payment.take'));
});

test('the senior of a shift approves refunds and discounts; the admin runs settings', () => {
  assert.ok(can('senior', 'refund.approve'));
  assert.ok(can('senior', 'discount.apply'));
  assert.ok(!can('senior', 'tariffs.edit'));
  assert.ok(can('admin', 'tariffs.edit'));
  assert.ok(can('admin', 'staff.view'));
  assert.ok(!can('admin', 'staff.edit'));
  assert.ok(!can('admin', 'club.edit'));
});

test('the manager (the client) runs the company: branches, staff, club identity — not the platform', () => {
  for (const action of ACTION_NAMES) {
    const platformOnly = action === 'platform.view' || action === 'clients.edit' || action === 'platform.staff';
    assert.equal(can('manager', action), !platformOnly, action);
  }
});

test('the platform owner can do everything; tech everything but hiring the platform team', () => {
  for (const action of ACTION_NAMES) assert.ok(can('owner', action), action);
  assert.equal(allowedActions('owner').length, ACTION_NAMES.length);
  for (const action of ACTION_NAMES) assert.equal(can('tech', action), action !== 'platform.staff', action);
});

test('no role or an unknown role gets nothing', () => {
  assert.ok(!can(null, 'hall.view'));
  assert.ok(!can(undefined, 'hall.view'));
  assert.ok(!can([], 'hall.view'));
  assert.ok(!can(['superadmin' as never], 'hall.view'));
  assert.deepEqual(allowedActions(null), []);
  assert.ok(!isRole('superadmin'));
  assert.ok(isRole('tech'));
});

test('every action lists only known roles', () => {
  for (const [action, roles] of Object.entries(ACTIONS)) {
    for (const r of roles) assert.ok((ROLES as readonly string[]).includes(r), `${action}: ${r}`);
  }
});

test('who assigns whom: owner → anyone, tech → manager and staff, manager → staff, staff → nobody', () => {
  assert.ok(canAssignRole('owner', 'tech'));
  assert.ok(canAssignRole('owner', 'owner'));
  assert.ok(canAssignRole('tech', 'manager'));
  assert.ok(!canAssignRole('tech', 'owner'));
  assert.ok(!canAssignRole('tech', 'tech'));
  assert.ok(canAssignRoles('manager', ['waiter', 'cashier']));
  assert.ok(!canAssignRole('manager', 'manager'));
  assert.ok(!canAssignRoles('manager', ['waiter', 'tech']));
  assert.ok(!canAssignRole('admin', 'waiter'));
  assert.ok(!canAssignRole('cashier', 'waiter'));
  assert.ok(!canAssignRole(null, 'waiter'));
});

test('role sets: canonical order, no duplicates, exclusive roles alone', () => {
  assert.deepEqual(normalizeRoles(['waiter', 'cashier', 'waiter']), { ok: true, roles: ['cashier', 'waiter'] });
  assert.equal(normalizeRoles([]).ok, false);
  assert.equal(normalizeRoles(['nope']).ok, false);
  assert.equal(normalizeRoles(['manager', 'cashier']).ok, false);
  assert.equal(normalizeRoles(['owner', 'tech']).ok, false);
  assert.deepEqual(normalizeRoles(['manager']), { ok: true, roles: ['manager'] });
  assert.equal(primaryRole(['waiter', 'cashier']), 'cashier');
  assert.equal(rolesLabel(['waiter', 'cashier']), 'Кассир + официант');
  assert.ok(usesLongKey('manager'));
  assert.ok(!usesLongKey(['waiter', 'cashier']));
});

test('license over: read-only — running games finish and get paid, nothing new starts', () => {
  const ro: LicenseGate = { readOnly: true, modules: allModules };
  assert.equal(decide('cashier', 'table.open', ro), 'read_only');
  assert.equal(decide('cashier', 'order.create', ro), 'read_only');
  assert.equal(decide('manager', 'tariffs.edit', ro), 'read_only');
  assert.equal(decide('manager', 'staff.edit', ro), 'read_only');
  assert.equal(decide('cashier', 'table.stop', ro), 'ok');
  assert.equal(decide('cashier', 'table.continue', ro), 'ok');
  assert.equal(decide('cashier', 'payment.take', ro), 'ok');
  assert.equal(decide('cashier', 'shift.close', ro), 'ok');
  assert.equal(decide('waiter', 'hall.view', ro), 'ok');
  // Role comes first: a waiter is refused payments for their role, not the license.
  assert.equal(decide('waiter', 'payment.take', ro), 'forbidden');
  // The platform fixes things whatever the license says.
  assert.equal(decide('tech', 'table.open', ro), 'ok');
  assert.ok(!canNow('manager', 'table.open', ro));
  assert.ok(canNow('manager', 'table.open', null));
  for (const a of READ_ONLY_ACTIONS) assert.ok(ACTION_NAMES.includes(a), a);
});

test('modules: without the bar module there are no orders; without hardware no lamp controls', () => {
  const noBar: LicenseGate = { readOnly: false, modules: { bar: false, cloud: true, hardware: false } };
  assert.equal(decide('waiter', 'order.create', noBar), 'module_off');
  assert.equal(decide('manager', 'catalog.edit', noBar), 'module_off');
  assert.equal(decide('manager', 'lamp.blink', noBar), 'module_off');
  assert.equal(decide('waiter', 'table.open', noBar), 'ok');
  assert.equal(decide('owner', 'order.create', noBar), 'ok');
});
