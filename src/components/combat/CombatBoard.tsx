import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { X } from 'lucide-react';
import { canTarget, checkAttack, coverBetween, currentActorId, currentTurn, distance, inBounds, pathTo, reachable, terrainOf, tileAt } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { useAppStore } from '../../store/useAppStore';
import { normalizeCombatConfig } from '../../types';
import type { CombatAction, CombatGrid, CombatPos, CombatSession, CombatTile, Combatant } from '../../types';
import { hpBandLabel } from '../../services/combat/combatEvents';
import { playerActorId } from '../../services/combat/combatController';
import { isTypingTarget } from './combatKeys';
import { useTerrainNames } from './useTerrainNames';
import {
    BAND_KEY, LEGEND_TILES, TILE_FILL, TILE_SIZE, attackableTargets, hpColor, initialLegendOpen, inspectCorner, isParty,
    playerCharacter, posKey as key, rememberLegendDismissed, sideColor, terrainLabel, tileCenter as center, tokenAt,
} from './combatVisuals';
import type { Corner } from './combatVisuals';
import { initialTileArt, rememberTileArt, tileUrl } from './tileAvailability';
import { cellArt } from './tileset';
import type { TileArt } from './tileset';
import { useTileArt } from './useTileArt';
import type { TileArtState } from './useTileArt';
import type { AbilityAim } from './useAbilityAim';
import { AimOverlay, BarrierLayer, ConditionBadges, TempHpRing } from './abilityOverlays';
import { combatantNotes } from './abilityNotes';

type TileLayerProps = {
    grid: CombatGrid;
    patternId: string;
    onTile?: (p: CombatPos) => void;
    onHover?: (p: CombatPos | null) => void;
    names?: Partial<Record<CombatTile, string>>;
    art?: TileArtState | null;
};

function FlatCues({ tile, left, top, patternId }: { tile: CombatTile; left: number; top: number; patternId: string }) {
    return (
        <>
            {tile === 'difficult' && (
                <rect x={left} y={top} width={TILE_SIZE} height={TILE_SIZE} style={{ fill: `url(#${patternId})`, pointerEvents: 'none' }} />
            )}
            {tile === 'hazard' && (
                <>
                    <rect x={left} y={top} width={TILE_SIZE} height={TILE_SIZE} style={{ fill: 'var(--combat-hazard)', pointerEvents: 'none' }} />
                    <path
                        data-testid="combat-hazard-mark"
                        d={`M ${left + 5} ${top + 2.6} L ${left + 7.6} ${top + 7.2} L ${left + 2.4} ${top + 7.2} Z`}
                        style={{ fill: 'none', stroke: 'var(--combat-hazard-mark)', strokeWidth: 0.6, strokeLinejoin: 'round', pointerEvents: 'none' }}
                    />
                </>
            )}
            {tile === 'cover' && (
                <rect x={left + 1.5} y={top + 1.5} width={TILE_SIZE - 3} height={TILE_SIZE - 3} rx={1.5} style={{ fill: 'none', stroke: 'var(--combat-cover-stroke)', strokeWidth: 0.8, pointerEvents: 'none' }} />
            )}
        </>
    );
}

function TileImage({ art, x, y, tile, onFail }: { art: TileArt; x: number; y: number; tile: CombatTile; onFail: (path: string) => void }) {
    const left = x * TILE_SIZE;
    const top = y * TILE_SIZE;
    const size = art.opaque ? TILE_SIZE + 0.04 : TILE_SIZE;
    return (
        <image
            data-testid="combat-tile-art"
            data-x={x}
            data-y={y}
            data-tile={tile}
            data-path={art.path}
            data-mirror={art.mirror ? 'true' : undefined}
            href={tileUrl(art.path)}
            x={left}
            y={top}
            width={size}
            height={size}
            preserveAspectRatio="none"
            transform={art.mirror ? `matrix(-1 0 0 1 ${2 * (left + TILE_SIZE / 2)} 0)` : undefined}
            style={{ pointerEvents: 'none' }}
            onError={() => onFail(art.path)}
        />
    );
}

function ArtTileLayer({ grid, patternId, onTile, onHover, names, art }: TileLayerProps & { art: TileArtState }) {
    const base = [];
    const lines = [];
    const ground = [];
    const objects = [];
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const tile = grid.tiles[y * grid.width + x];
            const left = x * TILE_SIZE;
            const top = y * TILE_SIZE;
            const k = `${x},${y}`;
            const cell = cellArt(art.tileset, art.tiles, grid, x, y, art.seed);
            if (cell.flat) {
                base.push(
                    <g key={k} data-testid="combat-tile-flat" data-x={x} data-y={y} data-tile={tile}>
                        <rect x={left} y={top} width={TILE_SIZE} height={TILE_SIZE} style={{ fill: TILE_FILL[tile], pointerEvents: 'none' }} />
                        <FlatCues tile={tile} left={left} top={top} patternId={patternId} />
                    </g>,
                );
            } else {
                base.push(cell.base
                    ? <TileImage key={k} art={cell.base} x={x} y={y} tile={tile} onFail={art.onFail} />
                    : <rect key={k} x={left} y={top} width={TILE_SIZE} height={TILE_SIZE} style={{ fill: TILE_FILL.floor, pointerEvents: 'none' }} />);
                if (cell.top) {
                    const image = <TileImage key={k} art={cell.top} x={x} y={y} tile={tile} onFail={art.onFail} />;
                    if (tile === 'cover' || tile === 'wall') objects.push(image);
                    else ground.push(image);
                }
                if (tile === 'hazard') {
                    ground.push(
                        <rect
                            key={`h${k}`}
                            data-testid="combat-hazard-outline"
                            x={left + 0.35}
                            y={top + 0.35}
                            width={TILE_SIZE - 0.7}
                            height={TILE_SIZE - 0.7}
                            style={{ fill: 'none', stroke: 'var(--combat-hazard-mark)', strokeWidth: 0.4, pointerEvents: 'none' }}
                        />,
                    );
                }
            }
            lines.push(
                <rect
                    key={k}
                    data-x={x}
                    data-y={y}
                    data-tile={tile}
                    x={left}
                    y={top}
                    width={TILE_SIZE}
                    height={TILE_SIZE}
                    style={{ fill: 'transparent', stroke: 'var(--combat-grid-line)', strokeWidth: 0.3 }}
                    onClick={onTile ? () => onTile({ x, y }) : undefined}
                    onMouseEnter={onHover ? () => onHover({ x, y }) : undefined}
                >
                    {names?.[tile] && <title>{names[tile]}</title>}
                </rect>,
            );
        }
    }
    return (
        <g data-testid="combat-tiles" data-art="on">
            <g data-testid="combat-art-base">{base}</g>
            <g data-testid="combat-grid-lines">{lines}</g>
            <g data-testid="combat-art-ground">{ground}</g>
            <g data-testid="combat-art-cover">{objects}</g>
        </g>
    );
}

export const TileLayer = memo(function TileLayer({ grid, patternId, onTile, onHover, names, art }: TileLayerProps) {
    if (art) return <ArtTileLayer grid={grid} patternId={patternId} onTile={onTile} onHover={onHover} names={names} art={art} />;
    const cells = [];
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            const tile = grid.tiles[y * grid.width + x];
            const left = x * TILE_SIZE;
            const top = y * TILE_SIZE;
            cells.push(
                <g key={`${x},${y}`}>
                    <rect
                        data-x={x}
                        data-y={y}
                        data-tile={tile}
                        x={left}
                        y={top}
                        width={TILE_SIZE}
                        height={TILE_SIZE}
                        style={{ fill: TILE_FILL[tile], stroke: 'var(--combat-grid-line)', strokeWidth: 0.3 }}
                        onClick={onTile ? () => onTile({ x, y }) : undefined}
                        onMouseEnter={onHover ? () => onHover({ x, y }) : undefined}
                    >
                        {names?.[tile] && <title>{names[tile]}</title>}
                    </rect>
                    <FlatCues tile={tile} left={left} top={top} patternId={patternId} />
                </g>,
            );
        }
    }
    return <g data-testid="combat-tiles">{cells}</g>;
});

export function HatchPattern({ id }: { id: string }) {
    return (
        <defs>
            <pattern id={id} width={3} height={3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1={0} y1={0} x2={0} y2={3} style={{ stroke: 'var(--combat-difficult-hatch)', strokeWidth: 0.6 }} />
            </pattern>
        </defs>
    );
}

function TileSwatch({ tile }: { tile: CombatTile }) {
    const patternId = `combat-legend-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const grid = useMemo<CombatGrid>(() => ({ width: 1, height: 1, tiles: [tile] }), [tile]);
    return (
        <svg viewBox={`0 0 ${TILE_SIZE} ${TILE_SIZE}`} width={14} height={14} aria-hidden="true" className="shrink-0 border border-border">
            <HatchPattern id={patternId} />
            <TileLayer grid={grid} patternId={patternId} />
        </svg>
    );
}

export function TerrainKeyItems({ grid }: { grid: CombatGrid | undefined }) {
    const { t } = useTranslation();
    return (
        <>
            {LEGEND_TILES.map(tile => {
                const label = terrainLabel(grid, tile);
                return (
                    <li key={tile} className="flex items-center gap-1 text-text-dim">
                        <TileSwatch tile={tile} />
                        <span>{label ? t('combat.legend.item', { kind: t(`combat.terrain.${tile}`), label }) : t(`combat.board.tile.${tile}`)}</span>
                    </li>
                );
            })}
        </>
    );
}

function BoardLegend({ grid, tileArt }: { grid: CombatGrid; tileArt?: { on: boolean; toggle: () => void } }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState<boolean>(() => initialLegendOpen());
    const toggle = () => {
        if (open) rememberLegendDismissed();
        setOpen(!open);
    };
    return (
        <div data-testid="combat-legend" className="flex items-center gap-3 flex-wrap justify-end">
            {open && (
                <ul id="combat-legend-list" className="flex items-center gap-3 flex-wrap">
                    <TerrainKeyItems grid={grid} />
                </ul>
            )}
            <span id="combat-board-help" className={open ? 'text-text-dim' : 'sr-only'}>{t('combat.board.help')}</span>
            {tileArt && (
                <button
                    type="button"
                    data-testid="combat-tile-art-toggle"
                    onClick={tileArt.toggle}
                    aria-pressed={tileArt.on}
                    className={`border border-border px-1.5 py-0.5 rounded-sm hover:text-text-primary ${tileArt.on ? 'text-text-primary' : 'text-text-dim'}`}
                >
                    {t('combat.legend.tileArt')}
                </button>
            )}
            <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-controls="combat-legend-list"
                className="border border-border px-1.5 py-0.5 rounded-sm text-text-dim hover:text-text-primary"
            >
                {t(open ? 'combat.legend.hide' : 'combat.legend.show')}
            </button>
        </div>
    );
}

const CORNER_CLASS: Record<Corner, string> = {
    'top-left': 'top-2 left-2',
    'top-right': 'top-2 right-2',
    'bottom-left': 'bottom-2 left-2',
    'bottom-right': 'bottom-2 right-2',
};

function InspectCard({
    combatant,
    viewer,
    session,
    corner,
    onClose,
}: {
    combatant: Combatant;
    viewer: Combatant | undefined;
    session: CombatSession;
    corner: Corner;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const state = session.state;
    const party = isParty(combatant);
    const hp = party ? t('combat.panel.hp', { hp: combatant.hp, max: combatant.maxHp }) : t(BAND_KEY[hpBandLabel(combatant)]);
    const self = viewer?.id === combatant.id;
    const dist = !self && viewer?.position && combatant.position ? distance(viewer.position, combatant.position) : null;
    let blocked: string | null = null;
    if (viewer && !self && combatant.status === 'up' && canTarget(viewer, combatant)) {
        const check = checkAttack(state, viewer.id, combatant.id);
        if (!check.ok && check.reason === 'out_of_range') blocked = t('combat.inspect.outOfRange');
        if (!check.ok && check.reason === 'no_line_of_sight') blocked = t('combat.inspect.noSight');
    }
    const grid = state.grid;
    const terrain = terrainOf(state);
    const standing = grid && combatant.position ? terrainLabel(grid, tileAt(grid, combatant.position)) : null;
    const coverLabel = grid ? terrainLabel(grid, 'cover') : null;
    const behind = !self && terrain && coverLabel && viewer?.position && combatant.position && coverBetween(terrain, viewer.position, combatant.position) > 0 ? coverLabel : null;
    const resourceLabel = useAppStore(s => normalizeCombatConfig(s.context?.combatConfig).resourceLabel);
    const notes = combatantNotes(combatant, resourceLabel, t);
    return (
        <div
            data-testid="combat-inspect"
            data-corner={corner}
            role="group"
            aria-label={combatant.name}
            className={`absolute ${CORNER_CLASS[corner]} z-10 w-52 max-w-[45%] bg-surface border border-border rounded-sm shadow-lg px-3 py-2 text-[11px] font-mono space-y-0.5`}
        >
            <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: sideColor(combatant.side) }} />
                <span className="flex-1 truncate font-bold text-text-primary">{combatant.name}</span>
                <button type="button" onClick={onClose} aria-label={t('combat.inspect.close')} title={t('combat.inspect.close')} className="text-text-dim hover:text-text-primary p-0.5">
                    <X size={11} />
                </button>
            </div>
            <div className="text-text-dim">{t(`combat.side.${combatant.side}`)} · {t(`combat.tier.${combatant.tier}`)}</div>
            <div className="text-text-primary">{hp}{party ? ` · ${t('combat.inspect.ac', { ac: combatant.ac })}` : ''}</div>
            {dist !== null && <div className="text-text-dim">{t('combat.inspect.distance', { count: dist })}</div>}
            {standing && <div data-testid="combat-inspect-terrain" className="text-text-dim">{t('combat.inspect.standingIn', { label: standing })}</div>}
            {behind && <div data-testid="combat-inspect-behind" className="text-text-dim">{t('combat.inspect.behind', { label: behind })}</div>}
            {blocked && <div data-testid="combat-inspect-blocked" style={{ color: 'var(--combat-hp-warn)' }}>{blocked}</div>}
            {notes.map(note => <div key={note} data-testid="combat-inspect-note" className="text-text-dim">{note}</div>)}
        </div>
    );
}

function useMoveAnimation(session: CombatSession): Record<string, CombatPos> {
    const [shown, setShown] = useState<Record<string, CombatPos>>({});
    const lastSeq = useRef<number>(session.log.reduce((m, e) => Math.max(m, e.seq), 0));
    const timers = useRef<number[]>([]);
    useEffect(() => () => { timers.current.forEach(id => window.clearTimeout(id)); }, []);
    useEffect(() => {
        const fresh = session.log.filter(e => e.seq > lastSeq.current && e.type === 'moved' && e.actorId);
        lastSeq.current = session.log.reduce((m, e) => Math.max(m, e.seq), lastSeq.current);
        let delay = 0;
        for (const event of fresh) {
            const path = Array.isArray(event.data.path) ? event.data.path as CombatPos[] : [];
            const id = event.actorId as string;
            const from = event.data.from as CombatPos | undefined;
            if (from) {
                const start = delay;
                timers.current.push(window.setTimeout(() => setShown(s => ({ ...s, [id]: from })), start));
            }
            for (const step of path) {
                delay += 35;
                timers.current.push(window.setTimeout(() => setShown(s => ({ ...s, [id]: step })), delay));
            }
            delay += 35;
            timers.current.push(window.setTimeout(() => setShown(s => {
                const next = { ...s };
                delete next[id];
                return next;
            }), delay));
        }
    }, [session.log]);
    return shown;
}

type Focus = { pos: CombatPos; source: 'hover' | 'cursor' };

export function CombatBoard({
    session,
    busy,
    targetId,
    onTarget,
    onAction,
    picking = false,
    onPickEnd,
    surfaceRef,
    aim = null,
}: {
    session: CombatSession;
    busy: boolean;
    targetId: string | null;
    onTarget: (id: string | null) => void;
    onAction: (action: CombatAction) => void;
    picking?: boolean;
    onPickEnd?: () => void;
    surfaceRef?: RefObject<HTMLDivElement | null>;
    aim?: AbilityAim | null;
}) {
    const { t } = useTranslation();
    const state = session.state;
    const grid = state.grid;
    const patternId = `combat-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const playerId = playerActorId(state);
    const player = playerId ? state.combatants[playerId] : undefined;
    const viewer = player ?? playerCharacter(state);
    const interactive = !busy && !!player && state.outcome === null;
    const turn = interactive ? currentTurn(state) : null;
    const [hover, setHover] = useState<CombatPos | null>(null);
    const [cursor, setCursor] = useState<CombatPos | null>(null);
    const [escaped, setEscaped] = useState(false);
    const [pickSeen, setPickSeen] = useState(picking);
    if (picking !== pickSeen) {
        setPickSeen(picking);
        const picked = picking && targetId ? state.combatants[targetId]?.position : undefined;
        if (picked) {
            setCursor({ ...picked });
            setHover(null);
            setEscaped(false);
        }
    }
    const shown = useMoveAnimation(session);
    const aiming = !!aim;
    const ownSurface = useRef<HTMLDivElement | null>(null);
    const surface = surfaceRef ?? ownSurface;

    const reach = useMemo(() => {
        const map = new Map<string, number>();
        if (interactive && playerId && !aiming) for (const p of reachable(state, playerId)) map.set(key(p), p.cost);
        return map;
    }, [state, interactive, playerId, aiming]);

    const targets = useMemo(() => {
        if (!player) return [] as Combatant[];
        return state.order.map(id => state.combatants[id]).filter(c => c && c.position && canTarget(player, c));
    }, [state, player]);

    const checks = useMemo(() => {
        const map = new Map<string, ReturnType<typeof checkAttack>>();
        if (player) for (const c of targets) map.set(c.id, checkAttack(state, player.id, c.id));
        return map;
    }, [state, player, targets]);

    const actionLeft = !!turn && (!turn.actionUsed || (turn.extraActions ?? 0) > 0);
    const attackable = useMemo(() => attackableTargets(state, player, actionLeft && !aiming), [state, player, actionLeft, aiming]);

    const focus: Focus | null = hover ? { pos: hover, source: 'hover' } : cursor ? { pos: cursor, source: 'cursor' } : null;
    const focusToken = focus ? tokenAt(state, focus.pos) : undefined;

    const turnKey = interactive ? state.turnCount ?? 0 : null;
    useEffect(() => {
        if (turnKey === null) return;
        const el = surface.current;
        if (!el || isTypingTarget(document.activeElement)) return;
        el.focus({ preventScroll: true });
    }, [turnKey, surface]);

    const describeToken = useCallback((c: Combatant): string => {
        const condition = isParty(c) ? t('combat.board.hpState', { hp: c.hp, max: c.maxHp }) : t(BAND_KEY[hpBandLabel(c)]);
        const side = t(`combat.side.${c.side}`);
        const from = viewer?.position;
        if (!from || !c.position || c.side === 'player') return t('combat.board.tokenSelf', { name: c.name, side, state: condition });
        return t('combat.board.token', { name: c.name, side, state: condition, count: distance(from, c.position) });
    }, [t, viewer]);

    const act = useCallback((p: CombatPos) => {
        if (aim) {
            aim.confirm(p);
            return;
        }
        const token = tokenAt(state, p);
        const canMove = interactive && !!player && reach.has(key(p));
        if (token && (token.status === 'up' || !canMove)) {
            onTarget(token.id);
            if (interactive && player && token.id !== player.id && attackable.some(c => c.id === token.id)) {
                onAction({ type: 'attack', actorId: player.id, targetId: token.id });
                onPickEnd?.();
            }
            return;
        }
        if (picking) {
            onPickEnd?.();
            return;
        }
        if (canMove && player) onAction({ type: 'move', actorId: player.id, to: p });
    }, [interactive, player, state, attackable, reach, onAction, onTarget, picking, onPickEnd, aim]);

    const actRef = useRef(act);
    useEffect(() => { actRef.current = act; }, [act]);
    const onTile = useCallback((p: CombatPos) => actRef.current(p), []);

    const names = useTerrainNames(grid);
    const [tileArtOn, setTileArtOn] = useState<boolean>(() => initialTileArt());
    const artReady = useTileArt(grid, session.map?.place, state.mapSeed ?? 0);
    const art = tileArtOn ? artReady : null;
    const tileArtToggle = useMemo(() => (artReady ? {
        on: tileArtOn,
        toggle: () => {
            rememberTileArt(!tileArtOn);
            setTileArtOn(!tileArtOn);
        },
    } : undefined), [artReady, tileArtOn]);
    const tileLayer = useMemo(() => grid ? <TileLayer grid={grid} patternId={patternId} onTile={onTile} onHover={setHover} names={names} art={art} /> : null, [grid, patternId, onTile, setHover, names, art]);

    if (!grid) return null;

    const actingId = currentActorId(state);
    const focusKey = focus ? key(focus.pos) : null;
    const path = interactive && playerId && focus && reach.has(key(focus.pos)) ? pathTo(state, playerId, focus.pos) : null;
    const focusCheck = focusToken ? checks.get(focusToken.id) : undefined;

    const aimPreview = aim && focus ? aim.preview(focus.pos) : null;
    const focusBarrier = focus ? state.barriers?.find(b => b.pos.x === focus.pos.x && b.pos.y === focus.pos.y) : undefined;
    let status = '';
    if (!interactive) status = state.outcome ? '' : t('combat.board.waiting');
    else if (aim) {
        if (!focus) status = t('combat.aim.status', { name: aim.ability.name });
        else if (aimPreview?.ok && aim.legal.has(key(focus.pos))) status = t('combat.aim.preview', { name: aim.ability.name, count: aimPreview.hits.length, allies: aimPreview.hits.filter(h => h.friendly).length });
        else status = t('combat.aim.illegal', { name: aim.ability.name });
    }
    else if (focusBarrier) status = t('combat.board.barrier', { round: focusBarrier.expiresRound });
    else if (focusToken && focusToken.id !== player?.id && focusCheck) {
        const name = focusToken.name;
        if (!focusCheck.ok) status = t(focusCheck.reason === 'no_line_of_sight' ? 'combat.board.noSight' : 'combat.board.outOfRange', { name });
        else if (!actionLeft) status = `${describeToken(focusToken)}. ${t('combat.board.actionUsed')}`;
        else {
            const notes = [t('combat.board.attack', { name })];
            if (focusCheck.cover > 0) notes.push(t('combat.board.coverNote', { bonus: focusCheck.cover }));
            if (focusCheck.disadvantage) notes.push(t('combat.board.adjacentNote'));
            status = notes.join(' · ');
        }
    } else if (focusToken) status = describeToken(focusToken);
    else if (picking) status = t('combat.panel.pickTarget');
    else if (focus && path && turn) {
        const here = tileAt(grid, focus.pos);
        status = t('combat.board.moveTo', { cost: path.cost, left: turn.moveLeft });
        if (here !== 'floor') status = `${names[here]} · ${status}`;
    }
    else if (focus) {
        const tileName = names[tileAt(grid, focus.pos)];
        status = `${tileName}. ${t('combat.board.cannotReach')}`;
    } else if (turn) status = t('combat.board.yourMove', { count: turn.moveLeft });

    const cursorLabel = cursor
        ? `${t('combat.board.cursor', { x: cursor.x + 1, y: cursor.y + 1, tile: names[tileAt(grid, cursor)] })}${tokenAt(state, cursor) ? `. ${describeToken(tokenAt(state, cursor) as Combatant)}` : ''}`
        : undefined;

    const cycleTargets = (dir: 1 | -1): boolean => {
        if (aim) {
            const list = aim.legalList;
            if (list.length === 0) return false;
            const at = cursor ? list.findIndex(p => p.x === cursor.x && p.y === cursor.y) : -1;
            const next = list[(at + dir + list.length) % list.length];
            setCursor({ ...next });
            setHover(null);
            return true;
        }
        const pool = attackable.length > 0 ? attackable : targets;
        if (pool.length === 0) return false;
        const current = pool.findIndex(c => c.id === (focusToken?.id ?? targetId));
        const next = pool[(current + dir + pool.length) % pool.length];
        if (!next.position) return false;
        setCursor({ ...next.position });
        setHover(null);
        onTarget(next.id);
        return true;
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const arrows: Record<string, CombatPos> = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 } };
        const d = arrows[e.key];
        if (d) {
            e.preventDefault();
            e.stopPropagation();
            setEscaped(false);
            setHover(null);
            const base = cursor ?? viewer?.position ?? { x: 0, y: 0 };
            const next = { x: base.x + d.x, y: base.y + d.y };
            setCursor(inBounds(grid, next) ? next : base);
            return;
        }
        if (e.key === 'Enter') {
            const at = cursor ?? (targetId ? state.combatants[targetId]?.position : undefined);
            if (!at) return;
            e.preventDefault();
            e.stopPropagation();
            act(at);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (aim) {
                aim.cancel();
                return;
            }
            setCursor(null);
            setHover(null);
            setEscaped(true);
            onTarget(null);
            onPickEnd?.();
            return;
        }
        if (e.key === 'Tab') {
            if (escaped) return;
            if (cycleTargets(e.shiftKey ? -1 : 1)) {
                e.preventDefault();
                e.stopPropagation();
            }
        }
    };

    const w = grid.width * TILE_SIZE;
    const h = grid.height * TILE_SIZE;
    const losTarget = focusToken && focusToken.id !== player?.id && player?.position && focusToken.position && focusCheck ? focusToken : null;
    const selected = targetId ? state.combatants[targetId] : undefined;
    const selectedPos = selected ? shown[selected.id] ?? selected.position : undefined;

    return (
        <div id="combat-board" data-testid="combat-board" className="h-full min-h-0 flex flex-col" style={{ background: 'var(--combat-board-bg)' }}>
            <div className="relative flex-1 min-h-0">
                <div
                    ref={surface}
                    role="application"
                    aria-label={t('combat.board.label')}
                    aria-describedby="combat-board-help"
                    tabIndex={0}
                    data-testid="combat-board-surface"
                    data-picking={picking ? 'true' : undefined}
                    onKeyDown={onKeyDown}
                    onMouseLeave={() => setHover(null)}
                    onBlur={() => setEscaped(false)}
                    className="absolute inset-0 p-2 outline-none focus-visible:ring-1 focus-visible:ring-terminal"
                >
                    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
                        <HatchPattern id={patternId} />
                        {tileLayer}
                        <BarrierLayer barriers={state.barriers} />
                        <g data-testid="combat-overlay" style={{ pointerEvents: 'none' }}>
                            {aim && <AimOverlay aim={aim} preview={aimPreview} focus={focus?.pos ?? null} state={state} />}
                            {[...reach.keys()].map(k => {
                                const [x, y] = k.split(',').map(Number);
                                return art
                                    ? <rect key={`r${k}`} data-testid="combat-reachable" data-x={x} data-y={y} x={x * TILE_SIZE + 0.3} y={y * TILE_SIZE + 0.3} width={TILE_SIZE - 0.6} height={TILE_SIZE - 0.6} style={{ fill: 'var(--combat-reach)', stroke: 'var(--combat-path)', strokeWidth: 0.35, strokeOpacity: 0.7 }} />
                                    : <rect key={`r${k}`} data-testid="combat-reachable" data-x={x} data-y={y} x={x * TILE_SIZE} y={y * TILE_SIZE} width={TILE_SIZE} height={TILE_SIZE} style={{ fill: 'var(--combat-reach)' }} />;
                            })}
                            {attackable.map(c => c.position && (
                                <rect
                                    key={`t${c.id}`}
                                    data-testid="combat-target-mark"
                                    x={c.position.x * TILE_SIZE}
                                    y={c.position.y * TILE_SIZE}
                                    width={TILE_SIZE}
                                    height={TILE_SIZE}
                                    style={{ fill: 'var(--combat-target)', stroke: picking || art ? 'var(--combat-enemy)' : 'none', strokeWidth: picking ? 0.8 : 0.5 }}
                                />
                            ))}
                            {art && path && player?.position && (
                                <polyline
                                    points={[player.position, ...path.path].map(p => { const c = center(p); return `${c.x},${c.y}`; }).join(' ')}
                                    style={{ fill: 'none', stroke: 'var(--combat-board-bg)', strokeWidth: 1.8, strokeOpacity: 0.75, strokeLinecap: 'round', strokeLinejoin: 'round' }}
                                />
                            )}
                            {!aim && path && player?.position && (
                                <polyline
                                    data-testid="combat-path"
                                    points={[player.position, ...path.path].map(p => { const c = center(p); return `${c.x},${c.y}`; }).join(' ')}
                                    style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 1, strokeDasharray: '2 1.5', strokeLinecap: 'round' }}
                                />
                            )}
                            {path && focus && (
                                <text x={center(focus.pos).x} y={center(focus.pos).y + 1.4} textAnchor="middle" style={{ fontSize: 4, fontWeight: 700, fill: 'var(--combat-path)' }}>{path.cost}</text>
                            )}
                            {!aim && losTarget && player?.position && losTarget.position && (
                                <line
                                    data-testid="combat-los"
                                    data-clear={focusCheck?.ok ? 'true' : 'false'}
                                    x1={center(player.position).x}
                                    y1={center(player.position).y}
                                    x2={center(losTarget.position).x}
                                    y2={center(losTarget.position).y}
                                    style={{ stroke: focusCheck?.ok ? 'var(--combat-los-clear)' : 'var(--combat-los-blocked)', strokeWidth: 0.8, strokeDasharray: focusCheck?.ok ? undefined : '1.5 1' }}
                                />
                            )}
                        </g>
                        <g data-testid="combat-tokens">
                            {state.order.map(id => {
                                const c = state.combatants[id];
                                const pos = shown[id] ?? c?.position;
                                if (!c || !pos || c.status === 'gone') return null;
                                const { x, y } = center(pos);
                                const r = TILE_SIZE * 0.36;
                                const ring = 2 * Math.PI * (r + 0.9);
                                const frac = c.status === 'up' ? Math.max(0, Math.min(1, c.hp / Math.max(1, c.maxHp))) : 0;
                                const isSelected = targetId === id;
                                const outline = c.side === 'ally' ? '1 0.8' : c.side === 'neutral' ? '0.3 0.7' : undefined;
                                return (
                                    <g
                                        key={id}
                                        data-testid={`token-${id}`}
                                        role="img"
                                        aria-label={describeToken(c)}
                                        opacity={c.status === 'up' ? 1 : 0.35}
                                        onClick={() => onTile(c.position ?? pos)}
                                        onMouseEnter={() => setHover(c.position ?? pos)}
                                        data-summon={c.summonerId ? 'true' : undefined}
                                        style={{ cursor: aim || (interactive && attackable.some(a => a.id === id)) ? 'crosshair' : 'pointer' }}
                                    >
                                        <title>{describeToken(c)}</title>
                                        {actingId === id && <circle cx={x} cy={y} r={r + 2.2} style={{ fill: 'none', stroke: 'var(--combat-path)', strokeWidth: 0.9, opacity: 0.85 }} />}
                                        {isSelected && <circle data-testid="combat-selected" cx={x} cy={y} r={r + 2.2} style={{ fill: 'none', stroke: 'var(--combat-cursor)', strokeWidth: 0.5, strokeDasharray: '1 1' }} />}
                                        {art && <circle data-testid="combat-token-ring" cx={x} cy={y} r={r + 0.9} style={{ fill: 'none', stroke: 'var(--combat-board-bg)', strokeWidth: 2.1, opacity: 0.9 }} />}
                                        <circle cx={x} cy={y} r={r + 0.9} style={{ fill: 'none', stroke: 'var(--combat-hp-track)', strokeWidth: 0.9 }} />
                                        <circle
                                            cx={x}
                                            cy={y}
                                            r={r + 0.9}
                                            transform={`rotate(-90 ${x} ${y})`}
                                            style={{ fill: 'none', stroke: hpColor(c), strokeWidth: 0.9, strokeDasharray: `${ring * frac} ${ring}` }}
                                        />
                                        <TempHpRing c={c} x={x} y={y} r={r} />
                                        {c.summonerId && <circle data-testid="combat-summon-ring" cx={x} cy={y} r={r - 0.9} style={{ fill: 'none', stroke: 'var(--combat-token-text)', strokeWidth: 0.4, strokeDasharray: '0.8 0.6', pointerEvents: 'none' }} />}
                                        <circle
                                            cx={x}
                                            cy={y}
                                            r={r}
                                            style={{ fill: sideColor(c.side), stroke: outline ? 'var(--combat-token-text)' : 'none', strokeWidth: 0.5, strokeDasharray: outline }}
                                        />
                                        <text x={x} y={y + 1.3} textAnchor="middle" style={{ fontSize: 3.6, fontWeight: 700, fill: 'var(--combat-token-text)', pointerEvents: 'none' }}>
                                            {c.name.trim().charAt(0).toUpperCase() || '?'}
                                        </text>
                                        <ConditionBadges c={c} x={x} y={y} r={r} />
                                        {isParty(c) && c.status === 'up' && (
                                            <text x={x} y={y + r + 3.4} textAnchor="middle" style={{ fontSize: 2.3, fill: 'var(--combat-party)', pointerEvents: 'none' }}>
                                                {c.hp}/{c.maxHp}
                                            </text>
                                        )}
                                    </g>
                                );
                            })}
                        </g>
                        {cursor && (
                            <rect
                                data-testid="combat-cursor"
                                role="img"
                                aria-label={cursorLabel}
                                x={cursor.x * TILE_SIZE + 0.4}
                                y={cursor.y * TILE_SIZE + 0.4}
                                width={TILE_SIZE - 0.8}
                                height={TILE_SIZE - 0.8}
                                style={{ fill: 'none', stroke: 'var(--combat-cursor)', strokeWidth: 0.8, pointerEvents: 'none' }}
                            />
                        )}
                        {focusKey && !cursor && hover && (
                            <rect x={hover.x * TILE_SIZE + 0.4} y={hover.y * TILE_SIZE + 0.4} width={TILE_SIZE - 0.8} height={TILE_SIZE - 0.8} style={{ fill: 'none', stroke: 'var(--combat-cursor)', strokeWidth: 0.4, opacity: 0.6, pointerEvents: 'none' }} />
                        )}
                    </svg>
                </div>
                {selected && selectedPos && (
                    <InspectCard
                        combatant={selected}
                        viewer={viewer}
                        session={session}
                        corner={inspectCorner(selectedPos, grid.width, grid.height)}
                        onClose={() => onTarget(null)}
                    />
                )}
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-1 text-[11px] font-mono flex-wrap">
                <span data-testid="combat-board-status" aria-live="polite" className="text-text-primary truncate min-w-0 flex-1">{status}</span>
                <BoardLegend grid={grid} tileArt={tileArtToggle} />
            </div>
        </div>
    );
}
