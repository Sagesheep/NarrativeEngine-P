import { TILE_SIZE, tileCenter } from './combatVisuals';
import { wrapLine } from './directorBubbles';
import type { OrderBubble } from './directorBubbles';

const HALO = 'var(--combat-board-bg)';
const BUBBLE_FONT = 2.6;
const BUBBLE_PAD = 1.2;
const CHAR_WIDTH = 0.55;

export function OfficerBadge({ x, y, r, label }: { x: number; y: number; r: number; label: string }) {
    const bx = x + r * 0.78;
    const by = y + r * 0.78;
    const color = 'var(--combat-hp-warn)';
    return (
        <g data-testid="combat-badge-officer" role="img" aria-label={label} style={{ pointerEvents: 'none' }}>
            <title>{label}</title>
            <circle cx={bx} cy={by} r={2.1} style={{ fill: HALO, stroke: color, strokeWidth: 0.6 }} />
            <polyline points={`${bx - 1.2},${by - 0.2} ${bx},${by - 1.2} ${bx + 1.2},${by - 0.2}`} style={{ fill: 'none', stroke: color, strokeWidth: 0.55, strokeLinejoin: 'round', strokeLinecap: 'round' }} />
            <polyline points={`${bx - 1.2},${by + 0.9} ${bx},${by - 0.1} ${bx + 1.2},${by + 0.9}`} style={{ fill: 'none', stroke: color, strokeWidth: 0.55, strokeLinejoin: 'round', strokeLinecap: 'round' }} />
        </g>
    );
}

export function OrderBubbles({
    bubbles, width, height, animate, label,
}: {
    bubbles: readonly OrderBubble[];
    width: number;
    height: number;
    animate: boolean;
    label: (b: OrderBubble) => string;
}) {
    if (bubbles.length === 0) return null;
    const w = width * TILE_SIZE;
    const h = height * TILE_SIZE;
    return (
        <g data-testid="combat-order-bubbles" style={{ pointerEvents: 'none' }}>
            {animate && <style>{`
                @keyframes combat-bubble-in { from { opacity: 0; transform: translateY(1.5px) } to { opacity: 1; transform: none } }
                .combat-order-bubble { animation: combat-bubble-in .35s ease-out both; }
                @media (prefers-reduced-motion: reduce) { .combat-order-bubble { animation: none; } }
            `}</style>}
            {bubbles.map(b => {
                const lines = wrapLine(b.line);
                const longest = Math.max(...lines.map(l => l.length));
                const bw = longest * BUBBLE_FONT * CHAR_WIDTH + BUBBLE_PAD * 2;
                const bh = lines.length * BUBBLE_FONT * 1.2 + BUBBLE_PAD * 2;
                const c = tileCenter(b.pos);
                const left = Math.min(Math.max(0.5, c.x - bw / 2), Math.max(0.5, w - bw - 0.5));
                const above = c.y - TILE_SIZE * 0.45 - bh - 1.6;
                const top = above >= 0.5 ? above : Math.min(h - bh - 0.5, c.y + TILE_SIZE * 0.45 + 1.6);
                const tailX = Math.min(Math.max(left + 1.5, c.x), left + bw - 1.5);
                const tailY = above >= 0.5 ? top + bh : top;
                const tipY = above >= 0.5 ? tailY + 1.6 : tailY - 1.6;
                return (
                    <g
                        key={`${b.id}-${b.seq}`}
                        data-testid={`combat-order-bubble-${b.id}`}
                        className={animate ? 'combat-order-bubble' : undefined}
                        role="img"
                        aria-label={label(b)}
                    >
                        <title>{label(b)}</title>
                        <polygon points={`${tailX - 1},${tailY} ${tailX + 1},${tailY} ${c.x},${tipY}`} style={{ fill: 'var(--combat-token-text)', stroke: HALO, strokeWidth: 0.3 }} />
                        <rect x={left} y={top} width={bw} height={bh} rx={1.2} style={{ fill: 'var(--combat-token-text)', stroke: HALO, strokeWidth: 0.4 }} />
                        {lines.map((line, i) => (
                            <text
                                key={i}
                                x={left + BUBBLE_PAD}
                                y={top + BUBBLE_PAD + BUBBLE_FONT * (i + 0.85) * 1.2 - BUBBLE_FONT * 0.2}
                                style={{ fontSize: BUBBLE_FONT, fill: HALO, fontWeight: 600 }}
                            >
                                {line}
                            </text>
                        ))}
                    </g>
                );
            })}
        </g>
    );
}
