import { useRef } from 'react';
import type { PointerEvent } from 'react';
import type { AlertView, HallLayout, HubState, Landmark, TableView } from '@bills/domain';
import { calculateCharge, formatMoney, LANDMARK_LABEL, priceAt } from '@bills/domain';
import { formatDuration, KIND_LABEL } from '../format.ts';
import type { HallFilter } from '../hall.ts';
import { hasProblem, matchesFilter, tablePhase } from '../hall.ts';
import { PlanDefs, PLAN_IDS, TableShape } from './TableShape.tsx';

export type PlanSelection = { type: 'table' | 'landmark'; id: string };

interface Props {
  layout: HallLayout;
  tables: TableView[];
  tariffs: HubState['tariffs'];
  alerts: Map<string, AlertView>;
  serverNow: number;
  timezone: string;
  currency: string;
  filter: HallFilter;
  zoom: number;
  /** View mode: the table whose panel is open. */
  selectedTableId: string | null;
  onOpenTable: (tableId: string) => void;
  /** Edit mode. */
  editing: boolean;
  selection: PlanSelection | null;
  onSelection: (s: PlanSelection | null) => void;
  onMove: (s: PlanSelection, x: number, y: number) => void;
  issues: Map<string, 'overlap' | 'tight'>;
}

const PAD = 70;
const SNAP = 10;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;

function LandmarkShape({
  l,
  selected,
  editing,
  onPointerDown,
}: {
  l: Landmark;
  selected: boolean;
  editing: boolean;
  onPointerDown?: (e: PointerEvent<SVGGElement>) => void;
}) {
  const label = LANDMARK_LABEL[l.kind];
  const size = Math.min(l.h * 0.36, l.w * 0.2, 34);
  return (
    <g
      className="lm"
      data-kind={l.kind}
      data-selected={selected || undefined}
      data-editing={editing || undefined}
      transform={`translate(${l.x} ${l.y})`}
      onPointerDown={onPointerDown}
      aria-label={label}
    >
      <rect className="lm-body" x={-l.w / 2} y={-l.h / 2} width={l.w} height={l.h} rx={l.kind === 'column' ? 4 : 14} />
      {l.kind !== 'column' && (
        <text className="lm-label" y={size * 0.35} fontSize={size}>
          {l.kind === 'entrance' ? `${label} ⇣` : label}
        </text>
      )}
      <title>{label}</title>
    </g>
  );
}

export function PlanView(p: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{
    sel: PlanSelection;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const toPlan = (clientX: number, clientY: number) => {
    const ctm = svg.current?.getScreenCTM();
    if (!ctm) return null;
    return new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
  };

  const startDrag = (sel: PlanSelection, originX: number, originY: number) => (e: PointerEvent<SVGGElement>) => {
    if (!p.editing) return;
    e.preventDefault();
    e.stopPropagation();
    const pt = toPlan(e.clientX, e.clientY);
    if (!pt) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { sel, startX: pt.x, startY: pt.y, originX, originY };
    p.onSelection(sel);
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    const pt = toPlan(e.clientX, e.clientY);
    if (!pt) return;
    p.onMove(d.sel, snap(d.originX + pt.x - d.startX), snap(d.originY + pt.y - d.startY));
  };

  const endDrag = () => {
    drag.current = null;
  };

  const byId = new Map(p.tables.map((t) => [t.id, t]));
  const tariffById = new Map(p.tariffs.map((t) => [t.id, t]));
  const { width, height } = p.layout;

  return (
    <div className="plan" data-editing={p.editing || undefined}>
      <svg
        ref={svg}
        className="plan-svg"
        viewBox={`${-PAD} ${-PAD} ${width + 2 * PAD} ${height + 2 * PAD}`}
        style={{ width: `${p.zoom * 100}%` }}
        role="group"
        aria-label={`План зала, ${(width / 100).toFixed(1)} × ${(height / 100).toFixed(1)} м`}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerDown={() => p.editing && p.onSelection(null)}
      >
        <PlanDefs />
        <rect className="plan-floor" x={0} y={0} width={width} height={height} />
        <rect x={0} y={0} width={width} height={height} fill={`url(#${PLAN_IDS.floor})`} />
        <rect className="plan-wall" x={-6} y={-6} width={width + 12} height={height + 12} rx={8} />

        {p.layout.landmarks.map((l) => (
          <LandmarkShape
            key={l.id}
            l={l}
            editing={p.editing}
            selected={p.selection?.type === 'landmark' && p.selection.id === l.id}
            {...(p.editing ? { onPointerDown: startDrag({ type: 'landmark', id: l.id }, l.x, l.y) } : {})}
          />
        ))}

        {p.layout.tables.map((placement) => {
          const table = byId.get(placement.tableId);
          if (!table) return null;
          const alert = p.alerts.get(table.id);
          const phase = tablePhase(table);
          const session = table.session;
          let primary = 'Свободен';
          let secondary: string | undefined;
          if (phase === 'playing' && session?.startedAt != null) {
            const end = Math.max(p.serverNow, session.startedAt);
            primary = formatDuration(end - session.startedAt);
            secondary = formatMoney(calculateCharge(session.startedAt, end, session.tariff, session.timezone).amount, p.currency);
          } else if (phase === 'paused' && session?.startedAt != null) {
            primary = session.resumeRequestedAt != null ? 'Свет…' : 'Пауза';
            secondary = formatDuration(((session.playedSeconds ?? 0) || 0) * 1000);
          } else if (phase === 'opening' && session) {
            primary = 'Свет…';
            secondary = `${Math.max(0, Math.floor((p.serverNow - session.requestedAt) / 1000))} с`;
          } else {
            const tariff = tariffById.get(table.defaultTariffId);
            if (tariff) secondary = `${formatMoney(priceAt(p.serverNow, tariff.config, p.timezone).pricePerHour, p.currency)}/ч`;
          }
          const problem = hasProblem(table, alert);
          const selected = p.editing
            ? p.selection?.type === 'table' && p.selection.id === table.id
            : p.selectedTableId === table.id;
          return (
            <TableShape
              key={table.id}
              id={table.id}
              name={table.name}
              kind={table.kind}
              x={placement.x}
              y={placement.y}
              rotation={placement.rotation}
              phase={phase}
              lamp={table.lamp.reported}
              switching={table.lamp.reported !== table.lamp.desired}
              problem={problem}
              selected={selected}
              dimmed={!p.editing && !matchesFilter(table, p.filter, alert)}
              editing={p.editing}
              issue={p.editing ? (p.issues.get(table.id) ?? null) : null}
              primary={primary}
              secondary={secondary}
              label={`${table.name}, ${KIND_LABEL[table.kind]}: ${phase === 'playing' ? `идёт игра ${primary}, ${secondary}` : phase === 'paused' ? `на паузе, сыграно ${secondary}` : phase === 'opening' ? 'включаем свет' : 'свободен'}${problem ? ', проблема с лампой' : ''}`}
              {...(p.editing
                ? { onPointerDown: startDrag({ type: 'table', id: table.id }, placement.x, placement.y) }
                : { onActivate: () => p.onOpenTable(table.id) })}
            />
          );
        })}

        <g className="plan-scale" transform={`translate(${30} ${height - 34})`}>
          <path d="M0 0v-12M0 -6H100M100 0v-12" />
          <text x={50} y={-18} fontSize={22}>
            1 м
          </text>
        </g>
      </svg>
    </div>
  );
}
