import type { StateCreator } from 'zustand';
import type { ArchiveChapter, ChatMessage, CondenserState, GameContext, LoreChunk, ArchiveIndexEntry, NPCEntry, NpcSuggestion, SemanticFact, EntityEntry, TimelineEvent, InventoryItem, CharacterProfile, PinnedExcerpt, LocationEntry, LocationSuggestion } from '../../types';
import { DEFAULT_CHARACTER_PROFILE, DEFAULT_INVENTORY, migrateLegacyContext, buildDefaultDiceSystem, normalizeInventoryItem } from '../../types';
import { emitCoreEvent } from '../../services/mods/events';
import { normalizeRelations } from '../../services/npc/relationDedupe';
import { toast } from '../../components/Toast';
import { disposeCampaignSubscriptions } from '../../services/mods/reactiveReads';
import { debouncedSaveSettings } from './settingsSlice';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
} from './settingsSlice';

import { API_BASE as API } from '../../lib/apiBase';

import { createDebouncedSave, createTableSlice } from '../../services/tables/genericAccessor';
import { locationTableDescriptor } from '../../services/tables/locationTable';
let autoBackupTimer: ReturnType<typeof setInterval> | null = null;

function preOpBackup(campaignId: string | null, trigger: string) {
    if (!campaignId) return;
    fetch(`${API}/campaigns/${campaignId}/backup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trigger, isAuto: true }),
    }).catch(e => console.warn('[Pre-Op Backup] Failed:', e));
}

// ── Debounced save helpers ─────────────────────────────────────────────

// Getter registered by the slice creator so we always read fresh state at fire time.
// This prevents stale-snapshot race conditions where two rapid updates within the 1s
// debounce window would cause the first update's changes to be overwritten.
let _getStateForSave: (() => { activeCampaignId: string | null; context: GameContext; messages: ChatMessage[]; condenser: CondenserState; loreChunks: LoreChunk[]; npcLedger: NPCEntry[]; locationLedger: LocationEntry[]; pinnedExcerpts: PinnedExcerpt[] }) | null = null;
export function _registerCampaignStateGetter(
    getter: () => { activeCampaignId: string | null; context: GameContext; messages: ChatMessage[]; condenser: CondenserState; loreChunks: LoreChunk[]; npcLedger: NPCEntry[]; locationLedger: LocationEntry[]; pinnedExcerpts: PinnedExcerpt[] }
) {
    _getStateForSave = getter;
}

/**
 * Phase 3.2 — the active campaign id for `chatSlice`'s `message.*` emits.
 *
 * A slice cannot import the assembled `useAppStore` without a module cycle, and
 * `chatSlice` already depends on this module for `debouncedSaveCampaignState`.
 * This reuses the getter that module registers rather than opening a second
 * seam. `''` when no campaign is open, which is also when none of the emit sites
 * can fire.
 */
export function getActiveCampaignIdForEvents(): string {
    return _getStateForSave?.().activeCampaignId ?? '';
}

let stateTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelPendingSaves() {
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    if (loreTimer)  { clearTimeout(loreTimer);  loreTimer  = null; }
    if (npcTimer)   { clearTimeout(npcTimer);   npcTimer   = null; }
    locationLedgerSave.cancel();
}

/** Immediately fires any pending debounced saves so the latest in-memory state is on
 *  disk before a backup is created. Awaiting this guarantees the backup reads current data. */
export async function flushAllPendingSaves(): Promise<void> {
    if (!_getStateForSave) return;
    const { activeCampaignId, context, messages, condenser, loreChunks, npcLedger, pinnedExcerpts } = _getStateForSave();
    if (!activeCampaignId) return;

    const saves: Promise<unknown>[] = [];

    if (stateTimer) {
        clearTimeout(stateTimer);
        stateTimer = null;
        saves.push(
            fetch(`${API}/campaigns/${activeCampaignId}/state`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ context, messages, condenser, pinnedExcerpts }),
            }).catch(e => console.error('[FlushSave] state failed:', e))
        );
    }

    if (loreTimer) {
        clearTimeout(loreTimer);
        loreTimer = null;
        saves.push(
            fetch(`${API}/campaigns/${activeCampaignId}/lore`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loreChunks),
            }).catch(e => console.error('[FlushSave] lore failed:', e))
        );
    }

    if (npcTimer) {
        clearTimeout(npcTimer);
        npcTimer = null;
        saves.push(
            fetch(`${API}/campaigns/${activeCampaignId}/npcs`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(npcLedger),
            }).catch(e => console.error('[FlushSave] npcs failed:', e))
        );
    }

    saves.push(locationLedgerSave.flush());

    if (saves.length > 0) await Promise.all(saves);
}
/** Debounced campaign state save. Always reads fresh state at fire time (no stale closures). */
export function debouncedSaveCampaignState() {
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
        if (!_getStateForSave) return;
        const { activeCampaignId, context, messages, condenser, pinnedExcerpts } = _getStateForSave();
        if (!activeCampaignId) return;
        fetch(`${API}/campaigns/${activeCampaignId}/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context, messages, condenser, pinnedExcerpts }),
        }).catch((e) => { console.error(e); toast.error('Failed to save campaign state'); });
    }, 1000);
}

let loreTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveLoreChunks(campaignId: string | null, chunks: LoreChunk[]) {
    if (!campaignId) return;
    if (loreTimer) clearTimeout(loreTimer);
    loreTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/lore`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chunks),
        }).catch((e) => { console.error(e); toast.error('Failed to save lore'); });
    }, 1000);
}

let npcTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveNPCLedger(campaignId: string | null, npcs: NPCEntry[]) {
    if (!campaignId) return;
    if (npcTimer) clearTimeout(npcTimer);
    npcTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/npcs`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(npcs),
        }).catch((e) => { console.error(e); toast.error('Failed to save NPC ledger'); });
    }, 1000);
}

/**
 * Deduplicates the NPC ledger by name comparison:
 *   Rule 1: Exact full-name match -> keep the newer (later in array) entry
 *   Rule 2: First-name-only entry matches a full-name entry -> keep the fuller/newer entry
 *   Rule 3: Same first name but different last names -> do NOT touch
 */
export function dedupeNPCLedger(ledger: NPCEntry[], pcId?: string): NPCEntry[] {
    const removeIndices = new Set<number>();

    for (let i = 0; i < ledger.length; i++) {
        if (removeIndices.has(i)) continue;

        const nameI = ledger[i].name.trim().toLowerCase();
        const partsI = nameI.split(/\s+/);
        const firstI = partsI[0];
        const hasLastI = partsI.length > 1;

        for (let j = i + 1; j < ledger.length; j++) {
            if (removeIndices.has(j)) continue;

            const nameJ = ledger[j].name.trim().toLowerCase();
            const partsJ = nameJ.split(/\s+/);
            const firstJ = partsJ[0];
            const hasLastJ = partsJ.length > 1;

            // Rule 1: Exact full name match -> remove the older (i)
            if (nameI === nameJ) {
                console.log(`[NPC Dedup] Exact match: "${ledger[i].name}" == "${ledger[j].name}" → removing older entry`);
                removeIndices.add(i);
                break;
            }

            // Rule 2: First-name-only entry matches a first+last entry
            if (!hasLastI && hasLastJ && firstI === firstJ) {
                console.log(`[NPC Dedup] Partial match: "${ledger[i].name}" ⊂ "${ledger[j].name}" → removing shorter entry`);
                removeIndices.add(i);
                break;
            }
            if (hasLastI && !hasLastJ && firstI === firstJ) {
                console.log(`[NPC Dedup] Partial match: "${ledger[j].name}" ⊂ "${ledger[i].name}" → removing shorter entry`);
                removeIndices.add(j);
                continue;
            }

            // Rule 3: Same first name, different last names -> do NOT touch
        }
    }

    if (removeIndices.size > 0) {
        console.log(`[NPC Dedup] Removed ${removeIndices.size} duplicate(s) from ledger`);
    }

    const filtered = ledger.filter((_, idx) => !removeIndices.has(idx));
    return filtered.map(npc => {
        if (npc.relations && Object.keys(npc.relations).length > 0) {
            const normalized = normalizeRelations(npc.relations, filtered, pcId);
            return { ...npc, relations: normalized };
        }
        return npc;
    });
}

// ── Default context ────────────────────────────────────────────────────

export const defaultContext: GameContext = {
    loreRaw: '',
    rulesRaw: '',
    rulesChunkMeta: {},
    rulesChunks: [],
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    inventoryLastScene: 'Never',
    characterProfile: { identity: {}, activeTraits: [] },
    characterProfileLastScene: 'Never',
    inventoryItems: DEFAULT_INVENTORY,
    characterProfileData: DEFAULT_CHARACTER_PROFILE,
    smartBookkeepingActive: true,
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: false,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    diceSystem: buildDefaultDiceSystem(),
    surpriseConfig: {
        initialDC: 95,
        dcReduction: 3,
        types: [...DEFAULT_SURPRISE_TYPES],
        tones: [...DEFAULT_SURPRISE_TONES],
    },
    encounterConfig: {
        initialDC: 198,
        dcReduction: 2,
        types: [...DEFAULT_ENCOUNTER_TYPES],
        tones: [...DEFAULT_ENCOUNTER_TONES],
    },
    worldVibe: '',
    notebook: [],
    notebookActive: true,
    worldEventConfig: {
        initialDC: 498,
        dcReduction: 2,
        who: [...DEFAULT_WORLD_WHO],
        where: [...DEFAULT_WORLD_WHERE],
        why: [...DEFAULT_WORLD_WHY],
        what: [...DEFAULT_WORLD_WHAT],
    },
    // WO-A rewrite 2 §2: PC lives here, not in npcLedger. Optional — null means
    // "no PC created yet" (the Character panel shows the creation entry point).
    playerCharacter: null,
};

// ── Player Character (WO-A rewrite 2: D1 — PC lives outside npcLedger) ──
// The PC is an NPCEntry-shaped record stored at `context.playerCharacter`.
// It is NOT a row in `npcLedger`. `isPC` is vestigial for this record (the
// record's location *is* its PC-ness). Reusing the NPCEntry shape keeps the
// prompt pipeline, sanitization helpers, and hex/traits/wants/kit fields
// identical between PC and NPC without inventing a parallel schema.
export type PlayerCharacter = NPCEntry;

// ── Slice type ─────────────────────────────────────────────────────────

export type CampaignSlice = {
    activeCampaignId: string | null;
    setActiveCampaign: (id: string | null) => void;
    loreChunks: LoreChunk[];
    setLoreChunks: (chunks: LoreChunk[]) => void;
    updateLoreChunk: (id: string, patch: Partial<LoreChunk>) => void;
    archiveIndex: ArchiveIndexEntry[];
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    chapters: ArchiveChapter[];
    setChapters: (chapters: ArchiveChapter[]) => void;
    npcLedger: NPCEntry[];
    setNPCLedger: (npcs: NPCEntry[]) => void;
    addNPC: (npc: NPCEntry) => void;
    addNPCs: (newNpcs: NPCEntry[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    removeNPC: (id: string) => void;
    archiveNPC: (id: string, turn: number, reason: string) => void;
    restoreNPC: (id: string) => void;
    mergeOrRenameNpc: (from: string, to: string, turn: number) => 'merged' | 'renamed' | 'none';
    // ── Player character (WO-A rewrite 2 §1 + §2) ──
    // Stored at `context.playerCharacter`, NOT in npcLedger. `isPC` is vestigial.
    playerCharacter: PlayerCharacter | null;
    setPlayerCharacter: (pc: PlayerCharacter | null) => void;
    updatePlayerCharacter: (patch: Partial<PlayerCharacter>) => void;
    onStageNpcIds: string[];
    setOnStageNpcIds: (ids: string[]) => void;
    // WO-11.3 — NPC suggestions: auto-detected names awaiting player promotion.
    npcSuggestions: NpcSuggestion[];
    addNpcSuggestions: (names: string[], context?: string) => void;
    dismissNpcSuggestion: (name: string) => void;
    clearNpcSuggestions: () => void;
    // ── Location Ledger (v1) — structured places + auto-detected suggestions ──
    locationLedger: LocationEntry[];
    setLocationLedger: (locations: LocationEntry[]) => void;
    addLocation: (loc: LocationEntry) => void;
    updateLocation: (id: string, patch: Partial<LocationEntry>) => void;
    removeLocation: (id: string) => void;
    locationSuggestions: LocationSuggestion[];
    addLocationSuggestions: (suggestions: LocationSuggestion[]) => void;
    dismissLocationSuggestion: (name: string) => void;
    clearLocationSuggestions: () => void;
    semanticFacts: SemanticFact[];
    setSemanticFacts: (facts: SemanticFact[]) => void;
    timeline: TimelineEvent[];
    setTimeline: (events: TimelineEvent[]) => void;
    addTimelineEvent: (event: TimelineEvent) => void;
    removeTimelineEvent: (eventId: string) => void;
    entities: EntityEntry[];
    setEntities: (entities: EntityEntry[]) => void;
    pinnedChapterIds: string[];
    pinChapter: (chapterId: string) => void;
    clearPinnedChapters: () => void;

    context: GameContext;
    updateContext: (patch: Partial<GameContext>) => void;
    inventoryItems: InventoryItem[];
    setInventoryItems: (items: InventoryItem[]) => void;
    updateInventoryItem: (id: string, patch: Partial<InventoryItem>) => void;
    removeInventoryItem: (id: string) => void;
    addInventoryItem: (item: InventoryItem) => void;
    characterProfileData: CharacterProfile;
    setCharacterProfileData: (p: CharacterProfile) => void;

    bookkeepingTurnCounter: number;
    autoBookkeepingInterval: number;
    setAutoBookkeepingInterval: (n: number) => void;
    resetBookkeepingTurnCounter: () => void;
    incrementBookkeepingTurnCounter: () => number;
    // ── Mod tables (WO-P5-05) ───────────────────────────────────────────
    // One namespaced map keyed by the descriptor's full name (`mod.<modId>.<name>`).
    // Mod tables do NOT get individual top-level fields — the whole point is
    // that no code is written per table. Panels (phase PANELS) make them
    // pleasant to use; that is not this work order.
    modTables: Record<string, unknown>;
    setModTable: (name: string, data: unknown) => void;
    getModTable: (name: string) => unknown;
    /**
     * Phase 6.4 — drop every in-memory entry belonging to one mod, after its
     * files have already been removed on the server. Local only: it writes
     * nothing and deletes nothing on disk, so calling it can never be the
     * thing that destroys data. The server's DELETE is the destructive act;
     * this stops the store from serving rows that no longer exist.
     */
    clearModTables: (modId: string) => void;
};

// ── Combined state needed for cross-slice access ───────────────────────

type CampaignDeps = CampaignSlice & {
    settings: import('../../types').AppSettings;
    messages: ChatMessage[];
    condenser: CondenserState;
    pinnedExcerpts: PinnedExcerpt[];
};

const locationSliceDescriptor = {
    ...locationTableDescriptor,
    hooks: { onRemove: ((campaignId: string, id: string, state: CampaignDeps) => {
        preOpBackup(campaignId, 'pre-delete-location');
        if (state.context.currentPlaceId !== id) return undefined;
        const context = migrateLegacyContext({ ...state.context, currentPlaceId: null, currentFeature: null });
        debouncedSaveCampaignState();
        return { context };
    }) as never },
};

const locationTableSlice = createTableSlice<LocationEntry[], CampaignDeps>(locationSliceDescriptor, []);
const locationLedgerSave = createDebouncedSave<LocationEntry[]>(locationTableDescriptor as never, () => {
    const state = _getStateForSave?.();
    return { activeCampaignId: state?.activeCampaignId ?? null, field: state?.locationLedger ?? [] };
});

// ── Slice creator ──────────────────────────────────────────────────────

export const createCampaignSlice: StateCreator<CampaignDeps, [], [], CampaignSlice> = (set, get) => {
    // Register a fresh-state getter so debouncedSaveCampaignState always writes current data,
    // not a stale closure snapshot from the time the action was called.
    _registerCampaignStateGetter(() => {
        const s = get();
        return { activeCampaignId: s.activeCampaignId, context: s.context, messages: s.messages, condenser: s.condenser, loreChunks: s.loreChunks, npcLedger: s.npcLedger, locationLedger: s.locationLedger, pinnedExcerpts: s.pinnedExcerpts };
    });

    return {
    activeCampaignId: null,
    setActiveCampaign: async (id) => {
        // Swipe Generation v1 — commit any pending turn for the CURRENT campaign
        // before switching. The arc/agency ticks + archive append derived at
        // commit read the OLD campaign's state, so a deferred commit must fire
        // before the state is overwritten by the new campaign's hydration.
        // Awaiting here is safe: an async body is assignable to the `(id) => void`
        // type (the returned Promise is ignored by sync callers). The await
        // happens BEFORE the `set` below, so commitPendingTurn still reads the
        // OLD campaign's state from the live store.
        const currentId = get().activeCampaignId;
        if (id !== currentId) {
            disposeCampaignSubscriptions(currentId);
            try {
                const { commitPendingTurn } = await import('../../services/turn/pendingCommit');
                await commitPendingTurn();
            } catch (e) {
                console.warn('[CampaignSwitch] commit failed:', e);
            }
            // WO-04 invariant 7: the Director Brief once-per-input cache is keyed
            // by (campaignId, userMessage). Clear it on campaign switch so a brief
            // computed for the old campaign never leaks into the new campaign's
            // first turn. Lazy import mirrors the pendingCommit import above.
            try {
                const { clearDirectorBriefCache } = await import('../../services/turn/directorBrief');
                clearDirectorBriefCache();
            } catch (e) {
                console.warn('[CampaignSwitch] clearDirectorBriefCache failed:', e);
            }
            // its own module-local runtime state (the pattern
            // the campaign-switch cleanup moves to the mod's lifecycle hook.
        }

        // Flush any pending campaign state save for the OLD campaign before switching.
        // Without this, the timer fires after state is overwritten by the new campaign's
        // data and writes the new campaign's state into the old campaign's save slot.
        if (stateTimer && _getStateForSave) {
            clearTimeout(stateTimer);
            stateTimer = null;
            const { activeCampaignId: oldId, context, messages, condenser, pinnedExcerpts } = _getStateForSave();
            if (oldId && oldId !== id) {
                fetch(`${API}/campaigns/${oldId}/state`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ context, messages, condenser, pinnedExcerpts }),
                }).catch((e) => { console.error('[CampaignSwitch] Flush save failed:', e); });
            }
        }

        if (autoBackupTimer) {
            clearInterval(autoBackupTimer);
            autoBackupTimer = null;
        }

        // Phase 3.2 / `EVENTS.md` §6.2 — the last instant the OLD campaign is
        // readable, immediately before `activeCampaignId` changes. Placed here
        // and not ~50 lines up so a mod's teardown sees a settled campaign: the
        // (`nextCampaignId: null`); a first open from the hub closes nothing.
        //
        // Known inconsistency, recorded not fixed (`EVENTS.md` §9.4 finding 1):
        // `disposeCampaignSubscriptions(currentId)` above has already revoked
        // the mod's reactive handles by the time this arrives. Survivable — a
        // teardown handler reads the payload, not a subscription.
        if (currentId && currentId !== id) {
            emitCoreEvent('campaign.closing', { campaignId: currentId, nextCampaignId: id });
        }

        set({ activeCampaignId: id } as Partial<CampaignDeps>);
        const s = get();
        debouncedSaveSettings(s.settings, id);

        if (id) {
            autoBackupTimer = setInterval(async () => {
                const currentState = get();
                if (!currentState.activeCampaignId) return;
                try {
                    const result = await fetch(`${API}/campaigns/${currentState.activeCampaignId}/backup`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ trigger: 'auto', isAuto: true }),
                    });
                    if (result.ok) {
                        const data = await result.json();
                        if (!data.skipped) {
                            console.log('[Auto-Backup] Created at', new Date().toLocaleTimeString());
                        }
                    }
                } catch (e) {
                    console.warn('[Auto-Backup] Failed:', e);
                }
            }, 10 * 60 * 1000);
        }
    },
    loreChunks: [],
    setLoreChunks: (chunks) => set((s) => {
        debouncedSaveLoreChunks(s.activeCampaignId, chunks);
        return { loreChunks: chunks } as Partial<CampaignDeps>;
    }),
    updateLoreChunk: (id, patch) => set((s) => {
        const newChunks = s.loreChunks.map(c => c.id === id ? { ...c, ...patch } : c);
        debouncedSaveLoreChunks(s.activeCampaignId, newChunks);
        return { loreChunks: newChunks };
    }),
    archiveIndex: [],
    // Read-only hydration setter — archive index is rebuilt server-side on each turn.
    setArchiveIndex: (entries) => set({ archiveIndex: entries } as Partial<CampaignDeps>),
    chapters: [],
    // Read-only hydration setter — individual chapter mutations go through api.chapters.*
    setChapters: (chapters) => set({ chapters } as Partial<CampaignDeps>),
    npcLedger: [],
    setNPCLedger: (npcs) => set((s) => {
        debouncedSaveNPCLedger(s.activeCampaignId, npcs);
        return { npcLedger: npcs };
    }),
    addNPC: (npc) => set((s) => {
        const pcId = s.playerCharacter?.id;
        const withNew = [...s.npcLedger, npc];
        const deduped = dedupeNPCLedger(withNew, pcId);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    addNPCs: (newNpcs) => set((s) => {
        const pcId = s.playerCharacter?.id;
        const withNew = [...s.npcLedger, ...newNpcs];
        const deduped = dedupeNPCLedger(withNew, pcId);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    updateNPC: (id, patch) => set((s) => {
        const pcId = s.playerCharacter?.id;
        let nextPatch = patch;
        if (patch.relations && Object.keys(patch.relations).length > 0) {
            nextPatch = { ...patch, relations: normalizeRelations(patch.relations, s.npcLedger, pcId) };
        }
        const newLedger = s.npcLedger.map(n => n.id === id ? { ...n, ...nextPatch } : n);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    removeNPC: (id) => set((s) => {
        preOpBackup(s.activeCampaignId, 'pre-delete-npc');
        const newLedger = s.npcLedger.filter(n => n.id !== id);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    archiveNPC: (id, turn, reason) => set((s) => {
        const newLedger = s.npcLedger.map(npc =>
            npc.id === id
                ? { ...npc, archived: true, archivedAtTurn: turn, archivedReason: reason }
                : npc
        );
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    restoreNPC: (id) => set((s) => {
        const newLedger = s.npcLedger.map(npc =>
            npc.id === id
                ? { ...npc, archived: false, archivedAtTurn: undefined, archivedReason: undefined }
                : npc
        );
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    mergeOrRenameNpc: (from, to, turn) => {
        void turn;
        const fromKey = from.trim().toLowerCase();
        const toKey = to.trim().toLowerCase();
        if (!fromKey || !toKey || fromKey === toKey) return 'none';
        const s = get();
        const matches = (n: NPCEntry, key: string) => {
            const names = [n.name, ...(n.aliases || '').split(',')].map(x => x.trim().toLowerCase());
            return names.includes(key);
        };
        const fromNpc = s.npcLedger.find(n => matches(n, fromKey));
        if (!fromNpc) return 'none';
        const toNpc = s.npcLedger.find(n => n.id !== fromNpc.id && matches(n, toKey));
        if (toNpc) {
            get().removeNPC(fromNpc.id);
            return 'merged';
        }
        get().updateNPC(fromNpc.id, { name: to.trim() });
        return 'renamed';
    },
    onStageNpcIds: [],
    setOnStageNpcIds: (ids) => set({ onStageNpcIds: ids } as Partial<CampaignDeps>),
    // WO-11.3 — NPC suggestions. Detection runs in postTurnPipeline; names land
    // here for the player to accept/dismiss in NPCLedgerModal. Skips anything
    // already tracked in the ledger (or a name variant of it).
    npcSuggestions: [],
    addNpcSuggestions: (names, context) => set((s) => {
        const existing = new Set(s.npcSuggestions.map(x => x.name.toLowerCase()));
        const now = Date.now();
        const fresh: NpcSuggestion[] = [];
        for (const raw of names) {
            const name = raw.trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (existing.has(key)) continue;
            // Skip anything already tracked in the ledger (or a name variant of it)
            const inLedger = s.npcLedger.some(n => {
                if (!n.name) return false;
                const allNames = [n.name, ...(n.aliases || '').split(',').map(a => a.trim())].filter(Boolean);
                return allNames.some(n2 => {
                    const lo = n2.toLowerCase();
                    return lo === key || lo.startsWith(key + ' ') || lo.endsWith(' ' + key);
                });
            });
            if (inLedger) continue;
            existing.add(key);
            fresh.push({ name, context, firstSeen: now });
        }
        if (fresh.length === 0) return {};
        return { npcSuggestions: [...s.npcSuggestions, ...fresh] } as Partial<CampaignDeps>;
    }),
    dismissNpcSuggestion: (name) => set((s) => ({
        npcSuggestions: s.npcSuggestions.filter(x => x.name.toLowerCase() !== name.toLowerCase()),
    }) as Partial<CampaignDeps>),
    clearNpcSuggestions: () => set({ npcSuggestions: [] } as Partial<CampaignDeps>),
    // ── Location Ledger (v1) ──
    locationLedger: locationTableSlice.initial,
    setLocationLedger: (locations) => set((s) => {
        const transition = locationTableSlice.set(s.locationLedger, locations);
        locationLedgerSave(transition.field);
        return { locationLedger: transition.field } as Partial<CampaignDeps>;
    }),
    addLocation: (loc) => set((s) => {
        const transition = locationTableSlice.add(s.locationLedger, loc);
        locationLedgerSave(transition.field);
        return { locationLedger: transition.field } as Partial<CampaignDeps>;
    }),
    updateLocation: (id, patch) => set((s) => {
        const transition = locationTableSlice.update(s.locationLedger, id, patch);
        locationLedgerSave(transition.field);
        return { locationLedger: transition.field } as Partial<CampaignDeps>;
    }),
    removeLocation: (id) => set((s) => {
        const transition = locationTableSlice.remove(s.locationLedger, id, {
            campaignId: s.activeCampaignId,
            state: s,
        });
        locationLedgerSave(transition.field);
        return { locationLedger: transition.field, ...transition.statePatch } as Partial<CampaignDeps>;
        // If the deleted entry was the current place, clear the pointer (do NOT silently
        // redirect — the player should re-anchor).
    }),
    locationSuggestions: [],
    addLocationSuggestions: (suggestions) => set((s) => {
        if (!suggestions || suggestions.length === 0) return {};
        const existing = new Set(s.locationSuggestions.map(x => x.name.toLowerCase()));
        const ledgerNames = new Set(
            s.locationLedger.flatMap(l => [l.name.toLowerCase(), ...l.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)])
        );
        const fresh: LocationSuggestion[] = [];
        for (const sug of suggestions) {
            const name = sug.name.trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (existing.has(key) || ledgerNames.has(key)) continue;
            existing.add(key);
            fresh.push({ ...sug, name });
        }
        if (fresh.length === 0) return {};
        return { locationSuggestions: [...s.locationSuggestions, ...fresh] } as Partial<CampaignDeps>;
    }),
    dismissLocationSuggestion: (name) => set((s) => ({
        locationSuggestions: s.locationSuggestions.filter(x => x.name.toLowerCase() !== name.toLowerCase()),
    }) as Partial<CampaignDeps>),
    clearLocationSuggestions: () => set({ locationSuggestions: [] } as Partial<CampaignDeps>),
    semanticFacts: [],
    setSemanticFacts: (facts) => set({ semanticFacts: facts } as Partial<CampaignDeps>),
    timeline: [],
    setTimeline: (events) => set({ timeline: events } as Partial<CampaignDeps>),
    addTimelineEvent: (event) => set((s) => ({ timeline: [...s.timeline, event] } as Partial<CampaignDeps>)),
    removeTimelineEvent: (eventId) => set((s) => ({ timeline: s.timeline.filter(e => e.id !== eventId) } as Partial<CampaignDeps>)),
    entities: [],
    setEntities: (entities) => set({ entities } as Partial<CampaignDeps>),
    pinnedChapterIds: [],
    pinChapter: (chapterId) => set((s) => {
        const already = s.pinnedChapterIds.includes(chapterId);
        return { pinnedChapterIds: already ? s.pinnedChapterIds.filter(id => id !== chapterId) : [...s.pinnedChapterIds, chapterId] } as Partial<CampaignDeps>;
    }),
    clearPinnedChapters: () => set({ pinnedChapterIds: [] } as Partial<CampaignDeps>),

    context: migrateLegacyContext({}),
    updateContext: (patch) =>
        set((s) => {
            const newContext = migrateLegacyContext({ ...s.context, ...patch });
            debouncedSaveCampaignState();
            return { context: newContext };
        }),

    inventoryItems: DEFAULT_INVENTORY,
    setInventoryItems: (items) => set((s) => {
        const normalized = (items || []).map(normalizeInventoryItem);
        const newContext = { ...s.context, inventoryItems: normalized };
        debouncedSaveCampaignState();
        return { context: newContext, inventoryItems: normalized } as Partial<CampaignDeps>;
    }),
    updateInventoryItem: (id, patch) => set((s) => {
        const newItems = s.inventoryItems.map(it => it.id === id ? normalizeInventoryItem({ ...it, ...patch }) : it);
        const newContext = { ...s.context, inventoryItems: newItems };
        debouncedSaveCampaignState();
        return { context: newContext, inventoryItems: newItems };
    }),
    removeInventoryItem: (id) => set((s) => {
        const newItems = s.inventoryItems.filter(it => it.id !== id);
        const newContext = { ...s.context, inventoryItems: newItems };
        debouncedSaveCampaignState();
        return { context: newContext, inventoryItems: newItems };
    }),
    addInventoryItem: (item) => set((s) => {
        const normalizedItem = normalizeInventoryItem(item);
        const newItems = [...s.inventoryItems, normalizedItem];
        const newContext = { ...s.context, inventoryItems: newItems };
        debouncedSaveCampaignState();
        return { context: newContext, inventoryItems: newItems };
    }),
    characterProfileData: DEFAULT_CHARACTER_PROFILE,
    setCharacterProfileData: (p) => set((s) => {
        const newContext = { ...s.context, characterProfileData: p };
        debouncedSaveCampaignState();
        return { context: newContext, characterProfileData: p } as Partial<CampaignDeps>;
    }),

    // ── Player Character (WO-A rewrite 2 §2) ─────────────────────────────
    // The PC lives at `context.playerCharacter`, persisted via the normal
    // debouncedSaveCampaignState path (it rides inside `context`). The slice
    // also keeps a top-level `playerCharacter` mirror for cheap selector access
    // that doesn't require destructuring `context`. Both are written together.
    playerCharacter: null,
    setPlayerCharacter: (pc) => set((s) => {
        const newContext = { ...s.context, playerCharacter: pc ?? null };
        debouncedSaveCampaignState();
        return { context: newContext, playerCharacter: pc } as Partial<CampaignDeps>;
    }),
    updatePlayerCharacter: (patch) => set((s) => {
        if (!s.playerCharacter) return {} as Partial<CampaignDeps>;
        const merged = { ...s.playerCharacter, ...patch };
        const newContext = { ...s.context, playerCharacter: merged };
        debouncedSaveCampaignState();
        return { context: newContext, playerCharacter: merged } as Partial<CampaignDeps>;
    }),

    // ── Mod tables (WO-P5-05) ───────────────────────────────────────────
    // One namespaced map, keyed by `mod.<modId>.<name>`. Hydration fills it
    // (campaignHydrator calls hydrateModTables); setModTable updates a single
    // entry AND fire-and-forgets a save through the dynamic mod-table route
    // (`/api/campaigns/:id/mod-tables/:table`). WO-P5-05 §4 promised
    // `storeAccessor: { write: true }` — without this fire-and-forget, the
    // generic mod-table machinery hydrated on load but never persisted on
    // write, so a mod that wrote its table through the store would silently
    // lose data on the next reload. Fixed here because Arc's state (WO-P5-12)
    // is the first consumer that round-trips real records through this path.
    modTables: {},
    setModTable: (name, data) => set((s) => {
        const modTables = { ...s.modTables, [name]: data };
        const campaignId = s.activeCampaignId;
        if (campaignId) {
            // Fire-and-forget; mirror the existing save accessors' contract
            // (saveLocationLedger/saveNPCLedger/etc. — none await in the
            // setter). A failed save logs but does not throw into the store.
            fetch(`${API}/campaigns/${campaignId}/mod-tables/${name}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            }).catch((e) => console.warn(`[modTables] save failed for ${name}:`, e));
        }
        return { modTables } as Partial<CampaignDeps>;
    }),
    getModTable: (name) => get().modTables[name],
    // Phase 6.4 — the local half of the clean action. No fetch here on
    // purpose: the destructive call is the server's DELETE, made once by
    // `cleanModData`, and duplicating it in a setter is how a toggle ends up
    // deleting data (`DATA_POLICY.md` §3 — clean never fires from a toggle).
    clearModTables: (modId) => set((s) => {
        const prefix = `mod.${modId}.`;
        const modTables: Record<string, unknown> = {};
        for (const [name, data] of Object.entries(s.modTables)) {
            if (!name.startsWith(prefix)) modTables[name] = data;
        }
        return { modTables } as Partial<CampaignDeps>;
    }),

    bookkeepingTurnCounter: 0,
    autoBookkeepingInterval: 5,
    setAutoBookkeepingInterval: (n) => set({ autoBookkeepingInterval: Math.max(1, n) } as Partial<CampaignDeps>),
    resetBookkeepingTurnCounter: () => set({ bookkeepingTurnCounter: 0 } as Partial<CampaignDeps>),
    incrementBookkeepingTurnCounter: () => {
        const current = get().bookkeepingTurnCounter + 1;
        set({ bookkeepingTurnCounter: current } as Partial<CampaignDeps>);
        return current;
    },
    }; // end of returned slice object
}; // end of createCampaignSlice