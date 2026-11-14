import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, X } from 'lucide-react';
import {
    autoPlacementReason, chainColumns, chainCount, firstFreeSocket, placeGlyph, placementReason, removeGlyph, sameSocket, socketGlyph,
    socketKey, validateAbility,
} from '@narrative/engine';
import type { GlyphRef, Socket } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { commitCombatPatch, remirrorCombatSheet } from '../../services/combat/combatSheet';
import {
    addAsNew, configOf, equipAt, limitsOf, removeAbility, reorderEquipped, sheetCasterStats, sheetMaxMp, spellbookOf, toggleEquipped, unequip,
    upsertAbility,
} from '../../services/combat/spellbook';
import type { GlyphAbility, Spellbook } from '../../types';
import { Backdrop } from '../primitives/Backdrop';
import { glyphLabelKey } from '../character/tabs/glyphLabels';
import { useContainerWidth } from '../combat/useContainerWidth';
import { AbilityLibrary } from './AbilityLibrary';
import { ChainWorkbench } from './ChainWorkbench';
import { GlyphPalette } from './GlyphPalette';
import { blankDraft, draftFrom, sameDraft, toAbility } from './draft';
import type { AbilityDraft } from './draft';
import { useReasonText } from './useReasonText';

const FOCUSABLE = 'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const NARROW_BELOW = 900;

const LAYER = 110;

const footerButton = 'px-4 py-2 text-xs rounded outline-none focus-visible:ring-2 focus-visible:ring-terminal disabled:opacity-40 disabled:cursor-not-allowed';

function initialState(): { draft: AbilityDraft; baseline: AbilityDraft; selectedId: string | null } {
    const store = useAppStore.getState();
    if (store.abilityEditDraft) {
        return { draft: { ...draftFrom(store.abilityEditDraft), id: '', source: 'ai' }, baseline: blankDraft(), selectedId: null };
    }
    const first = spellbookOf(store.context).abilities[0];
    if (first) return { draft: draftFrom(first), baseline: draftFrom(first), selectedId: first.id };
    return { draft: blankDraft(), baseline: blankDraft(), selectedId: null };
}

function Workbench() {
    const { t } = useTranslation();
    const reasonText = useReasonText();
    const headingId = useId();
    const promptId = useId();
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const setEditDraft = useAppStore((s) => s.setAbilityEditDraft);
    const setOpen = useAppStore((s) => s.setSpellbookOpen);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const keepRef = useRef<HTMLButtonElement | null>(null);
    const width = useContainerWidth(panelRef);
    const narrow = width !== null && width < NARROW_BELOW;

    const book = useMemo(() => spellbookOf(context), [context]);
    const config = useMemo(() => configOf(context), [context]);
    const limits = useMemo(() => limitsOf(config), [config]);
    const stats = useMemo(() => sheetCasterStats(context.combatSheet), [context.combatSheet]);
    const maxMp = sheetMaxMp(context.combatSheet);
    const label = config.resourceLabel;

    const [start] = useState(initialState);
    const [draft, setDraft] = useState<AbilityDraft>(start.draft);
    const [baseline, setBaseline] = useState<AbilityDraft>(start.baseline);
    const [selectedId, setSelectedId] = useState<string | null>(start.selectedId);
    const [socket, setSocket] = useState<Socket | null>(null);
    const [status, setStatus] = useState('');
    const [pending, setPending] = useState<{ run: () => void } | null>(null);

    const dirty = !sameDraft(draft, baseline);
    const reasons = useMemo(() => validateAbility(toAbility(draft), limits), [draft, limits]);
    const canSave = dirty && reasons.length === 0;

    useEffect(() => {
        const store = useAppStore.getState();
        commitCombatPatch(store, remirrorCombatSheet(store.context));
        const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        panelRef.current?.focus();
        return () => { previous?.focus(); };
    }, []);

    useEffect(() => {
        if (pending) keepRef.current?.focus();
    }, [pending]);

    const latest = (): Spellbook => spellbookOf(useAppStore.getState().context);
    const commit = (next: Spellbook) => updateContext({ spellbook: next });

    const load = (ability: GlyphAbility | null) => {
        const next = ability ? draftFrom(ability) : blankDraft();
        setDraft(next);
        setBaseline(next);
        setSelectedId(ability?.id ?? null);
        setSocket(null);
        setStatus('');
    };

    const guard = (run: () => void) => {
        if (dirty) setPending({ run });
        else run();
    };

    const closeNow = () => {
        setEditDraft(null);
        setOpen(false);
    };

    const save = () => {
        if (!canSave) return;
        const ability = toAbility(draft);
        const fresh = latest();
        const exists = !!draft.id && fresh.abilities.some(a => a.id === draft.id);
        const next = exists ? upsertAbility(fresh, { ...ability, id: draft.id }) : addAsNew(fresh, ability, draft.source === 'ai' ? 'ai' : 'player');
        commit(next);
        setEditDraft(null);
        const saved = exists ? next.abilities.find(a => a.id === draft.id) : next.abilities[next.abilities.length - 1];
        load(saved ?? null);
        setStatus(t('spellbook.status.saved', { name: saved?.name ?? '' }));
    };

    const patchChain = (chain: AbilityDraft['chain']) => setDraft(d => ({ ...d, chain }));

    const place = (target: Socket, glyph: GlyphRef) => {
        const reason = placementReason(draft.chain, target, glyph, limits);
        if (reason) {
            setStatus(reasonText(reason));
            return;
        }
        const replaced = socketGlyph(draft.chain, target);
        const next = placeGlyph(draft.chain, target, glyph);
        patchChain(next);
        setSocket(null);
        const dropped = replaced ? chainCount(draft.chain) - chainCount(next) : 0;
        const name = t(glyphLabelKey(glyph));
        setStatus(dropped > 0 ? t('spellbook.status.dropped', { name, count: dropped }) : t('spellbook.status.placed', { name }));
    };

    const onPlace = (glyph: GlyphRef) => {
        if (socket) {
            place(socket, glyph);
            return;
        }
        const free = firstFreeSocket(draft.chain, glyph, limits);
        if (!free) {
            const reason = autoPlacementReason(draft.chain, glyph, limits);
            setStatus(reason ? reasonText(reason) : '');
            return;
        }
        place(free, glyph);
    };

    const removeAt = (target: Socket) => {
        const glyph = socketGlyph(draft.chain, target);
        if (!glyph) return;
        patchChain(removeGlyph(draft.chain, target));
        if (sameSocket(socket, target)) setSocket(null);
        setStatus(t('spellbook.status.removed', { name: t(glyphLabelKey(glyph)) }));
    };

    const removeByKey = (key: string) => {
        const target = chainColumns(draft.chain).flatMap(c => [c.owner, ...c.augments.map(a => a.socket)]).find(s => socketKey(s) === key);
        if (target) removeAt(target);
    };

    const reasonFor = (glyph: GlyphRef) => (socket ? placementReason(draft.chain, socket, glyph, limits) : autoPlacementReason(draft.chain, glyph, limits));

    const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            if (pending) setPending(null);
            else if (socket) setSocket(null);
            else guard(closeNow);
            return;
        }
        if (e.key !== 'Tab') return;
        e.stopPropagation();
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

    const library = (
        <AbilityLibrary
            book={book}
            config={config}
            stats={stats}
            label={label}
            selectedId={selectedId}
            onSelect={(id) => {
                if (id === selectedId) return;
                guard(() => load(latest().abilities.find(a => a.id === id) ?? null));
            }}
            onNew={() => guard(() => load(null))}
            onAddPreset={(preset) => commit(addAsNew(latest(), preset, 'preset'))}
            onToggleEquip={(id) => commit(toggleEquipped(latest(), id, config))}
            onEquipAt={(id, slot) => commit(equipAt(latest(), id, slot, config))}
            onReorder={(from, to) => commit(reorderEquipped(latest(), from, to))}
            onUnequip={(id) => commit(unequip(latest(), id))}
            onDelete={(id) => {
                commit(removeAbility(latest(), id));
                if (id === selectedId) load(null);
            }}
        />
    );
    const chain = (
        <ChainWorkbench
            draft={draft}
            onChange={(patch) => setDraft(d => ({ ...d, ...patch }))}
            selected={socket}
            onSelect={(s) => setSocket(current => (sameSocket(current, s) ? null : s))}
            onRemove={removeAt}
            onDropGlyph={place}
            status={status}
            stats={stats}
            limits={limits}
            maxMp={maxMp}
            label={label}
        />
    );
    const palette = <GlyphPalette stats={stats} label={label} reasonFor={reasonFor} onPlace={onPlace} onRemoveSocket={removeByKey} />;
    const panels = narrow ? [chain, palette, library] : [library, chain, palette];
    const panelClass = narrow ? 'p-4 border-b border-border' : 'p-4 min-h-0 overflow-y-auto';

    return createPortal(
        <Backdrop layer={LAYER} onClick={() => guard(closeNow)}>
            <div
                ref={panelRef}
                data-testid="spellbook-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={headingId}
                tabIndex={-1}
                onKeyDown={onKeyDown}
                onClick={(e) => e.stopPropagation()}
                className="bg-surface border border-border rounded-lg w-full max-w-7xl h-[90vh] flex flex-col outline-none"
            >
                <div className="flex items-start gap-3 p-4 border-b border-border">
                    <BookOpen size={18} aria-hidden="true" className="shrink-0 mt-0.5 text-terminal" />
                    <div className="flex-1 min-w-0">
                        <h2 id={headingId} className="text-sm font-bold text-text-primary">{t('combat.spellbook.tab')}</h2>
                        <p className="text-xs text-text-dim leading-relaxed">{t('combat.spellbook.help')}</p>
                    </div>
                    <span data-testid="spellbook-dialog-mp" className="text-xs font-mono text-terminal whitespace-nowrap mt-1">{t('combat.spellbook.mp', { label, max: maxMp })}</span>
                    <button
                        type="button"
                        onClick={() => guard(closeNow)}
                        aria-label={t('spellbook.close')}
                        title={t('spellbook.close')}
                        className="p-1 rounded text-text-dim hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-terminal"
                    >
                        <X size={18} aria-hidden="true" />
                    </button>
                </div>
                {pending && (
                    <div role="alertdialog" aria-labelledby={promptId} data-testid="spellbook-unsaved" className="mx-4 mt-3 rounded-lg border border-terminal/50 bg-terminal/10 p-3 flex flex-wrap items-center gap-3">
                        <p id={promptId} className="text-sm text-text-primary flex-1 min-w-[12rem]">{t('spellbook.unsaved', { name: draft.name || t('spellbook.untitled') })}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                            <button
                                type="button"
                                disabled={!canSave}
                                onClick={() => { const next = pending; save(); setPending(null); next.run(); }}
                                className={`${footerButton} border border-terminal/60 text-terminal hover:bg-terminal/10`}
                            >
                                {t('spellbook.unsaved.save')}
                            </button>
                            <button
                                type="button"
                                onClick={() => { const next = pending; setPending(null); next.run(); }}
                                className={`${footerButton} border border-danger/60 text-danger hover:bg-danger/10`}
                            >
                                {t('spellbook.unsaved.discard')}
                            </button>
                            <button ref={keepRef} type="button" onClick={() => setPending(null)} className={`${footerButton} border border-border text-text-primary hover:bg-void-lighter`}>
                                {t('spellbook.unsaved.keep')}
                            </button>
                        </div>
                    </div>
                )}
                <div
                    data-testid="spellbook-body"
                    data-layout={narrow ? 'stacked' : 'columns'}
                    className={narrow
                        ? 'flex-1 min-h-0 overflow-y-auto flex flex-col'
                        : 'flex-1 min-h-0 grid grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)_minmax(16rem,22rem)] divide-x divide-border'}
                >
                    {panels.map((panel, i) => <div key={i} className={panelClass}>{panel}</div>)}
                </div>
                <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-3">
                    <span className="mr-auto text-xs text-text-dim" data-testid="spellbook-dirty">{dirty ? t('spellbook.dirty') : ''}</span>
                    <button type="button" disabled={!dirty} onClick={() => { setDraft(baseline); setSocket(null); setStatus(''); }} className={`${footerButton} text-text-dim hover:text-text-primary`}>
                        {t('combat.builder.cancel')}
                    </button>
                    <button type="button" disabled={!canSave} onClick={save} className={`${footerButton} font-semibold border border-terminal/60 text-terminal hover:bg-terminal/10`}>
                        {t('combat.builder.save')}
                    </button>
                </div>
            </div>
        </Backdrop>,
        document.body,
    );
}

export function SpellbookDialog() {
    const open = useAppStore((s) => s.spellbookOpen);
    const combatOn = useAppStore((s) => s.context.combatModeActive === true);
    if (!open || !combatOn) return null;
    return <Workbench />;
}
