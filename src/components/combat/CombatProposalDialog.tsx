import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Swords, X, Plus, Shuffle, Minus } from 'lucide-react';
import { AREA_TYPES, MAP_DENSITIES, buildMapFromSeed, normalizeMapSize, placeCombatants, resolveMapSpec } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { useAppStore } from '../../store/useAppStore';
import { COMBAT_TIERS, PROPOSED_COMBATANT_SIDES, MAX_PROPOSED_COMBATANTS } from '../../types';
import type { CombatAreaType, CombatMapDensity, CombatProposal, CombatResolvedMap, ProposedCombatant } from '../../types';
import { combatMapTexts, resolveCombatMap } from '../../services/combat/combatMap';
import { dedupeCombatantNames, hasEnemy } from '../../services/combat/combatProposal';
import { newMapSeed } from '../../services/combat/combatController';
import { compendiumFor } from '../../services/combat/compendiumLookup';
import type { CompendiumSource } from '../../services/combat/compendiumLookup';
import { Backdrop } from '../primitives/Backdrop';
import { HatchPattern, TerrainKeyItems, TileLayer } from './CombatBoard';
import { useTerrainNames } from './useTerrainNames';
import { TILE_SIZE, sideColor, tileCenter } from './combatVisuals';
import { initialTileArt } from './tileAvailability';
import { useTileArt } from './useTileArt';

const selectClass = 'bg-void border border-border px-1.5 py-0.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none';

const MAP_SIZE_OPTIONS = ['small', 'medium', 'large'] as const;

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

const GHOST_CLICK_MS = 350;

function MapPreview({ map, mapSeed, roster }: { map: CombatResolvedMap; mapSeed: number; roster: ProposedCombatant[] }) {
    const { t } = useTranslation();
    const patternId = `combat-preview-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const grid = useMemo(() => buildMapFromSeed(map, mapSeed), [map, mapSeed]);
    const names = useTerrainNames(grid);
    const [tileArtOn] = useState<boolean>(() => initialTileArt());
    const artReady = useTileArt(grid, map.place, mapSeed);
    const art = tileArtOn ? artReady : null;
    const spawns = useMemo(
        () => placeCombatants(grid, [{ id: 'pc', side: 'player' as const }, ...roster.map((c, i) => ({ id: `c${i}`, side: c.side }))]),
        [grid, roster],
    );
    const sides = new Map<string, ProposedCombatant['side'] | 'player'>([['pc', 'player'], ...roster.map((c, i) => [`c${i}`, c.side] as const)]);
    return (
        <>
        <svg
            data-testid="combat-map-preview"
            data-tiles={grid.tiles.join(',')}
            role="img"
            aria-label={t('combat.proposal.mapPreview')}
            viewBox={`0 0 ${grid.width * TILE_SIZE} ${grid.height * TILE_SIZE}`}
            className="w-full h-auto border border-border"
            style={{ background: 'var(--combat-board-bg)' }}
        >
            <HatchPattern id={patternId} />
            <TileLayer grid={grid} patternId={patternId} names={names} art={art} />
            {Object.entries(spawns).map(([id, p]) => {
                const c = tileCenter(p);
                return art
                    ? <circle key={id} cx={c.x} cy={c.y} r={TILE_SIZE * 0.3} style={{ fill: sideColor(sides.get(id) ?? 'enemy'), stroke: 'var(--combat-board-bg)', strokeWidth: 0.8 }} />
                    : <circle key={id} cx={c.x} cy={c.y} r={TILE_SIZE * 0.3} style={{ fill: sideColor(sides.get(id) ?? 'enemy') }} />;
            })}
        </svg>
        <ul data-testid="combat-preview-key" data-area={grid.area} className="flex items-center gap-3 flex-wrap text-[10px] font-mono">
            <TerrainKeyItems grid={grid} />
        </ul>
        </>
    );
}

export function CombatProposalDialog({
    proposal,
    open,
    loading = false,
    onStart,
    onDecline,
    onMinimise,
    onClosed,
}: {
    proposal: CombatProposal;
    open: boolean;
    loading?: boolean;
    onStart: (proposal: CombatProposal) => void;
    onDecline: () => void;
    onMinimise: () => void;
    onClosed?: () => void;
}) {
    const { t } = useTranslation();
    const headingId = useId();
    const modTables = useAppStore(s => s.modTables);
    const moduleEnabled = useAppStore(s => s.settings?.moduleEnabled);
    const [roster, setRoster] = useState<ProposedCombatant[]>(proposal.combatants);
    const [draftName, setDraftName] = useState('');
    const [mapSeed, setMapSeed] = useState<number>(() => proposal.mapSeed ?? newMapSeed());
    const [initial] = useState(() => {
        const live = useAppStore.getState();
        return { resolved: resolveCombatMap(proposal, live), texts: combatMapTexts(proposal, live), count: proposal.combatants.length };
    });
    const [size, setSize] = useState(initial.resolved.size);
    const [area, setArea] = useState<CombatAreaType>(initial.resolved.area);
    const [density, setDensity] = useState<CombatMapDensity>(initial.resolved.density);
    const map = useMemo<CombatResolvedMap>(
        () => resolveMapSpec({ ...(proposal.map ?? {}), area, density, size }, { combatants: initial.count, texts: initial.texts }),
        [proposal.map, area, density, size, initial],
    );
    const canStart = !loading && hasEnemy(roster);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const startRef = useRef<HTMLButtonElement | null>(null);
    const openedAt = useRef(0);
    const closedRef = useRef(onClosed);
    useEffect(() => { closedRef.current = onClosed; });

    useEffect(() => {
        if (!open) return;
        openedAt.current = Date.now();
        const target = startRef.current && !startRef.current.disabled ? startRef.current : panelRef.current;
        target?.focus();
        return () => { closedRef.current?.(); };
    }, [open]);

    const sources = useMemo(
        () => roster.map(c => compendiumFor(c, { modTables, settings: { moduleEnabled } }).source),
        [roster, modTables, moduleEnabled],
    );

    if (!open) return null;

    const sourceLabel = (source: CompendiumSource): string => {
        if (source.kind === 'tier') return t('combat.proposal.sourceTier');
        const fields = source.fields.map(f => t(`combat.field.${f}`)).join(', ');
        return t('combat.proposal.sourceCompendium', { fields });
    };

    const update = (index: number, patch: Partial<ProposedCombatant>) => {
        setRoster(list => list.map((c, i) => i === index ? { ...c, ...patch } : c));
    };

    const add = () => {
        const name = draftName.trim();
        if (!name || roster.length >= MAX_PROPOSED_COMBATANTS) return;
        setRoster(list => [...list, { name, side: 'enemy', tier: 'grunt' }]);
        setDraftName('');
    };

    const start = () => {
        if (!canStart) return;
        const names = dedupeCombatantNames(roster.map(c => c.name));
        onStart({ ...proposal, combatants: roster.map((c, i) => ({ ...c, name: names[i] })), map, mapSeed });
    };

    const onBackdrop = () => {
        if (Date.now() - openedAt.current < GHOST_CLICK_MS) return;
        onMinimise();
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onMinimise();
            return;
        }
        if (e.key !== 'Tab') return;
        const panel = panelRef.current;
        if (!panel) return;
        const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el !== panel);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === panel)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    };

    const title = t(proposal.source === 'manual' ? 'combat.proposal.manualTitle' : 'combat.proposal.title');

    return (
        <Backdrop onClick={onBackdrop}>
            <div
                ref={panelRef}
                data-testid="combat-proposal-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={headingId}
                tabIndex={-1}
                onKeyDown={onKeyDown}
                onClick={e => e.stopPropagation()}
                className="bg-surface border border-border rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col outline-none"
            >
                <div className="flex items-start gap-3 p-4 border-b border-border">
                    <Swords size={16} className="shrink-0 mt-0.5" style={{ color: 'var(--combat-enemy)' }} />
                    <div className="flex-1 min-w-0">
                        <div className="text-[10px] font-mono uppercase tracking-wider text-text-dim">{title}</div>
                        <h2 id={headingId} className="text-sm text-text-primary font-bold">{proposal.reason || title}</h2>
                    </div>
                    <button type="button" onClick={onMinimise} aria-label={t('combat.proposal.minimise')} title={t('combat.proposal.minimise')} className="text-text-dim hover:text-text-primary p-1">
                        <Minus size={16} />
                    </button>
                </div>
                <div className="p-4 overflow-y-auto grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
                    <div className="space-y-2 min-w-0">
                        <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-text-dim flex-wrap">
                            <span>{t('combat.proposal.map')}</span>
                            <select
                                aria-label={t('combat.proposal.size')}
                                className={selectClass}
                                value={size}
                                onChange={(e) => setSize(normalizeMapSize(e.target.value))}
                            >
                                {MAP_SIZE_OPTIONS.map(s => <option key={s} value={s}>{t(`combat.proposal.size.${s}`)}</option>)}
                            </select>
                            <select
                                aria-label={t('combat.proposal.area')}
                                className={selectClass}
                                value={area}
                                onChange={(e) => setArea(e.target.value as CombatAreaType)}
                            >
                                {AREA_TYPES.map(a => <option key={a} value={a}>{t(`combat.area.${a}`)}</option>)}
                            </select>
                            <select
                                aria-label={t('combat.proposal.density')}
                                className={selectClass}
                                value={density}
                                onChange={(e) => setDensity(e.target.value as CombatMapDensity)}
                            >
                                {MAP_DENSITIES.map(d => <option key={d} value={d}>{t(`combat.density.${d}`)}</option>)}
                            </select>
                            <button
                                type="button"
                                onClick={() => setMapSeed(newMapSeed())}
                                className="flex items-center gap-1 border border-border px-1.5 py-0.5 rounded-sm hover:text-text-primary normal-case"
                            >
                                <Shuffle size={11} /> {t('combat.proposal.newLayout')}
                            </button>
                        </div>
                        <MapPreview map={map} mapSeed={mapSeed} roster={roster} />
                    </div>
                    <div className="space-y-2 min-w-0">
                        {loading && <p className="text-[11px] text-text-dim">{t('combat.proposal.loading')}</p>}
                        {!loading && roster.length === 0 && <p className="text-[11px] text-text-dim">{t('combat.proposal.empty')}</p>}
                        <ul className="space-y-1.5">
                            {roster.map((c, i) => (
                                <li key={`${c.name}-${i}`} className="text-[12px] font-mono">
                                    <div className="flex items-center gap-2">
                                        <span className="flex-1 truncate text-text-primary">{c.name}</span>
                                        <select
                                            aria-label={t('combat.proposal.side', { name: c.name })}
                                            className={selectClass}
                                            value={c.side}
                                            onChange={(e) => update(i, { side: e.target.value as ProposedCombatant['side'] })}
                                        >
                                            {PROPOSED_COMBATANT_SIDES.map(side => <option key={side} value={side}>{t(`combat.side.${side}`)}</option>)}
                                        </select>
                                        <select
                                            aria-label={t('combat.proposal.tier', { name: c.name })}
                                            className={selectClass}
                                            value={c.tier}
                                            onChange={(e) => update(i, { tier: e.target.value as ProposedCombatant['tier'] })}
                                        >
                                            {COMBAT_TIERS.map(tier => <option key={tier} value={tier}>{t(`combat.tier.${tier}`)}</option>)}
                                        </select>
                                        <button
                                            type="button"
                                            aria-label={t('combat.proposal.remove', { name: c.name })}
                                            title={t('combat.proposal.remove', { name: c.name })}
                                            onClick={() => setRoster(list => list.filter((_, j) => j !== i))}
                                            className="text-text-dim hover:text-text-primary p-0.5"
                                        >
                                            <X size={12} />
                                        </button>
                                    </div>
                                    <div data-testid={`combat-source-${i}`} className="text-[10px] text-text-dim">{sourceLabel(sources[i])}</div>
                                </li>
                            ))}
                        </ul>
                        <div className="flex items-center gap-2">
                            <input
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                                placeholder={t('combat.proposal.namePlaceholder')}
                                className="flex-1 min-w-0 bg-void border border-border px-2 py-1 text-[12px] font-mono text-text-primary focus:border-terminal outline-none"
                            />
                            <button type="button" onClick={add} className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-dim hover:text-text-primary border border-border px-2 py-1 rounded-sm">
                                <Plus size={12} /> {t('combat.proposal.add')}
                            </button>
                        </div>
                        {!loading && !hasEnemy(roster) && <p className="text-[11px]" style={{ color: 'var(--combat-hp-warn)' }}>{t('combat.proposal.needEnemy')}</p>}
                    </div>
                </div>
                <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onDecline}
                        className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary rounded"
                    >
                        {t('combat.proposal.notNow')}
                    </button>
                    <button
                        ref={startRef}
                        type="button"
                        onClick={start}
                        disabled={!canStart}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{ background: 'var(--combat-target)', color: 'var(--combat-enemy)' }}
                    >
                        <Swords size={12} /> {t('combat.proposal.start')}
                    </button>
                </div>
            </div>
        </Backdrop>
    );
}
