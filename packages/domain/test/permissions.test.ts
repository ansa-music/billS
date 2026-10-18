import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_NAMES, ACTIONS, allowedActions, can, canAssignRole, isRole, ROLES } from '../src/permissions.ts';

test('a waiter opens tables and takes orders but does not touch settings or money', () => {
  assert.ok(can('waiter', 'table.open'));
  assert.ok(can('waiter', 'order.create'));
  assert.ok(!can('waiter', 'order.cancel'));
  assert.ok(!can('waiter', 'settings.view'));
  assert.ok(!can('waiter', 'payment.take'));
  assert.ok(!can('waiter', 'audit.view'));
});

test('a cashier handles money and alerts but not tariffs or staff', () => {
  assert.ok(can('cashier', 'payment.take'));
  assert.ok(can('cashier', 'shift.open'));
  assert.ok(can('cashier', 'alert.resolve'));
  assert.ok(!can('cashier', 'tariffs.edit'));
  assert.ok(!can('cashier', 'staff.edit'));
  assert.ok(!can('cashier', 'refund.approve'));
});

test('a manager runs the club but cannot change its identity or see the company', () => {
  assert.ok(can('manager', 'tariffs.edit'));
  assert.ok(can('manager', 'staff.edit'));
  assert.ok(can('manager', 'refund.approve'));
  assert.ok(can('manager', 'reports.view'));
  assert.ok(!can('manager', 'club.edit'));
  assert.ok(!can('manager', 'company.view'));
  assert.ok(!can('manager', 'platform.view'));
});

test('the owner can do everything except platform administration', () => {
  for (const action of ACTION_NAMES) {
    if (action === 'platform.view') assert.ok(!can('owner', action), action);
    else assert.ok(can('owner', action), action);
  }
});

test('the platform super admin can do everything, including platform.view', () => {
  for (const action of ACTION_NAMES) assert.ok(can('superadmin', action), action);
  assert.equal(allowedActions('superadmin').length, ACTION_NAMES.length);
});

test('no role or an unknown role gets nothing', () => {
  assert.ok(!can(null, 'hall.view'));
  assert.ok(!can(undefined, 'hall.view'));
  assert.deepEqual(allowedActions(null), []);
  assert.ok(!isRole('admin'));
  assert.ok(isRole('owner'));
});

test('every action lists only known roles', () => {
  for (const [action, roles] of Object.entries(ACTIONS)) {
    for (const r of roles) assert.ok((ROLES as readonly string[]).includes(r), `${action}: ${r}`);
  }
});

test('a manager may create cashiers and waiters but not owners; a cashier creates nobody', () => {
  assert.ok(canAssignRole('manager', 'waiter'));
  assert.ok(canAssignRole('manager', 'manager'));
  assert.ok(!canAssignRole('manager', 'owner'));
  assert.ok(canAssignRole('owner', 'owner'));
  assert.ok(!canAssignRole('cashier', 'waiter'));
  assert.ok(!canAssignRole(null, 'waiter'));
});
