import type { Barrier, FieldItem, PushPreview, ThrowPlan } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatPos, CombatState, Combatant } from '../../types';
import { TILE_SIZE, posKey, tileCenter } from './combatVisuals';
import { elementColor } from './elementText';
import type { AbilityAim, AimPreview } from './useAbilityAim';

export function FieldItemLayer({ items }: { items: readonly FieldItem[] | undefined }) {
    const { t } = useTranslation();
    if (!items || items.length === 0) return null;
    return (
        <g data-testid="combat-field-items" style={{ pointerEvents: 'none' }}>
            {items.map(item => {
                const cx = item.pos.x * TILE_SIZE + TILE_SIZE / 2;
                const cy = item.pos.y * TILE_SIZE + TILE_SIZE / 2;
                return (
                    <g
                        key={`i${item.id}`}
                        data-testid="combat-field-item"
                        data-id={item.id}
                        data-x={item.pos.x}
                        data-y={item.pos.y}
                        role="img"
                        aria-label={t('combat.item.mark', { name: item.name })}
                    >
                        <title>{t('combat.item.mark', { name: item.name })}</title>
                        <circle cx={cx} cy={cy} r={TILE_SIZE * 0.26} style={{ fill: 'var(--combat-board-bg)', fillOpacity: 0.6, stroke: 'var(--combat-path)', strokeWidth: 0.5 }} />
                        <path
                            d={`M ${cx - 2} ${cy + 2} L ${cx + 2} ${cy - 2} M ${cx + 0.4} ${cy - 2} L ${cx + 2} ${cy - 2} L ${cx + 2} ${cy - 0.4}`}
                            style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 0.7, strokeLinecap: 'round', strokeLinejoin: 'round' }}
                        />
                    </g>
                );
            })}
        </g>
    );
}

function ThrowTrail({ plan }: { plan: ThrowPlan }) {
    const from = tileCenter(plan.from);
    const points = [plan.from, ...plan.path].map(p => {
        const c = tileCenter(p);
        return `${c.x},${c.y}`;
    }).join(' ');
    const end = plan.endsAt ?? plan.landing;
    const endCenter = tileCenter(end);
    const landCenter = tileCenter(plan.landing);
    return (
        <g
            data-testid="combat-throw"
            data-landing-x={plan.landing.x}
            data-landing-y={plan.landing.y}
            data-ends-x={end.x}
            data-ends-y={end.y}
            data-displaced={plan.displaced ? 'true' : 'false'}
            data-hazard={plan.hazard ? 'true' : 'false'}
            style={{ pointerEvents: 'none' }}
        >
            <polyline
                data-testid="combat-throw-path"
                points={points}
                style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 0.9, strokeDasharray: '1.6 1', strokeLinecap: 'round' }}
            />
            <circle cx={from.x} cy={from.y} r={0.9} style={{ fill: 'var(--combat-path)' }} />
            <rect
                data-testid="combat-throw-landing"
                data-x={plan.landing.x}
                data-y={plan.landing.y}
                x={plan.landing.x * TILE_SIZE + 1}
                y={plan.landing.y * TILE_SIZE + 1}
                width={TILE_SIZE - 2}
                height={TILE_SIZE - 2}
                style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 1.1 }}
            />
            {plan.displaced && (
                <>
                    <line x1={landCenter.x} y1={landCenter.y} x2={endCenter.x} y2={endCenter.y} style={{ stroke: 'var(--combat-path)', strokeWidth: 0.7, strokeDasharray: '0.8 0.8' }} />
                    <circle
                        data-testid="combat-throw-ends"
                        data-x={end.x}
                        data-y={end.y}
                        cx={endCenter.x}
                        cy={endCenter.y}
                        r={TILE_SIZE * 0.4}
                        style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 0.9, strokeDasharray: '1 0.7' }}
                    />
                </>
            )}
            {plan.hazard && (
                <rect
                    data-testid="combat-throw-hazard"
                    data-x={end.x}
                    data-y={end.y}
                    x={end.x * TILE_SIZE + 0.6}
                    y={end.y * TILE_SIZE + 0.6}
                    width={TILE_SIZE - 1.2}
                    height={TILE_SIZE - 1.2}
                    style={{ fill: 'var(--combat-hazard)', stroke: 'var(--combat-hazard-mark)', strokeWidth: 1, strokeDasharray: '1.2 0.8' }}
                />
            )}
            {plan.terrain.map(change => change.to === 'floor'
                ? (
                    <path
                        key={`l${change.pos.x},${change.pos.y}`}
                        data-testid="combat-throw-lifted"
                        data-x={change.pos.x}
                        data-y={change.pos.y}
                        d={`M ${change.pos.x * TILE_SIZE + 2} ${change.pos.y * TILE_SIZE + 2} L ${change.pos.x * TILE_SIZE + TILE_SIZE - 2} ${change.pos.y * TILE_SIZE + TILE_SIZE - 2} M ${change.pos.x * TILE_SIZE + TILE_SIZE - 2} ${change.pos.y * TILE_SIZE + 2} L ${change.pos.x * TILE_SIZE + 2} ${change.pos.y * TILE_SIZE + TILE_SIZE - 2}`}
                        style={{ stroke: 'var(--combat-path)', strokeWidth: 0.5, opacity: 0.8 }}
                    />
                )
                : (
                    <rect
                        key={`r${change.pos.x},${change.pos.y}`}
                        data-testid="combat-throw-rubble"
                        data-x={change.pos.x}
                        data-y={change.pos.y}
                        x={change.pos.x * TILE_SIZE + 2}
                        y={change.pos.y * TILE_SIZE + 2}
                        width={TILE_SIZE - 4}
                        height={TILE_SIZE - 4}
                        style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 0.5, strokeDasharray: '0.6 0.6' }}
                    />
                ))}
        </g>
    );
}

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

function PushTrail({ push }: { push: PushPreview }) {
    const start = tileCenter(push.from);
    const end = tileCenter(push.landing);
    const points = [push.from, ...push.path].map(p => {
        const c = tileCenter(p);
        return `${c.x},${c.y}`;
    }).join(' ');
    return (
        <g data-testid="combat-push" data-target={push.targetId} data-squares={push.squares} data-slid={push.slid ? 'true' : 'false'} style={{ pointerEvents: 'none' }}>
            {push.squares > 0 ? (
                <>
                    <polyline points={points} style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 0.9, strokeDasharray: '1.6 1', strokeLinecap: 'round' }} />
                    <rect
                        data-testid="combat-push-landing"
                        data-x={push.landing.x}
                        data-y={push.landing.y}
                        x={push.landing.x * TILE_SIZE + 1}
                        y={push.landing.y * TILE_SIZE + 1}
                        width={TILE_SIZE - 2}
                        height={TILE_SIZE - 2}
                        style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 1.1 }}
                    />
                    <circle cx={end.x} cy={end.y} r={1.2} style={{ fill: 'var(--combat-path)' }} />
                </>
            ) : (
                <path
                    data-testid="combat-push-blocked"
                    d={`M ${start.x - 2.5} ${start.y - 2.5} L ${start.x + 2.5} ${start.y + 2.5} M ${start.x + 2.5} ${start.y - 2.5} L ${start.x - 2.5} ${start.y + 2.5}`}
                    style={{ stroke: 'var(--combat-enemy)', strokeWidth: 1.2, strokeLinecap: 'round' }}
                />
            )}
            {push.hazards.map(p => (
                <rect
                    key={`hz${p.x},${p.y}`}
                    data-testid="combat-push-hazard"
                    data-x={p.x}
                    data-y={p.y}
                    x={p.x * TILE_SIZE + 0.6}
                    y={p.y * TILE_SIZE + 0.6}
                    width={TILE_SIZE - 1.2}
                    height={TILE_SIZE - 1.2}
                    style={{ fill: 'var(--combat-hazard)', stroke: 'var(--combat-hazard-mark)', strokeWidth: 1, strokeDasharray: '1.2 0.8' }}
                />
            ))}
        </g>
    );
}

export function AimOverlay({ aim, preview, focus, state }: { aim: AbilityAim; preview: AimPreview | null; focus: CombatPos | null; state: CombatState }) {
    const legalFocus = !!focus && aim.legal.has(posKey(focus)) && !!preview?.ok;
    const tint = elementColor(aim.ability.element);
    return (
        <g data-testid="combat-aim" data-element={tint ? aim.ability.element : undefined}>
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
            {legalFocus && !preview?.plan && preview?.tiles.map(p => (
                <rect
                    key={`p${p.x},${p.y}`}
                    data-testid="combat-aim-area"
                    data-x={p.x}
                    data-y={p.y}
                    x={p.x * TILE_SIZE}
                    y={p.y * TILE_SIZE}
                    width={TILE_SIZE}
                    height={TILE_SIZE}
                    style={tint ? { fill: tint, fillOpacity: 0.32, stroke: tint, strokeWidth: 0.3 } : { fill: 'var(--combat-target)' }}
                />
            ))}
            {legalFocus && preview?.plan && <ThrowTrail plan={preview.plan} />}
            {legalFocus && preview?.pushes.map(push => <PushTrail key={`push${push.targetId}`} push={push} />)}
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
