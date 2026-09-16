import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { X, Plus, Users, LayoutGrid, List, CheckSquare, Upload, Download, BookOpen, Trash2, Search, ArrowDownAZ, ArrowUpZA, Sparkles, Images } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { updateExistingNPCs } from '../services/chatEngine';
import { parseNPCsFromLore } from '../services/lore/loreNPCParser';
import type { NPCEntry, NPCVisualProfile } from '../types';
import { DEFAULT_VISUAL_PROFILE } from '../types';
import { toast } from './Toast';
import { uid } from '../utils/uid';
import { prepareImportedNpcs, type NpcImportMode } from '../services/npc/importTransform';
import { filterNPCs, type SortOrder } from '../utils/ledgerFilters';
import { uploadImageToLocal } from '../services/infrastructure/assetService';
import { replaceCardLoreGroup } from '../services/import/importOverwrite';
import {
    applyOverwrite,
    planQuickAdd,
    routeQuickAddFile,
    summarizeQuickAdd,
    type QuickAddDecision,
    type QuickAddPlan,
    type QuickAddRouted,
} from '../services/import/ledgerQuickAdd';
import type { STCard } from '../services/import/stCardTypes';

import { NPCListView } from './npc-ledger/NPCListView';
import { NPCGalleryView } from './npc-ledger/NPCGalleryView';
import { NPCEditForm } from './npc-ledger/NPCEditForm';
import { NPCSuggestionsPanel } from './npc-ledger/NPCSuggestionsPanel';
import { NPCReviewModal } from './NPCReviewModal';
import { ImportChoiceDialog } from './npc-ledger/ImportChoiceDialog';
import { ImportOverwriteDialog } from './import/ImportOverwriteDialog';
import { AdaptChoiceDialog } from './import/AdaptChoiceDialog';
import { AdaptationPanel } from './import/AdaptationPanel';
import {
    applyAdaptedWants,
    describeAdaptationEndpoint,
    makeModelCaller,
    resolveAdaptationEndpoint,
    runAdaptation,
} from '../services/import/adaptation';
import type {
    AdaptationEndpointInfo,
    AdaptationProgress,
    AdaptationResult,
    AdaptationTarget,
} from '../services/import/adaptationTypes';
import { useNpcReview } from './hooks/useNpcReview';
import { useNpcPortraits } from './hooks/useNpcPortraits';

/** WO-C §9.3 — a row this drop ADDED, held until the quick-add has fully landed. */
type AdaptSeed = { id: string; name: string; card: STCard };
/** `idle` = no panel; anything else overlays the ledger with the AdaptationPanel. */
type AdaptPhase = 'idle' | 'running' | 'done';

/** The same sentence the wizard shows on a dead endpoint — one phrasing, two surfaces. */
const NO_ENDPOINT_COPY = 'no utility or story endpoint is configured';

/**
 * `File.arrayBuffer()` / `File.text()` exist in every browser this app ships to
 * but NOT in jsdom, where the whole quick-add path is tested. `FileReader` is
 * implemented in both — and it is what the rest of this file already uses.
 */
function readFile(file: File, as: 'buffer'): Promise<ArrayBuffer>;
function readFile(file: File, as: 'text'): Promise<string>;
function readFile(file: File, as: 'buffer' | 'text'): Promise<ArrayBuffer | string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer | string);
        reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
        if (as === 'buffer') reader.readAsArrayBuffer(file);
        else reader.readAsText(file);
    });
}

export function NPCLedgerModal() {
    const { npcLedger, npcLedgerOpen, toggleNPCLedger, addNPC, updateNPC, removeNPC, setNPCLedger, addNPCs, restoreNPC, npcSuggestions, setLoreChunks } = useAppStore();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [isEditing, setIsEditing] = useState(false);

    const [viewMode, setViewMode] = useState<'list' | 'gallery'>('list');
    const [isAIUpdating, setIsAIUpdating] = useState(false);

    const [selectMode, setSelectMode] = useState(false);
    const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState('');
    const [sortOrder, setSortOrder] = useState<SortOrder>('none');
    const importRef = useRef<HTMLInputElement>(null);
    // Parsed-but-not-yet-committed import, awaiting the user's mode choice.
    const [pendingImport, setPendingImport] = useState<Partial<NPCEntry>[] | null>(null);
    // WO-C §9.4 — card collisions from the current drop, resolved one dialog at a time.
    // `adaptSeeds` rides along because §9.3's offer comes only once the whole
    // quick-add has landed, which includes draining this queue.
    const [cardImport, setCardImport] = useState<{
        plan: QuickAddPlan;
        index: number;
        decisions: QuickAddDecision[];
        portraitFailures: string[];
        adaptSeeds: AdaptSeed[];
    } | null>(null);

    // ── WO-C §9.3 (order "C2") — the optional Living-world adaptation pass ────
    // Offered after the fact, and only for rows this drop ADDED: an overwritten
    // NPC keeps the campaign-owned motivations it already has (§9.4 — campaign
    // facts are authoritative, never retconned by a card).
    const [adaptOffer, setAdaptOffer] = useState<{ seeds: AdaptSeed[]; endpoint: AdaptationEndpointInfo | null } | null>(null);
    const [adaptPhase, setAdaptPhase] = useState<AdaptPhase>('idle');
    const [adaptProgress, setAdaptProgress] = useState<AdaptationProgress | null>(null);
    const [adaptResults, setAdaptResults] = useState<AdaptationResult[]>([]);
    const [adaptElapsed, setAdaptElapsed] = useState(0);
    const abortRef = useRef<AbortController | null>(null);
    const targetsRef = useRef<AdaptationTarget[]>([]);
    /** Results by npc id — the ref is the source of truth, the state is its view. */
    const collectedRef = useRef<Map<string, AdaptationResult>>(new Map());
    const importIdRef = useRef('');
    const adaptStartRef = useRef(0);

    const displayedNPCs = useMemo(() => filterNPCs(npcLedger, searchQuery, sortOrder), [npcLedger, searchQuery, sortOrder]);

    const review = useNpcReview();
    const portraits = useNpcPortraits();

    const [form, setForm] = useState<Partial<NPCEntry>>({
        status: 'Alive', voice: '', personality: '', exampleOutput: '',
        visualProfile: { ...DEFAULT_VISUAL_PROFILE }
    });

    /**
     * Closing the ledger mid-pass must not leave a run talking to a panel nobody
     * can see: abort it and tear the panel down. Nothing is lost — the NPCs were
     * written before the pass ever started (§9.3), and whatever adapted in time
     * is already on their rows.
     */
    const closeLedger = useCallback(() => {
        abortRef.current?.abort();
        abortRef.current = null;
        setAdaptOffer(null);
        setAdaptPhase('idle');
        setAdaptProgress(null);
        setAdaptResults([]);
        toggleNPCLedger();
    }, [toggleNPCLedger]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && npcLedgerOpen) closeLedger();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [npcLedgerOpen, closeLedger]);

    // Elapsed seconds while a pass is in flight. Mirrors the wizard's timer: the
    // interval owns the ticking, so nothing sets state in the effect body (the
    // repo lints with react-hooks recommended).
    useEffect(() => {
        if (adaptPhase !== 'running') return;
        const id = setInterval(() => {
            setAdaptElapsed(Math.floor((Date.now() - adaptStartRef.current) / 1000));
        }, 1000);
        return () => clearInterval(id);
    }, [adaptPhase]);

    if (!npcLedgerOpen) return null;

    // ── Handlers ─────────────────────────────────────────────────────────
    const handleSelect = (npc: NPCEntry) => {
        if (selectMode) return;
        setSelectedId(npc.id);
        setForm({ ...npc, visualProfile: npc.visualProfile || { ...DEFAULT_VISUAL_PROFILE } });
        setIsEditing(false);
    };

    const handleCreateNew = () => {
        setSelectedId(null);
        setForm({
            name: '', aliases: '', appearance: '', faction: '', storyRelevance: '', disposition: '',
            status: 'Alive', goals: '', voice: '', personality: '', exampleOutput: '',
            visualProfile: { ...DEFAULT_VISUAL_PROFILE }
        });
        setIsEditing(true);
        setSelectMode(false);
        setCheckedIds(new Set());
    };

    const handleSave = () => {
        if (!form.name?.trim()) return;
        if (selectedId) {
            updateNPC(selectedId, form);
        } else {
            addNPC({ ...form, id: uid() } as NPCEntry);
        }
        setIsEditing(false);
    };

    const handleDelete = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm('Delete this NPC from the ledger?')) {
            removeNPC(id);
            if (selectedId === id) { setSelectedId(null); setIsEditing(false); }
        }
    };

    const toggleCheck = (id: string) => {
        setCheckedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const allChecked = displayedNPCs.length > 0 && checkedIds.size === displayedNPCs.length;

    const handleSelectAll = () => {
        setCheckedIds(allChecked ? new Set() : new Set(displayedNPCs.map(n => n.id)));
    };

    const handleDeleteSelected = () => {
        if (checkedIds.size === 0) return;
        if (!confirm(`Delete ${checkedIds.size} selected NPC(s) from the ledger?`)) return;
        setNPCLedger(npcLedger.filter(n => !checkedIds.has(n.id)));
        if (selectedId && checkedIds.has(selectedId)) { setSelectedId(null); setIsEditing(false); }
        setCheckedIds(new Set());
        setSelectMode(false);
    };

    const handleExitSelectMode = () => { setSelectMode(false); setCheckedIds(new Set()); };

    // ── Import / Export ──────────────────────────────────────────────────
    const handleExport = () => {
        // Portraits are local asset paths — meaningless on another machine, so strip them.
        const exportData = npcLedger.map(npc => {
            const { portrait, ...rest } = npc;
            void portrait;
            return rest;
        });
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `npc_ledger_export_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    /** A green toast would hide a rejected file; anything unclean goes out as a warning (§9.5). */
    const emitQuickAddSummary = (plan: QuickAddPlan, collisions: QuickAddDecision[], portraitFailures: string[]) => {
        const text = summarizeQuickAdd(plan, { collisions, portraitFailures });
        const clean = plan.failures.length === 0 && portraitFailures.length === 0;
        if (clean) toast.success(text); else toast.warning(text);
    };

    /**
     * WO-C §5 / §10.4 — the Import button now takes SillyTavern cards too.
     *
     * A legacy ledger export (a JSON *array*) still goes through the
     * Full/Strip/Isekai chooser: it carries origin-campaign baggage that needs
     * triage. A card is a fresh character, so it skips the chooser entirely.
     * Per §9.5 one bad file never blocks the good ones — every failure is
     * reported in the completion toast instead.
     */
    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const input = e.target;
        const files = Array.from(input.files ?? []);
        input.value = '';
        if (files.length === 0) return;

        const routed: QuickAddRouted[] = [];
        // Card -> its source PNG, by object identity: file names can repeat in one drop.
        const cardFiles = new Map<STCard, File>();
        let legacyFileCount = 0;

        for (const file of files) {
            const isPng = /\.png$/i.test(file.name) || file.type === 'image/png';
            let item: QuickAddRouted;
            try {
                item = isPng
                    ? routeQuickAddFile(file.name, 'png', await readFile(file, 'buffer'))
                    : routeQuickAddFile(file.name, 'json', await readFile(file, 'text'));
            } catch {
                routed.push({ kind: 'failed', fileName: file.name, reason: isPng ? 'not-png' : 'not-json' });
                continue;
            }
            if (item.kind === 'card' && isPng) cardFiles.set(item.card, file);
            if (item.kind === 'legacy-npc-array') legacyFileCount += 1;
            routed.push(item);
        }

        const state = useAppStore.getState();
        const plan = planQuickAdd(routed, state.npcLedger, {
            userName: state.playerCharacter?.name ?? 'You',
            matureMode: state.settings.matureMode ?? false,
        });

        // Legacy exports: unchanged path, unchanged dialog.
        if (plan.legacyEntries.length > 0) setPendingImport(plan.legacyEntries);
        else if (legacyFileCount > 0) alert('That file contains no NPCs.');

        const portraitFailures: string[] = [];
        // Portrait upload needs the server. A failure just means no portrait.
        const attachPortrait = async (card: STCard, npc: NPCEntry) => {
            const file = cardFiles.get(card);
            if (!file) return;
            try {
                npc.portrait = await uploadImageToLocal(file, card.name);
            } catch {
                portraitFailures.push(card.name);
            }
        };
        for (const addition of plan.additions) await attachPortrait(addition.card, addition.npc);
        for (const collision of plan.collisions) await attachPortrait(collision.card, collision.incoming);

        // Additions land first so an intra-drop duplicate's "existing" row is a
        // real ledger entry by the time its overwrite dialog resolves.
        if (plan.additions.length > 0) {
            addNPCs(plan.additions.map(a => a.npc));
            const chunks = plan.additions.flatMap(a => a.loreChunks);
            if (chunks.length > 0) setLoreChunks([...useAppStore.getState().loreChunks, ...chunks]);
        }

        // §9.3 — only the NEW rows are candidates for adaptation.
        const adaptSeeds: AdaptSeed[] = plan.additions.map(a => ({ id: a.npc.id, name: a.npc.name, card: a.card }));

        if (plan.collisions.length > 0) {
            setCardImport({ plan, index: 0, decisions: [], portraitFailures, adaptSeeds });
            return;
        }
        if (plan.additions.length > 0 || plan.failures.length > 0 || portraitFailures.length > 0) {
            emitQuickAddSummary(plan, [], portraitFailures);
        }
        offerAdaptation(adaptSeeds);
    };

    /** §9.4 — Overwrite updates the row in place; Cancel skips that card entirely. */
    const resolveCardCollision = (decision: QuickAddDecision) => {
        if (!cardImport) return;
        const { plan, index, decisions, portraitFailures, adaptSeeds } = cardImport;
        const collision = plan.collisions[index];

        if (decision === 'overwrite') {
            updateNPC(collision.existing.id, applyOverwrite(collision.existing, collision.incoming));
            setLoreChunks(replaceCardLoreGroup(
                useAppStore.getState().loreChunks,
                collision.card.name,
                collision.loreChunks,
            ));
        }

        const nextDecisions = [...decisions, decision];
        const nextIndex = index + 1;
        if (nextIndex < plan.collisions.length) {
            setCardImport({ plan, index: nextIndex, decisions: nextDecisions, portraitFailures, adaptSeeds });
            return;
        }
        setCardImport(null);
        emitQuickAddSummary(plan, nextDecisions, portraitFailures);
        // The queue is drained, so the quick-add is finally complete — this is
        // the earliest moment §9.3's question can honestly be asked.
        offerAdaptation(adaptSeeds);
    };

    /* ── WO-C §9.3 (order "C2") — the Living-world adaptation pass ─────────── */

    /**
     * Ask, but only when there is something to ask about: the flag is on and the
     * drop actually added someone. Flag off is the default and changes nothing —
     * no dialog, no endpoint resolution, no model call anywhere on this path.
     */
    const offerAdaptation = (seeds: AdaptSeed[]) => {
        if (seeds.length === 0) return;
        const state = useAppStore.getState();
        if (!state.settings?.stImportAdaptation) return;
        const provider = resolveAdaptationEndpoint({
            utility: state.getActiveUtilityEndpoint,
            auxiliary: state.getActiveAuxiliaryEndpoint,
            summarizer: state.getActiveSummarizerEndpoint,
            story: state.getActiveStoryEndpoint,
        });
        // `null` disables the Living-world button rather than hiding it — a user
        // with no utility endpoint should learn why the option is dead.
        setAdaptOffer({ seeds, endpoint: provider ? describeAdaptationEndpoint(provider) : null });
    };

    /** Ref → state, in roster order, so the panel's rows never jump around. */
    const publishResults = () => {
        const map = collectedRef.current;
        setAdaptResults(
            targetsRef.current
                .map(t => map.get(t.id))
                .filter((r): r is AdaptationResult => r !== undefined),
        );
    };

    /**
     * An adapted result lands on the LIVE row, not on the snapshot the pass was
     * given: the ledger is open and the store is authoritative. Only `wants` and
     * its provenance are written — this pass never authors anything else.
     */
    const applyAdapted = (result: AdaptationResult) => {
        if (result.status !== 'adapted' || !result.wants) return;
        const fresh = useAppStore.getState().npcLedger.find(n => n.id === result.id);
        if (!fresh) return;
        const adapted = applyAdaptedWants(fresh, result.wants);
        updateNPC(result.id, { wants: adapted.wants, wantsProvenance: adapted.wantsProvenance });
    };

    /**
     * One pass over `targets` — the first run and every Retry take this path, so
     * a retry is literally "run it again for these ids" (§9.3) and there is no
     * second, subtly different code path to keep in sync.
     *
     * The endpoint is re-resolved here rather than reused from the offer, so an
     * endpoint that went away in between fails every target with a reason
     * instead of throwing.
     */
    const runTargets = async (targets: AdaptationTarget[]) => {
        if (targets.length === 0) return;
        const state = useAppStore.getState();
        const provider = resolveAdaptationEndpoint({
            utility: state.getActiveUtilityEndpoint,
            auxiliary: state.getActiveAuxiliaryEndpoint,
            summarizer: state.getActiveSummarizerEndpoint,
            story: state.getActiveStoryEndpoint,
        });
        if (!provider) {
            for (const t of targets) {
                collectedRef.current.set(t.id, { id: t.id, name: t.name, status: 'failed', error: NO_ENDPOINT_COPY });
            }
            publishResults();
            setAdaptPhase('done');
            return;
        }

        const controller = new AbortController();
        abortRef.current = controller;
        adaptStartRef.current = Date.now();
        setAdaptElapsed(0);
        setAdaptProgress(null);
        setAdaptPhase('running');

        try {
            const results = await runAdaptation(targets, {
                callModel: makeModelCaller(provider, { trackingLabel: 'ST ledger adaptation' }),
                onProgress: setAdaptProgress,
                onResult: r => { collectedRef.current.set(r.id, r); applyAdapted(r); publishResults(); },
                signal: controller.signal,
            }, { importId: importIdRef.current, matureMode: state.settings?.matureMode ?? false });
            // Writing again from the resolved array is deliberate: `onResult` is
            // optional in the contract, and re-applying the same clamped wants to
            // the same row is a no-op.
            for (const r of results) { collectedRef.current.set(r.id, r); applyAdapted(r); }
        } catch (err) {
            // A rejected run still has to name every NPC it never reached, or the
            // completion list would quietly lose them and the user would never
            // learn who stayed on pool wants.
            console.warn('[NPCLedger] Adaptation run failed:', err);
            const aborted = controller.signal.aborted;
            const reason = err instanceof Error ? err.message : 'the adaptation pass stopped';
            for (const t of targets) {
                if (collectedRef.current.get(t.id)?.status === 'adapted') continue;
                collectedRef.current.set(t.id, {
                    id: t.id,
                    name: t.name,
                    status: aborted ? 'cancelled' : 'failed',
                    error: aborted ? 'cancelled' : reason,
                });
            }
        }
        abortRef.current = null;
        publishResults();
        setAdaptPhase('done');
    };

    /**
     * Living-world was chosen. Targets are rebuilt from the LIVE ledger rows
     * (they carry the uploaded portraits and any dedupe the store applied); a
     * seed whose row has since vanished is simply dropped.
     */
    const beginAdaptation = (seeds: AdaptSeed[]) => {
        setAdaptOffer(null);
        const byId = new Map(useAppStore.getState().npcLedger.map(n => [n.id, n]));
        const targets: AdaptationTarget[] = [];
        for (const seed of seeds) {
            const npc = byId.get(seed.id);
            if (npc) targets.push({ id: seed.id, name: npc.name, card: seed.card, npc });
        }
        if (targets.length === 0) return;

        targetsRef.current = targets;
        collectedRef.current = new Map();
        // §9.3 — a stable per-import id so two drops' batches cannot be confused.
        importIdRef.current = `ledger-${Date.now()}`;
        setAdaptResults([]);
        void runTargets(targets);
    };

    /** Continue: dismiss the panel and say what the pass actually achieved. */
    const finishAdaptation = () => {
        const seen = [...collectedRef.current.values()];
        const adapted = seen.filter(r => r.status === 'adapted').length;
        setAdaptPhase('idle');
        setAdaptProgress(null);
        setAdaptResults([]);
        toast.success(`${adapted} adapted, ${seen.length - adapted} on offline fallback.`);
    };

    const commitImport = (mode: NpcImportMode) => {
        if (!pendingImport) return;
        const imported = prepareImportedNpcs(pendingImport, mode, uid);
        addNPCs(imported);
        setPendingImport(null);
        toast.success(`Imported ${imported.length} NPC(s).`);
    };

    const handleSeedFromLore = () => {
        const chunks = useAppStore.getState().loreChunks || [];
        const parsed = parseNPCsFromLore(chunks);
        if (parsed.length === 0) { alert('No ## CHARACTERS block found in the lore file.'); return; }

        const existingByName = new Map(npcLedger.map(n => [n.name.toLowerCase(), n]));
        const newNpcs: NPCEntry[] = [];
        let updatedCount = 0;

        const hasVisualData = (vp?: NPCVisualProfile) => !!(vp && (vp.race || vp.gender || vp.ageRange || vp.build || vp.symmetry || vp.hairStyle || vp.eyeColor || vp.skinTone || vp.gait || vp.distinctMarks || vp.clothing));

        for (const incoming of parsed) {
            const existing = existingByName.get(incoming.name.toLowerCase());
            if (!existing) { newNpcs.push(incoming); continue; }
            const incomingVP = incoming.visualProfile;
            if (!hasVisualData(incomingVP)) continue;
            const currentVP = existing.visualProfile || { ...DEFAULT_VISUAL_PROFILE };
            const mergedVP: NPCVisualProfile = {
                race: currentVP.race || incomingVP?.race || '', gender: currentVP.gender || incomingVP?.gender || '',
                ageRange: currentVP.ageRange || incomingVP?.ageRange || '', build: currentVP.build || incomingVP?.build || '',
                symmetry: currentVP.symmetry || incomingVP?.symmetry || '', hairStyle: currentVP.hairStyle || incomingVP?.hairStyle || '',
                eyeColor: currentVP.eyeColor || incomingVP?.eyeColor || '', skinTone: currentVP.skinTone || incomingVP?.skinTone || '',
                gait: currentVP.gait || incomingVP?.gait || '', distinctMarks: currentVP.distinctMarks || incomingVP?.distinctMarks || '',
                clothing: currentVP.clothing || incomingVP?.clothing || '', artStyle: currentVP.artStyle || incomingVP?.artStyle || 'Stylized Game Realism',
            };
            const vpChanged = Object.keys(mergedVP).some(k => mergedVP[k as keyof NPCVisualProfile] !== (currentVP[k as keyof NPCVisualProfile] || (k === 'artStyle' ? 'Stylized Game Realism' : '')));
            const appearanceChanged = !existing.appearance && !!incoming.appearance;
            if (vpChanged || appearanceChanged) {
                updateNPC(existing.id, { appearance: existing.appearance || incoming.appearance, visualProfile: mergedVP });
                updatedCount += 1;
            }
        }

        if (newNpcs.length > 0) addNPCs(newNpcs);
        if (newNpcs.length === 0 && updatedCount === 0) { alert('No new lore characters found, and no existing records needed visual-profile updates.'); return; }
        alert(`Lore sync complete: added ${newNpcs.length} new NPC(s), updated ${updatedCount} existing NPC(s).`);
    };

    // ── Portrait / AI ────────────────────────────────────────────────────
    const handleGeneratePortrait = () => portraits.generateForForm(form, form.id, isEditing, (patch) => setForm(prev => ({ ...prev, ...patch })));
    const handleUploadPortrait = (file: File) => portraits.uploadForForm(file, form.name || 'Unknown', form.id, isEditing, (patch) => setForm(prev => ({ ...prev, ...patch })));
    const handleRemovePortrait = () => {
        const patch = { portrait: '' };
        setForm(prev => ({ ...prev, ...patch }));
        if (!isEditing && form.id) useAppStore.getState().updateNPC(form.id, patch);
    };
    const handlePopulateImages = () => portraits.populateAll(npcLedger, selectedId, (patch) => setForm(prev => ({ ...prev, ...patch })));

    const handleAIUpdate = async () => {
        if (!selectedId || !form.name) return;
        const state = useAppStore.getState();
        const provider = state.getActiveStoryEndpoint();
        if (!provider) { alert('Story AI endpoint is not configured.'); return; }
        const npc = npcLedger.find(n => n.id === selectedId);
        if (!npc) return;
        setIsAIUpdating(true);
        try {
            await updateExistingNPCs(provider, state.messages, [npc], (id, patch) => {
                updateNPC(id, patch);
                setForm(prev => ({ ...prev, ...patch }));
            });
        } catch (err: unknown) {
            console.error('[NPC Manual AI Update] Error:', err);
            toast.error('AI update failed for this NPC');
        } finally {
            setIsAIUpdating(false);
        }
    };

    const handleCancelEdit = () => {
        const npc = npcLedger.find(n => n.id === selectedId);
        if (npc) setForm({ ...npc, visualProfile: npc.visualProfile || { ...DEFAULT_VISUAL_PROFILE } });
        setIsEditing(false);
    };

    const missingPortraitCount = npcLedger.filter(n => !n.portrait).length;

    // ── Render ────────────────────────────────────────────────────────────
    return (
        <div data-ui="ledger" className="fixed inset-0 z-50 flex flex-col bg-void/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="NPC Ledger" onClick={closeLedger}>
            <div className="relative bg-surface border border-border flex flex-col sm:flex-row w-full h-full overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
                {/* Hidden import input lives INSIDE the stopPropagation container. If it sat
                    on the backdrop, importRef.current.click() would bubble a click to the
                    overlay's onClick={toggleNPCLedger}, closing the modal and unmounting the
                    input before the OS file dialog resolved — so onChange never fired. */}
                <input ref={importRef} type="file" accept=".json,.png" multiple className="hidden" onChange={(e) => { void handleImportFile(e); }} />

                {pendingImport && (
                    <ImportChoiceDialog
                        count={pendingImport.length}
                        label="NPC"
                        onChoose={commitImport}
                        onCancel={() => setPendingImport(null)}
                    />
                )}

                {cardImport && (
                    <ImportOverwriteDialog
                        name={cardImport.plan.collisions[cardImport.index].card.name}
                        kind="existing"
                        onOverwrite={() => resolveCardCollision('overwrite')}
                        onCancel={() => resolveCardCollision('skip')}
                    />
                )}

                {/* §9.3 — asked only once the whole quick-add has landed, and only
                    about the rows it added. Declining costs nothing. */}
                {adaptOffer && (
                    <AdaptChoiceDialog
                        count={adaptOffer.seeds.length}
                        endpoint={adaptOffer.endpoint}
                        onChoose={choice => {
                            if (choice === 'living-world') beginAdaptation(adaptOffer.seeds);
                            else setAdaptOffer(null);
                        }}
                        onCancel={() => setAdaptOffer(null)}
                    />
                )}

                {/* The pass itself. An overlay like the dialogs, because the ledger
                    underneath is live and already holds every imported NPC. */}
                {adaptPhase !== 'idle' && (
                    <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4">
                        <div className="w-full max-w-lg max-h-full overflow-y-auto bg-surface border border-border rounded-lg shadow-2xl p-5">
                            <AdaptationPanel
                                progress={adaptProgress}
                                results={adaptResults}
                                running={adaptPhase === 'running'}
                                elapsedSeconds={adaptElapsed}
                                onCancel={() => abortRef.current?.abort()}
                                onRetry={ids => { void runTargets(targetsRef.current.filter(t => ids.includes(t.id))); }}
                                onContinue={finishAdaptation}
                                continueLabel="Done"
                            />
                        </div>
                    </div>
                )}

                {/* Left Sidebar */}
                <div data-ui="ledger-list" className="w-full sm:w-1/3 md:w-96 lg:w-[420px] border-b sm:border-b-0 sm:border-r border-border flex flex-col bg-void-lighter max-h-[40vh] sm:max-h-none shrink-0">
                    {/* Header */}
                    <div className="p-4 border-b border-border flex justify-between items-center bg-void">
                        <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                            <Users size={16} /> NPC Ledger
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="flex bg-surface border border-border rounded overflow-hidden">
                                <button onClick={() => setViewMode('list')} className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-terminal text-void' : 'text-text-dim hover:text-text-primary'}`} title="List View">
                                    <List size={14} />
                                </button>
                                <button onClick={() => setViewMode('gallery')} className={`p-1.5 transition-colors ${viewMode === 'gallery' ? 'bg-terminal text-void' : 'text-text-dim hover:text-text-primary'}`} title="Gallery View">
                                    <LayoutGrid size={14} />
                                </button>
                            </div>
                            <button onClick={() => setSortOrder(prev => prev === 'none' ? 'az' : prev === 'az' ? 'za' : 'none')} className={`p-1.5 border border-border rounded transition-colors ${sortOrder !== 'none' ? 'bg-terminal text-void border-terminal' : 'text-text-dim hover:text-text-primary'}`} title={sortOrder === 'az' ? 'Sorted A→Z (click for Z→A)' : sortOrder === 'za' ? 'Sorted Z→A (click to clear)' : 'Sort alphabetically'}>
                                {sortOrder === 'za' ? <ArrowUpZA size={14} /> : <ArrowDownAZ size={14} />}
                            </button>
                            <button onClick={closeLedger} className="text-text-dim hover:text-text-primary p-1 sm:hidden shrink-0"><X size={18} /></button>
                        </div>
                    </div>

                    {/* Search Bar */}
                    <div className="px-3 py-2 border-b border-border bg-void-lighter shrink-0">
                        <div className="relative">
                            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                placeholder="Search name, alias, faction..."
                                className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded text-xs text-text-primary placeholder:text-text-dim/50 focus:outline-none focus:border-terminal transition-colors"
                            />
                            {searchQuery && (
                                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-dim hover:text-text-primary transition-colors">
                                    <X size={12} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Action Bar */}
                    <div className="p-3 border-b border-border bg-void-lighter shrink-0 space-y-2">
                        <div className="flex gap-1.5">
                            <button onClick={handleCreateNew} className={`flex-1 flex items-center justify-center gap-2 py-2 px-4 border border-dashed rounded text-xs uppercase tracking-wider transition-colors ${!selectedId && isEditing ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-terminal hover:border-terminal'}`}>
                                <Plus size={14} /> New Record
                            </button>
                            <button
                                onClick={review.startReview}
                                disabled={review.reviewRunning || npcLedger.length === 0}
                                className="flex-1 flex items-center justify-center gap-1.5 border border-amber-500/30 rounded text-xs uppercase tracking-wider text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer animate-pulse-subtle"
                                title="Run AI review to flag non-character ledger entries"
                            >
                                <Sparkles size={12} className="shrink-0" /> Review & Prune
                            </button>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <button onClick={() => importRef.current?.click()} title="Import NPCs (JSON) or SillyTavern cards (PNG/JSON)" className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors">
                                <Upload size={11} /> Import
                            </button>
                            <button onClick={handleSeedFromLore} title="Seed from Lore" className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors">
                                <BookOpen size={11} /> Seed
                            </button>
                            <button onClick={handleExport} disabled={npcLedger.length === 0} title="Export NPCs to JSON" className="flex-1 flex items-center justify-center gap-1 py-1.5 px-2 border border-border rounded text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal hover:border-terminal transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                                <Download size={11} /> Export
                            </button>
                            <button onClick={selectMode ? handleExitSelectMode : () => setSelectMode(true)} title={selectMode ? 'Exit select mode' : 'Select NPCs for bulk action'} className={`flex-1 flex items-center justify-center gap-1 py-1.5 px-2 border rounded text-[10px] uppercase tracking-wider transition-colors ${selectMode ? 'border-terminal text-terminal bg-terminal/10' : 'border-border text-text-dim hover:text-terminal hover:border-terminal'}`}>
                                <CheckSquare size={11} /> Select
                            </button>
                        </div>
                        {missingPortraitCount > 0 && (
                            <button
                                onClick={handlePopulateImages}
                                disabled={!!portraits.populating}
                                className="w-full flex items-center justify-center gap-1.5 py-1.5 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal hover:bg-terminal/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                            >
                                <Images size={12} className="shrink-0" />
                                {portraits.populating
                                    ? `Generating ${portraits.populating.done}/${portraits.populating.total}…`
                                    : `Populate Images (${missingPortraitCount})`}
                            </button>
                        )}
                        {selectMode && (
                            <div className="flex items-center justify-between gap-2 pt-1">
                                <button onClick={handleSelectAll} className="text-[10px] uppercase tracking-wider text-text-dim hover:text-terminal transition-colors">
                                    {allChecked ? 'Deselect All' : 'Select All'}
                                </button>
                                <button onClick={handleDeleteSelected} disabled={checkedIds.size === 0} className="flex items-center gap-1 px-3 py-1 bg-danger/10 border border-danger/30 text-danger text-[10px] uppercase tracking-wider rounded hover:bg-danger/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
                                    <Trash2 size={10} /> Delete ({checkedIds.size})
                                </button>
                            </div>
                        )}
                    </div>

                    {/* List or Gallery */}
                    {searchQuery.trim() && displayedNPCs.length !== npcLedger.length && (
                        <div className="px-3 py-1.5 text-[10px] text-text-dim border-b border-border bg-void-lighter shrink-0">
                            Showing {displayedNPCs.length} of {npcLedger.length} records
                        </div>
                    )}
                    {!searchQuery.trim() && npcSuggestions && npcSuggestions.length > 0 && (
                        <div className="px-3 pt-2 shrink-0">
                            <NPCSuggestionsPanel suggestions={npcSuggestions} />
                        </div>
                    )}
                    {viewMode === 'list'
                        ? <NPCListView npcLedger={displayedNPCs} selectedId={selectedId} selectMode={selectMode} checkedIds={checkedIds} onSelect={handleSelect} onToggleCheck={toggleCheck} onDelete={handleDelete} onRestore={(id) => restoreNPC(id)} />
                        : <NPCGalleryView npcLedger={displayedNPCs} selectedId={selectedId} selectMode={selectMode} checkedIds={checkedIds} onSelect={handleSelect} onToggleCheck={toggleCheck} onDelete={handleDelete} onRestore={(id) => restoreNPC(id)} />
                    }
                </div>

                {/* Right Detail Pane */}
                <div className="flex-1 flex flex-col bg-surface overflow-hidden relative">
                    <button onClick={closeLedger} className="absolute top-4 right-4 text-text-dim hover:text-text-primary hidden sm:block p-1 bg-void rounded border border-border hover:border-terminal transition-colors z-10">
                        <X size={18} />
                    </button>
                    <NPCEditForm
                        form={form}
                        setForm={setForm}
                        selectedId={selectedId}
                        isEditing={isEditing}
                        isAIUpdating={isAIUpdating}
                        isGeneratingImage={portraits.isGeneratingImage}
                        onEdit={() => setIsEditing(true)}
                        onSave={handleSave}
                        onCancel={handleCancelEdit}
                        onDelete={handleDelete}
                        onAIUpdate={handleAIUpdate}
                        onGeneratePortrait={handleGeneratePortrait}
                        onUploadPortrait={handleUploadPortrait}
                        onRemovePortrait={handleRemovePortrait}
                    />
                </div>
            </div>
            <NPCReviewModal
                open={review.reviewOpen}
                running={review.reviewRunning}
                progress={review.reviewProgress}
                candidates={review.reviewCandidates}
                failedBatches={review.reviewFailedBatches}
                actions={review.reviewActions}
                error={review.reviewError}
                onCancel={review.closeReview}
                onStop={review.stopReview}
                onSetAction={review.setReviewAction}
                onApply={() => review.applyReview({
                    selectedId,
                    onClearedSelection: () => { setSelectedId(null); setIsEditing(false); },
                })}
            />
        </div>
    );
}