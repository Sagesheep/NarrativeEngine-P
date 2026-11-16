import type { CombatPos } from '../../types';
import { TILE_SIZE, tileCenter } from './combatVisuals';
import type { MarkRole, TileMark } from './objectiveText';

const COLOR: Record<TileMark['kind'], string> = {
    exit: 'var(--combat-los-clear)',
    leaderExit: 'var(--combat-enemy)',
    seize: 'var(--combat-hp-warn)',
    reach: 'var(--combat-hp-warn)',
    incoming: 'var(--combat-enemy)',
};

const HALO = 'var(--combat-board-bg)';

type Dir = { dx: number; dy: number };

function exitDirection(p: CombatPos, width: number, height: number): Dir {
    if (p.y === 0) return { dx: 0, dy: -1 };
    if (p.y === height - 1) return { dx: 0, dy: 1 };
    if (p.x === 0) return { dx: -1, dy: 0 };
    if (p.x === width - 1) return { dx: 1, dy: 0 };
    return { dx: 0, dy: -1 };
}

function Arrow({ cx, cy, dir, color }: { cx: number; cy: number; dir: Dir; color: string }) {
    const tip = { x: cx + dir.dx * 2.6, y: cy + dir.dy * 2.6 };
    const back = { x: cx - dir.dx * 1.4, y: cy - dir.dy * 1.4 };
    const px = -dir.dy;
    const py = dir.dx;
    const points = `${tip.x},${tip.y} ${back.x + px * 2},${back.y + py * 2} ${back.x - px * 2},${back.y - py * 2}`;
    return (
        <>
            <polygon points={points} style={{ fill: 'none', stroke: HALO, strokeWidth: 1.9, strokeLinejoin: 'round' }} />
            <polygon points={points} style={{ fill: color, stroke: color, strokeWidth: 0.4, strokeLinejoin: 'round' }} />
        </>
    );
}

function Frame({ left, top, color, dash }: { left: number; top: number; color: string; dash?: string }) {
    const size = TILE_SIZE - 1.6;
    return (
        <>
            <rect x={left + 0.8} y={top + 0.8} width={size} height={size} rx={1} style={{ fill: 'none', stroke: HALO, strokeWidth: 1.9 }} />
            <rect x={left + 0.8} y={top + 0.8} width={size} height={size} rx={1} style={{ fill: color, fillOpacity: 0.16, stroke: color, strokeWidth: 0.7, strokeDasharray: dash }} />
        </>
    );
}

function Glyph({ mark, width, height }: { mark: TileMark; width: number; height: number }) {
    const left = mark.pos.x * TILE_SIZE;
    const top = mark.pos.y * TILE_SIZE;
    const c = tileCenter(mark.pos);
    const color = COLOR[mark.kind];
    if (mark.kind === 'exit' || mark.kind === 'leaderExit') {
        return (
            <>
                <Frame left={left} top={top} color={color} dash={mark.kind === 'leaderExit' ? '1.4 0.9' : undefined} />
                <Arrow cx={c.x} cy={c.y} dir={exitDirection(mark.pos, width, height)} color={color} />
            </>
        );
    }
    if (mark.kind === 'seize') {
        const pole = { x: left + 3.2, y1: top + 2, y2: top + 8 };
        const flag = `${pole.x},${pole.y1} ${pole.x + 4.6},${pole.y1 + 1.6} ${pole.x},${pole.y1 + 3.2}`;
        return (
            <>
                <Frame left={left} top={top} color={color} />
                <line x1={pole.x} y1={pole.y1} x2={pole.x} y2={pole.y2} style={{ stroke: HALO, strokeWidth: 1.9, strokeLinecap: 'round' }} />
                <polygon points={flag} style={{ fill: 'none', stroke: HALO, strokeWidth: 1.9, strokeLinejoin: 'round' }} />
                <line x1={pole.x} y1={pole.y1} x2={pole.x} y2={pole.y2} style={{ stroke: color, strokeWidth: 0.8, strokeLinecap: 'round' }} />
                <polygon points={flag} style={{ fill: color, stroke: color, strokeWidth: 0.4, strokeLinejoin: 'round' }} />
            </>
        );
    }
    if (mark.kind === 'reach') {
        const d = 3.4;
        const diamond = `${c.x},${c.y - d} ${c.x + d},${c.y} ${c.x},${c.y + d} ${c.x - d},${c.y}`;
        return (
            <>
                <Frame left={left} top={top} color={color} dash="0.8 0.8" />
                <polygon points={diamond} style={{ fill: 'none', stroke: HALO, strokeWidth: 1.9, strokeLinejoin: 'round' }} />
                <polygon points={diamond} style={{ fill: color, fillOpacity: 0.55, stroke: color, strokeWidth: 0.7, strokeLinejoin: 'round' }} />
            </>
        );
    }
    const tri = `${c.x},${c.y - 3.2} ${c.x + 3.2},${c.y + 2.6} ${c.x - 3.2},${c.y + 2.6}`;
    return (
        <>
            <Frame left={left} top={top} color={color} dash="1.2 0.8" />
            <polygon points={tri} style={{ fill: 'none', stroke: HALO, strokeWidth: 1.9, strokeLinejoin: 'round' }} />
            <polygon points={tri} style={{ fill: 'none', stroke: color, strokeWidth: 0.8, strokeLinejoin: 'round' }} />
            <line x1={c.x} y1={c.y - 1.2} x2={c.x} y2={c.y + 0.6} style={{ stroke: color, strokeWidth: 0.8, strokeLinecap: 'round' }} />
            <circle cx={c.x} cy={c.y + 1.7} r={0.5} style={{ fill: color }} />
        </>
    );
}

export function ObjectiveTileMarks({ marks, width, height }: { marks: readonly TileMark[]; width: number; height: number }) {
    if (marks.length === 0) return null;
    return (
        <g data-testid="combat-objective-marks" style={{ pointerEvents: 'none' }}>
            {marks.map(mark => (
                <g
                    key={`${mark.kind}-${mark.pos.x},${mark.pos.y}`}
                    data-testid={`combat-mark-${mark.kind}`}
                    data-x={mark.pos.x}
                    data-y={mark.pos.y}
                    role="img"
                    aria-label={mark.label}
                >
                    <title>{mark.label}</title>
                    <Glyph mark={mark} width={width} height={height} />
                </g>
            ))}
        </g>
    );
}

const BADGE_COLOR: Record<MarkRole, string> = {
    leader: 'var(--combat-enemy)',
    ward: 'var(--combat-los-clear)',
    bystander: 'var(--combat-hp-warn)',
};

export function ObjectiveBadge({ role, x, y, r }: { role: MarkRole; x: number; y: number; r: number }) {
    const bx = x - r * 0.78;
    const by = y - r * 0.78;
    const color = BADGE_COLOR[role];
    return (
        <g data-testid={`combat-badge-${role}`} style={{ pointerEvents: 'none' }}>
            <circle cx={bx} cy={by} r={2.1} style={{ fill: HALO, stroke: color, strokeWidth: 0.6 }} />
            {role === 'leader' && (
                <polygon points={`${bx - 1.3},${by + 0.9} ${bx - 1.3},${by - 0.9} ${bx - 0.45},${by} ${bx},${by - 1.2} ${bx + 0.45},${by} ${bx + 1.3},${by - 0.9} ${bx + 1.3},${by + 0.9}`} style={{ fill: color }} />
            )}
            {role === 'ward' && (
                <path d={`M ${bx - 1.2} ${by - 1.1} L ${bx + 1.2} ${by - 1.1} L ${bx + 1.2} ${by + 0.2} L ${bx} ${by + 1.4} L ${bx - 1.2} ${by + 0.2} Z`} style={{ fill: color }} />
            )}
            {role === 'bystander' && <circle cx={bx} cy={by} r={0.9} style={{ fill: 'none', stroke: color, strokeWidth: 0.6 }} />}
        </g>
    );
}
