import type { KeyboardEvent, PointerEvent } from 'react';
import type { LampReported, Rotation, TableKind } from '@bills/domain';
import { CUE_CLEARANCE_CM, footprint } from '@bills/domain';
import type { TablePhase } from '../hall.ts';

/** Ids of the shared gradients and filters defined once in PlanDefs. */
export const PLAN_IDS = {
  wood: 'bp-wood',
  pool: 'bp-lamp-pool',
  shine: 'bp-felt-shine',
  shade: 'bp-shade-glow',
  floor: 'bp-floor-grid',
  shadow: 'bp-shadow',
} as const;

export function PlanDefs() {
  return (
    <defs>
      <linearGradient id={PLAN_IDS.wood} x1="0" y1="0" x2="0.35" y2="1">
        <stop offset="0" className="stop-wood-1" />
        <stop offset="1" className="stop-wood-2" />
      </linearGradient>
      <radialGradient id={PLAN_IDS.pool}>
        <stop offset="0" className="stop-lamp" stopOpacity="0.42" />
        <stop offset="0.55" className="stop-lamp" stopOpacity="0.16" />
        <stop offset="1" className="stop-lamp" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={PLAN_IDS.shine} cx="0.5" cy="0.5" r="0.65">
        <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
        <stop offset="1" stopColor="#fff" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={PLAN_IDS.shade}>
        <stop offset="0" stopColor="#fff6d6" stopOpacity="1" />
        <stop offset="0.45" className="stop-lamp" stopOpacity="0.95" />
        <stop offset="1" className="stop-lamp" stopOpacity="0" />
      </radialGradient>
      <pattern id={PLAN_IDS.floor} width="100" height="100" patternUnits="userSpaceOnUse">
        <path d="M100 0H0V100" className="floor-line-strong" fill="none" />
        <path d="M50 0V100M0 50H100" className="floor-line" fill="none" />
      </pattern>
      <filter id={PLAN_IDS.shadow} x="-30%" y="-30%" width="160%" height="170%">
        <feGaussianBlur stdDeviation="9" />
      </filter>
    </defs>
  );
}

const SHADES: Record<TableKind, number> = { pool: 3, russian: 4, snooker: 4 };

export interface TableShapeProps {
  id: string;
  name: string;
  kind: TableKind;
  x: number;
  y: number;
  rotation: Rotation;
  phase: TablePhase;
  lamp: LampReported;
  switching: boolean;
  problem: boolean;
  selected: boolean;
  dimmed: boolean;
  editing: boolean;
  issue: 'overlap' | 'tight' | null;
  /** Big line in the middle: the timer, or a short status. */
  primary: string;
  secondary?: string | undefined;
  label: string;
  onPointerDown?: (e: PointerEvent<SVGGElement>) => void;
  onActivate?: () => void;
}

export function TableShape(p: TableShapeProps) {
  const { w, h } = footprint(p.kind, p.rotation);
  const short = Math.min(w, h);
  const rail = short * 0.085;
  const horizontal = w >= h;
  const fw = w - 2 * rail;
  const fh = h - 2 * rail;
  const pocket = p.kind === 'pool' ? 7.5 : 6;
  const inset = rail * 0.55;

  const pockets: Array<[number, number]> = [
    [-w / 2 + inset, -h / 2 + inset],
    [w / 2 - inset, -h / 2 + inset],
    [-w / 2 + inset, h / 2 - inset],
    [w / 2 - inset, h / 2 - inset],
    horizontal ? [0, -h / 2 + inset * 0.8] : [-w / 2 + inset * 0.8, 0],
    horizontal ? [0, h / 2 - inset * 0.8] : [w / 2 - inset * 0.8, 0],
  ];

  // Sights on the rails: three per half of a long rail, three on a short rail.
  const diamonds: Array<[number, number]> = [];
  const along = (len: number) => [1, 2, 3, 5, 6, 7].map((i) => -len / 2 + (len * i) / 8);
  const across = (len: number) => [1, 2, 3].map((i) => -len / 2 + (len * i) / 4);
  const r2 = rail / 2;
  if (horizontal) {
    for (const dx of along(fw)) diamonds.push([dx, -h / 2 + r2], [dx, h / 2 - r2]);
    for (const dy of across(fh)) diamonds.push([-w / 2 + r2, dy], [w / 2 - r2, dy]);
  } else {
    for (const dy of along(fh)) diamonds.push([-w / 2 + r2, dy], [w / 2 - r2, dy]);
    for (const dx of across(fw)) diamonds.push([dx, -h / 2 + r2], [dx, h / 2 - r2]);
  }

  const n = SHADES[p.kind];
  const shades = Array.from({ length: n }, (_, i) => {
    const t = -0.5 + (i + 0.5) / n;
    return horizontal ? [t * fw * 0.86, 0] : [0, t * fh * 0.86];
  }) as Array<[number, number]>;
  const shadeR = short * 0.085;

  const primarySize = Math.min(fh, fw) * (p.phase === 'playing' ? 0.27 : 0.16);
  const secondarySize = Math.min(fh, fw) * 0.15;
  const nameSize = Math.max(24, short * 0.15);

  const onKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      p.onActivate?.();
    }
  };

  return (
    <g
      className="tbl"
      data-phase={p.phase}
      data-lamp={p.lamp.toLowerCase()}
      data-switching={p.switching || undefined}
      data-problem={p.problem || undefined}
      data-selected={p.selected || undefined}
      data-dimmed={p.dimmed || undefined}
      data-editing={p.editing || undefined}
      data-issue={p.issue ?? undefined}
      transform={`translate(${p.x} ${p.y})`}
      role="button"
      tabIndex={0}
      aria-label={p.label}
      aria-pressed={p.selected}
      onPointerDown={p.onPointerDown}
      onClick={p.editing ? undefined : p.onActivate}
      onKeyDown={p.editing ? undefined : onKeyDown}
    >
      {p.editing && p.selected && (
        <rect
          className="tbl-clearance"
          x={-w / 2 - CUE_CLEARANCE_CM}
          y={-h / 2 - CUE_CLEARANCE_CM}
          width={w + 2 * CUE_CLEARANCE_CM}
          height={h + 2 * CUE_CLEARANCE_CM}
          rx={CUE_CLEARANCE_CM * 0.6}
        />
      )}
      <ellipse className="tbl-pool" rx={w / 2 + 90} ry={h / 2 + 90} fill={`url(#${PLAN_IDS.pool})`} />
      <rect
        className="tbl-shadow"
        x={-w / 2 + 4}
        y={-h / 2 + 12}
        width={w}
        height={h}
        rx={rail}
        filter={`url(#${PLAN_IDS.shadow})`}
      />
      <rect className="tbl-ring" x={-w / 2 - 9} y={-h / 2 - 9} width={w + 18} height={h + 18} rx={rail + 8} />
      <rect className="tbl-rail" x={-w / 2} y={-h / 2} width={w} height={h} rx={rail * 0.9} fill={`url(#${PLAN_IDS.wood})`} />
      <rect className="tbl-cushion" x={-fw / 2 - rail * 0.28} y={-fh / 2 - rail * 0.28} width={fw + rail * 0.56} height={fh + rail * 0.56} rx={3} />
      <rect className="tbl-felt" x={-fw / 2} y={-fh / 2} width={fw} height={fh} rx={2} />
      <rect className="tbl-shine" x={-fw / 2} y={-fh / 2} width={fw} height={fh} rx={2} fill={`url(#${PLAN_IDS.shine})`} />
      {diamonds.map(([dx, dy], i) => (
        <circle key={`d${i}`} className="tbl-diamond" cx={dx} cy={dy} r={1.9} />
      ))}
      {pockets.map(([px, py], i) => (
        <circle key={`p${i}`} className="tbl-pocket" cx={px} cy={py} r={pocket} />
      ))}
      {shades.map(([sx, sy], i) => (
        <g key={`s${i}`} className="tbl-shade">
          <circle className="tbl-shade-glow" cx={sx} cy={sy} r={shadeR * 2.1} fill={`url(#${PLAN_IDS.shade})`} />
          <circle className="tbl-shade-ring" cx={sx} cy={sy} r={shadeR} />
        </g>
      ))}

      <text className="tbl-name" y={-h / 2 - nameSize * 0.55} fontSize={nameSize}>
        {p.name}
      </text>
      <text className="tbl-primary" y={p.secondary ? -secondarySize * 0.35 : primarySize * 0.36} fontSize={primarySize}>
        {p.primary}
      </text>
      {p.secondary && (
        <text className="tbl-secondary" y={primarySize * 0.62 + secondarySize * 0.4} fontSize={secondarySize}>
          {p.secondary}
        </text>
      )}
      {p.phase === 'opening' && (
        <circle className="tbl-spinner" r={Math.min(fw, fh) * 0.34} />
      )}
      {p.problem && (
        <g className="tbl-alert" transform={`translate(${w / 2 - 4} ${-h / 2 + 4})`}>
          <circle r={22} />
          <text y={9} fontSize={28}>
            !
          </text>
        </g>
      )}
    </g>
  );
}
