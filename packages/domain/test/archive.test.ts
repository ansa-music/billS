import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArchiveEntry } from '../src/archive.ts';
import { ARCHIVE_KIND_LABEL, ARCHIVE_KINDS, isCancellation, sortArchive, summarizeCancelled, summarizeRefunds } from '../src/archive.ts';

function entry(over: Partial<ArchiveEntry> & Pick<ArchiveEntry, 'kind' | 'id' | 'at' | 'amount'>): ArchiveEntry {
  return {
    title: over.id,
    detail: null,
    number: null,
    checkNumber: null,
    by: 'Марат',
    approvedBy: null,
    reason: 'ошибка',
    createdAt: null,
    createdBy: null,
    ...over,
  };
}

test('the «Отменённые» block counts cancelled orders and games, not refunds or empty checks', () => {
  const list = [
    entry({ kind: 'ORDER', id: 'o1', at: 100, amount: 1200_00 }),
    entry({ kind: 'REFUND', id: 'r1', at: 300, amount: 500_00 }),
    entry({ kind: 'GAME', id: 'g1', at: 200, amount: 2000_00 }),
    entry({ kind: 'VOID', id: 'c1', at: 400, amount: 0 }),
  ];
  const s = summarizeCancelled(list);
  assert.equal(s.count, 2);
  assert.equal(s.total, 3200_00);
  // Newest first.
  assert.deepEqual(
    s.items.map((e) => e.id),
    ['g1', 'o1'],
  );
  assert.deepEqual(summarizeRefunds(list), { count: 1, total: 500_00 });
  assert.deepEqual(summarizeCancelled([]), { count: 0, total: 0, items: [] });
});

test('archive kinds: every kind has a label; only orders and games are cancellations', () => {
  for (const k of ARCHIVE_KINDS) assert.ok(ARCHIVE_KIND_LABEL[k].length > 0, k);
  assert.deepEqual(
    ARCHIVE_KINDS.filter((kind) => isCancellation({ kind })),
    ['ORDER', 'GAME'],
  );
});

test('sorting: newest first, ties keep a stable order by id, the input is not changed', () => {
  const list = [
    { id: 'b', at: 10 },
    { id: 'a', at: 10 },
    { id: 'c', at: 20 },
  ];
  assert.deepEqual(
    sortArchive(list).map((e) => e.id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    list.map((e) => e.id),
    ['b', 'a', 'c'],
  );
});
