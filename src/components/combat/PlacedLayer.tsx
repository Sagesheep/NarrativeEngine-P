import type { ReactNode } from 'react';
import type { CombatPos } from '../../types';
import { TILE_SIZE, tileCenter } from './combatVisuals';
import type { PlacedView } from './placedView';

export type EffectsLevel = 'off' | 'subtle' | 'enhanced';

const HALO = 'var(--combat-board-bg)';

const MOTION_CSS = `
@keyframes combat-placed-flicker { 0%, 100% { opacity: .75 } 50% { opacity: 1 } }
@keyframes combat-placed-pulse { 0%, 100% { opacity: .65 } 50% { opacity: 1 } }
.combat-placed-flicker { animation: combat-placed-flicker 1.4s ease-in-out infinite; }
.combat-placed-pulse { animation: combat-placed-pulse 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .combat-placed-flicker, .combat-placed-pulse { animation: none; } }
`;

function fillOpacity(effects: EffectsLevel, base: number): number {
    if (effects === 'enhanced') return Math.min(0.6, base + 0.12);
    return base;
}

function MarkTile({ view, p, effects }: { view: PlacedView; p: CombatPos; effects: EffectsLevel }) {
    const left = p.x * TILE_SIZE;
    const top = p.y * TILE_SIZE;
    const c = tileCenter(p);
    const color = view.color;
    const moving = effects !== 'off' ? 'combat-placed-flicker' : undefined;
    let detail: ReactNode = null;
    switch (view.mark) {
        case 'flames':
        case 'molten':
            detail = (
                <g className={moving}>
                    {[-2.4, 0, 2.4].map(dx => (
                        <path
                            key={dx}
                            d={`M ${c.x + dx} ${c.y + 2.6} Q ${c.x + dx - 1.3} ${c.y + 0.6} ${c.x + dx} ${c.y - 2.4} Q ${c.x + dx + 1.3} ${c.y + 0.6} ${c.x + dx} ${c.y + 2.6} Z`}
                            style={{ fill: color, stroke: HALO, strokeWidth: 0.25 }}
                        />
                    ))}
                    {view.mark === 'molten' && <path d={`M ${left + 1.5} ${top + 8} L ${left + 4} ${top + 6.5} L ${left + 6} ${top + 8.2} L ${left + 8.5} ${top + 6.8}`} style={{ fill: 'none', stroke: color, strokeWidth: 0.6 }} />}
                </g>
            );
            break;
        case 'rubble':
            detail = (
                <g>
                    {[[2.5, 3], [6.5, 2.8], [4.5, 6.5], [7.5, 7], [2.8, 7.6]].map(([dx, dy]) => (
                        <circle key={`${dx},${dy}`} cx={left + dx} cy={top + dy} r={1} style={{ fill: color, stroke: HALO, strokeWidth: 0.3 }} />
                    ))}
                </g>
            );
            break;
        case 'slick':
            detail = (
                <g>
                    {[1.5, 4.5, 7.5].map(d => (
                        <line key={d} x1={left + d} y1={top + 8.5} x2={left + d + 2} y2={top + 1.5} style={{ stroke: color, strokeWidth: 0.6, strokeLinecap: 'round' }} />
                    ))}
                </g>
            );
            break;
        case 'sticky':
            detail = (
                <g>
                    {[[3, 3.5, 1.6], [7, 4, 1.3], [5, 7.2, 1.8]].map(([dx, dy, r]) => (
                        <ellipse key={`${dx},${dy}`} cx={left + dx} cy={top + dy} rx={r} ry={r * 0.7} style={{ fill: color, fillOpacity: 0.8, stroke: HALO, strokeWidth: 0.3 }} />
                    ))}
                </g>
            );
            break;
        case 'dim':
            detail = <rect x={left} y={top} width={TILE_SIZE} height={TILE_SIZE} style={{ fill: '#0b0716', fillOpacity: effects === 'enhanced' ? 0.55 : 0.42 }} />;
            break;
        default:
            detail = null;
    }
    return (
        <g data-testid="combat-mark-tile" data-x={p.x} data-y={p.y} data-mark={view.mark}>
            <rect x={left + 0.3} y={top + 0.3} width={TILE_SIZE - 0.6} height={TILE_SIZE - 0.6} style={{ fill: color, fillOpacity: fillOpacity(effects, 0.18), stroke: color, strokeWidth: 0.35, strokeOpacity: 0.8 }} />
            {detail}
        </g>
    );
}

function SigilTile({ view, p, effects }: { view: PlacedView; p: CombatPos; effects: EffectsLevel }) {
    const c = tileCenter(p);
    const r = TILE_SIZE * 0.36;
    const star = [0, 1, 2, 3, 4].map(i => {
        const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
        return `${(c.x + Math.cos(a) * r * 0.8).toFixed(2)},${(c.y + Math.sin(a) * r * 0.8).toFixed(2)}`;
    }).join(' ');
    return (
        <g data-testid="combat-sigil-tile" data-x={p.x} data-y={p.y} className={effects !== 'off' ? 'combat-placed-pulse' : undefined}>
            <circle cx={c.x} cy={c.y} r={r} style={{ fill: 'none', stroke: HALO, strokeWidth: 1.6 }} />
            <circle cx={c.x} cy={c.y} r={r} style={{ fill: view.color, fillOpacity: fillOpacity(effects, 0.12), stroke: view.color, strokeWidth: 0.6 }} />
            <polygon points={star} style={{ fill: 'none', stroke: view.color, strokeWidth: 0.45, strokeLinejoin: 'round' }} />
        </g>
    );
}

function DelayTile({ view, p, effects }: { view: PlacedView; p: CombatPos; effects: EffectsLevel }) {
    const left = p.x * TILE_SIZE;
    const top = p.y * TILE_SIZE;
    const c = tileCenter(p);
    return (
        <g data-testid="combat-delay-tile" data-x={p.x} data-y={p.y} className={effects !== 'off' ? 'combat-placed-pulse' : undefined}>
            <rect x={left + 0.8} y={top + 0.8} width={TILE_SIZE - 1.6} height={TILE_SIZE - 1.6} rx={1} style={{ fill: view.color, fillOpacity: fillOpacity(effects, 0.12), stroke: view.color, strokeWidth: 0.6, strokeDasharray: '1.2 0.8' }} />
            <path d={`M ${c.x - 1.6} ${c.y - 2.4} L ${c.x + 1.6} ${c.y - 2.4} L ${c.x - 1.6} ${c.y + 2.4} L ${c.x + 1.6} ${c.y + 2.4} Z`} style={{ fill: 'none', stroke: HALO, strokeWidth: 1.4, strokeLinejoin: 'round' }} />
            <path d={`M ${c.x - 1.6} ${c.y - 2.4} L ${c.x + 1.6} ${c.y - 2.4} L ${c.x - 1.6} ${c.y + 2.4} L ${c.x + 1.6} ${c.y + 2.4} Z`} style={{ fill: 'none', stroke: view.color, strokeWidth: 0.5, strokeLinejoin: 'round' }} />
        </g>
    );
}

function WallTile({ view, p }: { view: PlacedView; p: CombatPos }) {
    const left = p.x * TILE_SIZE;
    const top = p.y * TILE_SIZE;
    return (
        <rect
            data-testid="combat-wall-tile"
            data-x={p.x}
            data-y={p.y}
            x={left + 0.2}
            y={top + 0.2}
            width={TILE_SIZE - 0.4}
            height={TILE_SIZE - 0.4}
            rx={1}
            style={{ fill: 'none', stroke: view.color, strokeWidth: 0.7 }}
        />
    );
}

function MantleZone({ view, width, height, effects }: { view: PlacedView; width: number; height: number; effects: EffectsLevel }) {
    if (!view.centre || view.radius === undefined) return null;
    const x0 = Math.max(0, view.centre.x - view.radius);
    const y0 = Math.max(0, view.centre.y - view.radius);
    const x1 = Math.min(width - 1, view.centre.x + view.radius);
    const y1 = Math.min(height - 1, view.centre.y + view.radius);
    return (
        <g data-testid="combat-mantle-zone" data-x={view.centre.x} data-y={view.centre.y} data-radius={view.radius} className={effects !== 'off' ? 'combat-placed-pulse' : undefined}>
            <rect x={x0 * TILE_SIZE + 0.4} y={y0 * TILE_SIZE + 0.4} width={(x1 - x0 + 1) * TILE_SIZE - 0.8} height={(y1 - y0 + 1) * TILE_SIZE - 0.8} rx={2} style={{ fill: 'none', stroke: HALO, strokeWidth: 1.6 }} />
            <rect x={x0 * TILE_SIZE + 0.4} y={y0 * TILE_SIZE + 0.4} width={(x1 - x0 + 1) * TILE_SIZE - 0.8} height={(y1 - y0 + 1) * TILE_SIZE - 0.8} rx={2} style={{ fill: view.color, fillOpacity: fillOpacity(effects, 0.08), stroke: view.color, strokeWidth: 0.6, strokeDasharray: '2 1' }} />
        </g>
    );
}

export function PlacedLayer({ views, width, height, effects }: { views: readonly PlacedView[]; width: number; height: number; effects: EffectsLevel }) {
    if (views.length === 0) return null;
    return (
        <g data-testid="combat-placed" data-effects={effects} style={{ pointerEvents: 'none' }}>
            {effects !== 'off' && <style>{MOTION_CSS}</style>}
            {views.map(view => (
                <g
                    key={view.id}
                    data-testid={`combat-placed-${view.kind}`}
                    data-id={view.id}
                    data-element={view.element}
                    role="img"
                    aria-label={view.label}
                >
                    <title>{view.label}</title>
                    {view.kind === 'mark' && view.tiles.map(p => <MarkTile key={`${p.x},${p.y}`} view={view} p={p} effects={effects} />)}
                    {view.kind === 'sigil' && view.tiles.map(p => <SigilTile key={`${p.x},${p.y}`} view={view} p={p} effects={effects} />)}
                    {view.kind === 'delay' && view.tiles.map(p => <DelayTile key={`${p.x},${p.y}`} view={view} p={p} effects={effects} />)}
                    {view.kind === 'wall' && view.tiles.map(p => <WallTile key={`${p.x},${p.y}`} view={view} p={p} />)}
                    {view.kind === 'mantle' && <MantleZone view={view} width={width} height={height} effects={effects} />}
                </g>
            ))}
        </g>
    );
}
