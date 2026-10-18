import './hall.css';
import { useCallback, useState } from 'react';
import type { AlertView, TableView } from '@bills/domain';
import { type HallFilter, matchesFilter } from './hall.ts';
import { useFullscreen } from './kiosk.ts';

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

export function HallToolbar({
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
  const fullscreen = useFullscreen();

  // Counted with the same predicate the grid filters by, so a chip's number
  // always equals the number of cards it shows.
  const counts: Record<HallFilter, number> = { all: 0, free: 0, playing: 0, problem: 0 };
  for (const table of tables) {
    const alert = alerts.get(table.id);
    for (const f of FILTERS) {
      if (matchesFilter(table, f, alert)) counts[f] += 1;
    }
  }

  // «Проблемы» appears only when there is something to look at — but stays while it is
  // the active filter, so an emptied grid still shows why it is empty.
  const visible = FILTERS.filter((f) => f !== 'problem' || counts.problem > 0 || filter === 'problem');

  return (
    <div className="hall-toolbar">
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
      {fullscreen.supported && (
        <button type="button" className="btn btn-ghost hall-fullscreen" onClick={fullscreen.toggle}>
          <FullscreenIcon exit={fullscreen.active} />
          {fullscreen.active ? 'Обычный режим' : 'На весь экран'}
        </button>
      )}
    </div>
  );
}

function FullscreenIcon({ exit }: { exit: boolean }) {
  return (
    <svg
      className="hall-fullscreen-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {exit ? (
        <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
      ) : (
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      )}
    </svg>
  );
}
