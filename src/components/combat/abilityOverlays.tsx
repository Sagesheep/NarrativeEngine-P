import type { Barrier } from '@narrative/engine';
import type { CombatPos, CombatState, Combatant } from '../../types';
import { TILE_SIZE, posKey, tileCenter } from './combatVisuals';
import type { AbilityAim, AimPreview } from './useAbilityAim';

export function BarrierLayer({ barriers }: { barriers: readonly Barrier[] | undefined }) {
    if (!barriers || barriers.length === 0) return null;
    return (
        <g data-testid="combat-barriers" style={{ pointerEvents: 'none' }}>
            {barriers.map(b => (
                <g key={`b${b.pos.x},${b.pos.y}`} data-testid="combat-barrier" data-x={b.pos.x} data-y={b.pos.y}>
                    <rect
                        x={b.pos.x * TILE_SIZE + 0.6}
                        y={b.pos.y * TILE_SIZE + 0.6}
                        width={TILE_SIZE - 1.2}
                        height={TILE_SIZE - 1.2}
                        rx={1}
                        style={{ fill: 'var(--combat-wall)', fillOpacity: 0.75, stroke: 'var(--combat-path)', strokeWidth: 0.6, strokeDasharray: '1.2 0.8' }}
                    />
                    <path
                        d={`M ${b.pos.x * TILE_SIZE + 2} ${b.pos.y * TILE_SIZE + 2} L ${b.pos.x * TILE_SIZE + TILE_SIZE - 2} ${b.pos.y * TILE_SIZE + TILE_SIZE - 2} M ${b.pos.x * TILE_SIZE + TILE_SIZE - 2} ${b.pos.y * TILE_SIZE + 2} L ${b.pos.x * TILE_SIZE + 2} ${b.pos.y * TILE_SIZE + TILE_SIZE - 2}`}
                        style={{ stroke: 'var(--combat-path)', strokeWidth: 0.4, opacity: 0.7 }}
                    />
                </g>
            ))}
        </g>
    );
}

export function AimOverlay({ aim, preview, focus, state }: { aim: AbilityAim; preview: AimPreview | null; focus: CombatPos | null; state: CombatState }) {
    const legalFocus = !!focus && aim.legal.has(posKey(focus)) && !!preview?.ok;
    return (
        <g data-testid="combat-aim">
            {aim.legalList.map(p => (
                <rect
                    key={`a${p.x},${p.y}`}
                    data-testid="combat-aim-legal"
                    data-x={p.x}
                    data-y={p.y}
                    x={p.x * TILE_SIZE + 0.3}
                    y={p.y * TILE_SIZE + 0.3}
                    width={TILE_SIZE - 0.6}
                    height={TILE_SIZE - 0.6}
                    style={{ fill: 'var(--combat-reach)', stroke: 'var(--combat-path)', strokeWidth: 0.25, strokeOpacity: 0.6 }}
                />
            ))}
            {legalFocus && preview?.tiles.map(p => (
                <rect
                    key={`p${p.x},${p.y}`}
                    data-testid="combat-aim-area"
                    data-x={p.x}
                    data-y={p.y}
                    x={p.x * TILE_SIZE}
                    y={p.y * TILE_SIZE}
                    width={TILE_SIZE}
                    height={TILE_SIZE}
                    style={{ fill: 'var(--combat-target)' }}
                />
            ))}
            {legalFocus && preview?.hits.map(hit => {
                const c = state.combatants[hit.id];
                if (!c?.position) return null;
                const { x, y } = tileCenter(c.position);
                return (
                    <circle
                        key={`h${hit.id}`}
                        data-testid="combat-aim-hit"
                        data-friendly={hit.friendly ? 'true' : 'false'}
                        data-id={hit.id}
                        cx={x}
                        cy={y}
                        r={TILE_SIZE * 0.48}
                        style={{
                            fill: 'none',
                            stroke: hit.friendly ? 'var(--combat-party)' : 'var(--combat-enemy)',
                            strokeWidth: hit.friendly ? 0.7 : 1,
                            strokeDasharray: hit.friendly ? '1 0.7' : undefined,
                        }}
                    />
                );
            })}
        </g>
    );
}

export function ConditionBadges({ c, x, y, r }: { c: Combatant; x: number; y: number; r: number }) {
    const shown = c.conditions.filter(cond => typeof cond.turns === 'number');
    if (c.status !== 'up' || shown.length === 0) return null;
    return (
        <text
            data-testid="combat-conditions"
            x={x}
            y={y - r - 1.4}
            textAnchor="middle"
            style={{ fontSize: 2.3, fontWeight: 700, fill: 'var(--combat-path)', pointerEvents: 'none' }}
        >
            {shown.map(cond => `${cond.id.charAt(0).toUpperCase()}${cond.turns}`).join(' ')}
        </text>
    );
}

export function TempHpRing({ c, x, y, r }: { c: Combatant; x: number; y: number; r: number }) {
    const temp = c.tempHp ?? 0;
    if (c.status !== 'up' || temp <= 0) return null;
    const ring = 2 * Math.PI * (r + 1.9);
    const frac = Math.max(0, Math.min(1, temp / Math.max(1, c.maxHp)));
    return (
        <circle
            data-testid="combat-temp-hp"
            cx={x}
            cy={y}
            r={r + 1.9}
            transform={`rotate(-90 ${x} ${y})`}
            style={{ fill: 'none', stroke: 'var(--combat-party)', strokeWidth: 0.6, strokeDasharray: `${ring * frac} ${ring}`, pointerEvents: 'none' }}
        />
    );
}
