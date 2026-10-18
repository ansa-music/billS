import { useCallback, useState } from 'react';
import type { AlertView, TableView } from '@bills/domain';
import { type HallFilter, matchesFilter } from './hall.ts';

const FILTER_KEY = 'bills.hallFilter';
const FILTERS: readonly HallFilter[] = ['all', 'free', 'playing', 'problem'];

function isHallFilter(value: unknown): value is HallFilter {
  return typeof value === 'string' && (FILTERS as readonly string[]).includes(value);
}

function readFilter(): HallFilter {
  try {
    const stored = localStorage.getItem(FILTER_KEY);
    return isHallFilter(stored) ? stored : 'all';
  } catch {
    return 'all';
  }
}

/** The hall filter, remembered per tablet. */
export function useHallFilter(): [HallFilter, (f: HallFilter) => void] {
  const [filter, setFilterState] = useState<HallFilter>(readFilter);
  const setFilter = useCallback((f: HallFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      // Storage may be blocked; the filter just will not be remembered.
    }
  }, []);
  return [filter, setFilter];
}

const LABELS: Record<HallFilter, string> = {
  all: 'Все',
  free: 'Свободные',
  playing: 'Играют',
  problem: 'Проблемы',
};

export function HallFilterChips({
  tables,
  alerts,
  filter,
  onFilter,
}: {
  tables: TableView[];
  alerts: Map<string, AlertView>;
  filter: HallFilter;
  onFilter: (f: HallFilter) => void;
}) {
  // Counted with the same predicate the hall filters by, so a chip's number
  // always equals the number of tables it highlights.
  const counts: Record<HallFilter, number> = { all: 0, free: 0, playing: 0, problem: 0 };
  for (const table of tables) {
    const alert = alerts.get(table.id);
    for (const f of FILTERS) {
      if (matchesFilter(table, f, alert)) counts[f] += 1;
    }
  }

  // «Проблемы» appears only when there is something to look at — but stays while it is
  // the active filter, so an emptied hall still shows why it is empty.
  const visible = FILTERS.filter((f) => f !== 'problem' || counts.problem > 0 || filter === 'problem');

  return (
    <div className="hall-chips" role="group" aria-label="Фильтр столов">
      {visible.map((f) => (
        <button
          key={f}
          type="button"
          className={f === 'problem' ? 'hall-chip hall-chip-danger' : 'hall-chip'}
          aria-pressed={filter === f}
          onClick={() => onFilter(f)}
        >
          <span>{LABELS[f]}</span>
          <span className="hall-chip-count">{counts[f]}</span>
        </button>
      ))}
    </div>
  );
}
