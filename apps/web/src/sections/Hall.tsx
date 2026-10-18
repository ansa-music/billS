import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HallLayout, HallLayoutView, Landmark, LandmarkKind, TableKind } from '@bills/domain';
import {
  autoLayout,
  calculateCharge,
  footprint,
  formatMoney,
  HALL_LIMITS,
  LANDMARK_KINDS,
  LANDMARK_LABEL,
  LANDMARK_SIZE,
  layoutIssues,
} from '@bills/domain';
import { fetchHall, fetchSessions, saveHall } from '../api.ts';
import { CardBoundary } from '../CardBoundary.tsx';
import { EmptyState, Segmented, StatTile } from '../components.tsx';
import { DAY_MS, workdayStart } from '../format.ts';
import { alertsByTable, matchesFilter, tablePhase } from '../hall.ts';
import { HallFilterChips, useHallFilter } from '../HallToolbar.tsx';
import { PlanView } from '../hall/PlanView.tsx';
import type { PlanSelection } from '../hall/PlanView.tsx';
import { TableDrawer } from '../hall/TableDrawer.tsx';
import { Icon } from '../icons.tsx';
import { hrefFor } from '../router.tsx';
import { Popover } from '../Shell.tsx';
import { TableCard } from '../TableCard.tsx';
import { useHub, useLive } from '../useHub.tsx';

type HallView = 'plan' | 'cards';
const VIEW_KEY = 'bills.hallView';
const ZOOMS = [1, 1.25, 1.5, 2, 2.5] as const;

function readView(): HallView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'plan' || v === 'cards') return v;
  } catch {
    // Fall through to the default for this screen size.
  }
  return window.innerWidth >= 700 ? 'plan' : 'cards';
}

function useHallView(): [HallView, (v: HallView) => void] {
  const [view, setView] = useState<HallView>(readView);
  const set = useCallback((v: HallView) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembered.
    }
  }, []);
  return [view, set];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const meters = (cm: number) => (cm / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

function HallSummary({ dayRevenue }: { dayRevenue: number | null }) {
  const { state, serverNow } = useHub();
  const total = state.tables.length;
  const playing = state.tables.filter((t) => tablePhase(t) === 'playing').length;
  const opening = state.tables.filter((t) => tablePhase(t) === 'opening').length;
  const live = state.tables.reduce((sum, t) => {
    const s = t.session;
    if (s?.status !== 'ACTIVE' || s.startedAt == null) return sum;
    return sum + calculateCharge(s.startedAt, Math.max(serverNow, s.startedAt), s.tariff, s.timezone).amount;
  }, 0);
  const unpaid = state.unpaid.reduce((sum, s) => sum + (s.amount ?? 0), 0);
  const currency = state.club.currency;
  return (
    <div className="stat-row">
      <StatTile
        label="Играют"
        value={
          <>
            {playing}
            <span className="stat-of"> из {total}</span>
          </>
        }
        detail={opening > 0 ? `ещё ${opening} включается` : `свободно ${total - playing - opening}`}
      >
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${total ? (playing / total) * 100 : 0}%` }} />
        </span>
      </StatTile>
      <StatTile label="Сейчас на столах" value={formatMoney(live, currency)} detail="если остановить сейчас" />
      <StatTile
        label="Начислено за день"
        value={dayRevenue === null ? '…' : formatMoney(dayRevenue + live, currency)}
        detail="с 06:00, с идущими играми"
      />
      <StatTile
        label="Ждут оплаты"
        value={formatMoney(unpaid, currency)}
        detail={state.unpaid.length ? `${state.unpaid.length} ${state.unpaid.length === 1 ? 'игра' : 'игр'} · открыть счета` : 'неоплаченных нет'}
        tone={state.unpaid.length ? 'info' : undefined}
        href={hrefFor('/checks')}
      />
    </div>
  );
}

function EditorBar(props: {
  draft: HallLayout;
  kinds: Map<string, TableKind>;
  names: Map<string, string>;
  selection: PlanSelection | null;
  overlapCount: number;
  tightCount: number;
  saving: boolean;
  onChange: (l: HallLayout) => void;
  onAdd: (kind: LandmarkKind) => void;
  onRotate: () => void;
  onDelete: () => void;
  onAuto: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { draft, selection } = props;
  const landmark = selection?.type === 'landmark' ? draft.landmarks.find((l) => l.id === selection.id) : undefined;
  const placement = selection?.type === 'table' ? draft.tables.find((t) => t.tableId === selection.id) : undefined;
  const setSize = (key: 'width' | 'height', m: string) => {
    const cm = Math.round(Number(m.replace(',', '.')) * 100);
    if (!Number.isFinite(cm)) return;
    props.onChange({ ...draft, [key]: clamp(cm, HALL_LIMITS.min, HALL_LIMITS.max) });
  };
  const setLandmarkSize = (key: 'w' | 'h', m: string) => {
    if (!landmark) return;
    const cm = Math.round(Number(m.replace(',', '.')) * 100);
    if (!Number.isFinite(cm)) return;
    props.onChange({
      ...draft,
      landmarks: draft.landmarks.map((l) => (l.id === landmark.id ? { ...l, [key]: clamp(cm, 30, 2000) } : l)),
    });
  };

  return (
    <div className="editor-bar" role="toolbar" aria-label="Редактор плана">
      <div className="editor-row">
        <label className="editor-field">
          Ширина зала, м
          <input type="number" min={3} max={100} step={0.5} value={draft.width / 100} onChange={(e) => setSize('width', e.target.value)} />
        </label>
        <label className="editor-field">
          Длина зала, м
          <input type="number" min={3} max={100} step={0.5} value={draft.height / 100} onChange={(e) => setSize('height', e.target.value)} />
        </label>
        <Popover
          label="Добавить метку"
          align="start"
          button={
            <span className="editor-add">
              <Icon name="plus" size={18} /> Метка
            </span>
          }
        >
          {(close) => (
            <div className="menu">
              {LANDMARK_KINDS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    props.onAdd(k);
                    close();
                  }}
                >
                  {LANDMARK_LABEL[k]}
                </button>
              ))}
            </div>
          )}
        </Popover>
        <button type="button" className="btn btn-small" onClick={props.onAuto}>
          <Icon name="wand" size={16} /> Расставить заново
        </button>
      </div>

      <div className="editor-row">
        <p className="editor-selection">
          {placement
            ? `${props.names.get(placement.tableId)} · ${meters(footprint(props.kinds.get(placement.tableId) ?? 'pool', placement.rotation).w)} × ${meters(footprint(props.kinds.get(placement.tableId) ?? 'pool', placement.rotation).h)} м`
            : landmark
              ? LANDMARK_LABEL[landmark.kind]
              : 'Перетащите стол или метку. Стрелки — сдвиг на 10 см, R — повернуть.'}
        </p>
        {landmark && (
          <>
            <label className="editor-field editor-field-sm">
              Ш, м
              <input type="number" min={0.3} max={20} step={0.1} value={landmark.w / 100} onChange={(e) => setLandmarkSize('w', e.target.value)} />
            </label>
            <label className="editor-field editor-field-sm">
              Г, м
              <input type="number" min={0.3} max={20} step={0.1} value={landmark.h / 100} onChange={(e) => setLandmarkSize('h', e.target.value)} />
            </label>
          </>
        )}
        <button type="button" className="btn btn-small" disabled={!selection} onClick={props.onRotate}>
          <Icon name="rotate" size={16} /> Повернуть
        </button>
        {landmark && (
          <button type="button" className="btn btn-small btn-ghost" onClick={props.onDelete}>
            <Icon name="trash" size={16} /> Удалить
          </button>
        )}
      </div>

      <div className="editor-row editor-row-end">
        <p className="editor-check" data-tone={props.overlapCount ? 'danger' : props.tightCount ? 'warn' : 'good'}>
          <Icon name={props.overlapCount ? 'alert' : props.tightCount ? 'alert' : 'check'} size={16} />
          {props.overlapCount
            ? `Столы стоят друг на друге или на метке: ${props.overlapCount}. Так сохранить нельзя.`
            : props.tightCount
              ? `Мало места для кия (нужно 1,4 м) у столов: ${props.tightCount}. Сохранить можно.`
              : 'Везде хватает места для кия.'}
        </p>
        <button type="button" className="btn btn-ghost" onClick={props.onCancel} disabled={props.saving}>
          Отмена
        </button>
        <button type="button" className="btn btn-primary btn-flex-none" onClick={props.onSave} disabled={props.saving || props.overlapCount > 0}>
          <Icon name="check" size={18} /> Сохранить план
        </button>
      </div>
    </div>
  );
}

export function HallSection() {
  const hub = useHub();
  const { state, serverNow, actor } = hub;
  const [filter, setFilter] = useHallFilter();
  const [view, setView] = useHallView();
  const [zoomIndex, setZoomIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<HallLayout | null>(null);
  const [selection, setSelection] = useState<PlanSelection | null>(null);
  const [savedView, setSavedView] = useState<HallLayoutView | null>(null);

  const hall = useLive(fetchHall, [], hub.layoutVersion);
  useEffect(() => setSavedView(null), [hall.data]);
  const layoutView = savedView ?? hall.data;

  const dayStart = workdayStart(serverNow, state.club.timezone);
  const day = useLive(() => fetchSessions(dayStart, dayStart + DAY_MS), [dayStart], hub.version);
  const dayRevenue = useMemo(() => {
    if (!day.data) return null;
    return day.data
      .filter((s) => (s.status === 'AWAITING_PAYMENT' || s.status === 'CLOSED') && (s.startedAt ?? s.requestedAt) >= dayStart)
      .reduce((sum, s) => sum + (s.amount ?? 0), 0);
  }, [day.data, dayStart]);

  const alerts = useMemo(() => alertsByTable(state.alerts), [state.alerts]);
  const kinds = useMemo(() => new Map(state.tables.map((t) => [t.id, t.kind])), [state.tables]);
  const names = useMemo(() => new Map(state.tables.map((t) => [t.id, t.name])), [state.tables]);

  const layout = editing && draft ? draft : layoutView?.layout;
  const issues = useMemo(() => (editing && draft ? layoutIssues(draft, kinds) : []), [editing, draft, kinds]);
  const issueByTable = useMemo(() => {
    const m = new Map<string, 'overlap' | 'tight'>();
    for (const i of issues) {
      if (i.type === 'overlap' || i.type === 'outside') m.set(i.tableId, 'overlap');
      else if (!m.has(i.tableId)) m.set(i.tableId, 'tight');
    }
    return m;
  }, [issues]);
  const overlapCount = [...issueByTable.values()].filter((v) => v === 'overlap').length;
  const tightCount = issueByTable.size - overlapCount;

  const startEditing = () => {
    if (!layoutView) return;
    setDraft(structuredClone(layoutView.layout));
    setSelection(null);
    setSelectedId(null);
    setEditing(true);
    setView('plan');
  };
  const stopEditing = () => {
    setEditing(false);
    setDraft(null);
    setSelection(null);
  };

  const fitTable = useCallback(
    (l: HallLayout, tableId: string, x: number, y: number, rotation: 0 | 90): { x: number; y: number } => {
      const { w, h } = footprint(kinds.get(tableId) ?? 'pool', rotation);
      return { x: clamp(x, w / 2, l.width - w / 2), y: clamp(y, h / 2, l.height - h / 2) };
    },
    [kinds],
  );

  const move = useCallback(
    (sel: PlanSelection, x: number, y: number) => {
      setDraft((l) => {
        if (!l) return l;
        if (sel.type === 'table') {
          return {
            ...l,
            tables: l.tables.map((t) => (t.tableId === sel.id ? { ...t, ...fitTable(l, t.tableId, x, y, t.rotation) } : t)),
          };
        }
        return {
          ...l,
          landmarks: l.landmarks.map((m) =>
            m.id === sel.id ? { ...m, x: clamp(x, m.w / 2, l.width - m.w / 2), y: clamp(y, m.h / 2, l.height - m.h / 2) } : m,
          ),
        };
      });
    },
    [fitTable],
  );

  const rotate = useCallback(() => {
    if (!selection) return;
    setDraft((l) => {
      if (!l) return l;
      if (selection.type === 'table') {
        return {
          ...l,
          tables: l.tables.map((t) => {
            if (t.tableId !== selection.id) return t;
            const rotation = t.rotation === 0 ? 90 : 0;
            return { ...t, rotation, ...fitTable(l, t.tableId, t.x, t.y, rotation) };
          }),
        };
      }
      return { ...l, landmarks: l.landmarks.map((m) => (m.id === selection.id ? { ...m, w: m.h, h: m.w } : m)) };
    });
  }, [selection, fitTable]);

  const removeLandmark = useCallback(() => {
    if (selection?.type !== 'landmark') return;
    setDraft((l) => (l ? { ...l, landmarks: l.landmarks.filter((m) => m.id !== selection.id) } : l));
    setSelection(null);
  }, [selection]);

  const addLandmark = (kind: LandmarkKind) => {
    const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
    setDraft((l) => {
      if (!l) return l;
      const m: Landmark = { id, kind, x: Math.round(l.width / 2), y: Math.round(l.height / 2), ...LANDMARK_SIZE[kind] };
      return { ...l, landmarks: [...l.landmarks, m] };
    });
    setSelection({ type: 'landmark', id });
  };

  const autoArrange = () => {
    setDraft((l) => {
      const auto = autoLayout(state.tables.map((t) => ({ id: t.id, kind: t.kind })), l?.width ?? 1500);
      return { ...auto, height: Math.max(auto.height, l?.height ?? 0), landmarks: l?.landmarks ?? [] };
    });
  };

  const save = async () => {
    if (!draft) return;
    let saved: HallLayoutView | null = null;
    const ok = await hub.run('hall-save', async () => {
      saved = await saveHall(draft, actor);
    });
    if (ok) {
      setSavedView(saved);
      stopEditing();
      hub.notify('План зала сохранён — его видят все экраны клуба');
    }
  };

  // Keyboard editing: arrows move, R rotates, Delete removes a landmark, Escape deselects.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      if (!selection || !draft) return;
      const step = e.shiftKey ? 50 : 10;
      const item =
        selection.type === 'table'
          ? draft.tables.find((t) => t.tableId === selection.id)
          : draft.landmarks.find((m) => m.id === selection.id);
      if (!item) return;
      const delta: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const d = delta[e.key];
      if (d) {
        e.preventDefault();
        move(selection, item.x + d[0], item.y + d[1]);
      } else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
        rotate();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.type === 'landmark') {
        removeLandmark();
      } else if (e.key === 'Escape') {
        setSelection(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, selection, draft, move, rotate, removeLandmark]);

  const selectedTable = selectedId ? state.tables.find((t) => t.id === selectedId) : undefined;
  const shownCards = state.tables.filter((t) => matchesFilter(t, filter, alerts.get(t.id)));
  const zoom = ZOOMS[zoomIndex] ?? 1;

  return (
    <div className="hall-page">
      <HallSummary dayRevenue={dayRevenue} />

      <div className="hall-bar">
        <HallFilterChips tables={state.tables} alerts={alerts} filter={filter} onFilter={setFilter} />
        <div className="hall-bar-tools">
          {view === 'plan' && !editing && (
            <div className="zoom" role="group" aria-label="Масштаб плана">
              <button type="button" className="icon-btn" aria-label="Мельче" disabled={zoomIndex === 0} onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}>
                <Icon name="minus" size={18} />
              </button>
              <button type="button" className="zoom-value" onClick={() => setZoomIndex(0)} title="Вписать в экран">
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Крупнее"
                disabled={zoomIndex === ZOOMS.length - 1}
                onClick={() => setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))}
              >
                <Icon name="plus" size={18} />
              </button>
            </div>
          )}
          {!editing && (
            <Segmented
              label="Вид зала"
              value={view}
              onChange={setView}
              options={[
                { value: 'plan', label: 'План', icon: 'plan' },
                { value: 'cards', label: 'Карточки', icon: 'grid' },
              ]}
            />
          )}
          {!editing && view === 'plan' && hub.can('hall.edit') && (
            <button type="button" className="btn btn-small" onClick={startEditing} disabled={!layoutView}>
              <Icon name="edit" size={16} /> Расставить столы
            </button>
          )}
        </div>
      </div>

      {editing && draft && (
        <EditorBar
          draft={draft}
          kinds={kinds}
          names={names}
          selection={selection}
          overlapCount={overlapCount}
          tightCount={tightCount}
          saving={hub.isBusy('hall-save')}
          onChange={setDraft}
          onAdd={addLandmark}
          onRotate={rotate}
          onDelete={removeLandmark}
          onAuto={autoArrange}
          onCancel={stopEditing}
          onSave={() => void save()}
        />
      )}

      {view === 'plan' ? (
        layout ? (
          <>
            {!editing && layoutView && !layoutView.saved && (
              <p className="plan-note">
                <Icon name="wand" size={16} /> Столы расставлены автоматически. Нажмите «Расставить столы», чтобы план совпал с вашим залом.
              </p>
            )}
            <PlanView
              layout={layout}
              tables={state.tables}
              tariffs={state.tariffs}
              alerts={alerts}
              serverNow={serverNow}
              timezone={state.club.timezone}
              currency={state.club.currency}
              filter={filter}
              zoom={editing ? 1 : zoom}
              selectedTableId={selectedId}
              onOpenTable={setSelectedId}
              editing={editing}
              selection={selection}
              onSelection={setSelection}
              onMove={move}
              issues={issueByTable}
            />
          </>
        ) : hall.error ? (
          <EmptyState icon="alert" title="План зала не загрузился">
            {hall.error}
          </EmptyState>
        ) : (
          <div className="plan plan-loading" aria-busy="true" />
        )
      ) : shownCards.length === 0 ? (
        <EmptyState icon="hall" title="В этом фильтре столов нет" />
      ) : (
        <div className="tables">
          {shownCards.map((table) => (
            <CardBoundary key={table.id} name={table.name} resetKey={table}>
              <TableCard
                table={table}
                tariffs={state.tariffs}
                timezone={state.club.timezone}
                alert={alerts.get(table.id)}
                currency={state.club.currency}
                serverNow={serverNow}
                busy={hub.isBusy(table.id) || !hub.online}
                onOpen={(tariffId) => void hub.openTable(table.id, tariffId)}
                onStop={(sessionId) => void hub.stopSession(table.id, sessionId)}
                onDetails={() => setSelectedId(table.id)}
              />
            </CardBoundary>
          ))}
        </div>
      )}

      {selectedTable && !editing && (
        <TableDrawer
          table={selectedTable}
          alert={alerts.get(selectedTable.id)}
          daySessions={(day.data ?? []).filter((s) => s.tableId === selectedTable.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
