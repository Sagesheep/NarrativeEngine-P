import type { StateCreator } from 'zustand';
import type { ArchiveChapter, ChatMessage, CondenserState, GameContext, LoreChunk, ArchiveIndexEntry, NPCEntry, EnemyEntry, EnemyInstance, NpcSuggestion, SemanticFact, EntityEntry, TimelineEvent, InventoryItem, CharacterProfile, PinnedExcerpt, LocationEntry, LocationSuggestion } from '../../types';
import { DEFAULT_CHARACTER_PROFILE, DEFAULT_INVENTORY, migrateLegacyContext, buildDefaultDiceSystem, normalizeInventoryItem } from '../../types';
import { createEnemyInstance } from '../../services/enemy/enemyInstance';
import { normalizeRelations } from '../../services/npc/relationDedupe';
import { toast } from '../../components/Toast';
import { debouncedSaveSettings } from './settingsSlice';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
} from './settingsSlice';

import { API_BASE as API } from '../../lib/apiBase';

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
let _getStateForSave: (() => { activeCampaignId: string | null; context: GameContext; messages: ChatMessage[]; condenser: CondenserState; loreChunks: LoreChunk[]; npcLedger: NPCEntry[]; enemyCompendium: EnemyEntry[]; enemyInstances: EnemyInstance[]; locationLedger: LocationEntry[]; pinnedExcerpts: PinnedExcerpt[] }) | null = null;
export function _registerCampaignStateGetter(
    getter: () => { activeCampaignId: string | null; context: GameContext; messages: ChatMessage[]; condenser: CondenserState; loreChunks: LoreChunk[]; npcLedger: NPCEntry[]; enemyCompendium: EnemyEntry[]; enemyInstances: EnemyInstance[]; locationLedger: LocationEntry[]; pinnedExcerpts: PinnedExcerpt[] }
) {
    _getStateForSave = getter;
}

let stateTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelPendingSaves() {
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    if (loreTimer)  { clearTimeout(loreTimer);  loreTimer  = null; }
    if (npcTimer)   { clearTimeout(npcTimer);   npcTimer   = null; }
    if (enemyTimer) { clearTimeout(enemyTimer); enemyTimer = null; }
    if (enemyInstanceTimer) { clearTimeout(enemyInstanceTimer); enemyInstanceTimer = null; }
    if (locationTimer) { clearTimeout(locationTimer); locationTimer = null; }
}

/** Immediately fires any pending debounced saves so the latest in-memory state is on
 *  disk before a backup is created. Awaiting this guarantees the backup reads current data. */
export async function flushAllPendingSaves(): Promise<void> {
    if (!_getStateForSave) return;
    const { activeCampaignId, context, messages, condenser, loreChunks, npcLedger, enemyCompendium, enemyInstances, locationLedger, pinnedExcerpts } = _getStateForSave();
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

    if (enemyTimer) {
        clearTimeout(enemyTimer);
        enemyTimer = null;
        saves.push(fetch(`${API}/campaigns/${activeCampaignId}/enemies`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enemyCompendium),
        }).catch(e => console.error('[FlushSave] enemies failed:', e)));
    }

    if (enemyInstanceTimer) {
        clearTimeout(enemyInstanceTimer);
        enemyInstanceTimer = null;
        saves.push(fetch(`${API}/campaigns/${activeCampaignId}/enemy-instances`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enemyInstances),
        }).catch(e => console.error('[FlushSave] enemy instances failed:', e)));
    }

    if (locationTimer) {
        clearTimeout(locationTimer);
        locationTimer = null;
        saves.push(
            fetch(`${API}/campaigns/${activeCampaignId}/locations`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(locationLedger),
            }).catch(e => console.error('[FlushSave] locations failed:', e))
        );
    }

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

let enemyTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveEnemyCompendium(campaignId: string | null, enemies: EnemyEntry[]) {
    if (!campaignId) return;
    if (enemyTimer) clearTimeout(enemyTimer);
    enemyTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/enemies`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enemies),
        }).catch((e) => { console.error(e); toast.error('Failed to save enemy compendium'); });
    }, 1000);
}

let enemyInstanceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveEnemyInstances(campaignId: string | null, instances: EnemyInstance[]) {
    if (!campaignId) return;
    if (enemyInstanceTimer) clearTimeout(enemyInstanceTimer);
    enemyInstanceTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/enemy-instances`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(instances),
        }).catch((e) => { console.error(e); toast.error('Failed to save enemy instances'); });
    }, 1000);
}

let locationTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveLocationLedger(campaignId: string | null, locations: LocationEntry[]) {
    if (!campaignId) return;
    if (locationTimer) clearTimeout(locationTimer);
    locationTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/locations`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(locations),
        }).catch((e) => { console.error(e); toast.error('Failed to save location ledger'); });
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
    enemyCompendium: EnemyEntry[];
    setEnemyCompendium: (enemies: EnemyEntry[]) => void;
    addEnemy: (enemy: EnemyEntry) => void;
    updateEnemy: (id: string, patch: Partial<EnemyEntry>) => void;
    removeEnemy: (id: string) => void;
    enemyInstances: EnemyInstance[];
    setEnemyInstances: (instances: EnemyInstance[]) => void;
    spawnEnemyInstance: (templateId: string) => EnemyInstance | null;
    updateEnemyInstance: (id: string, patch: Partial<EnemyInstance>) => void;
    removeEnemyInstance: (id: string) => void;
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
};

// ── Combined state needed for cross-slice access ───────────────────────

type CampaignDeps = CampaignSlice & {
    settings: import('../../types').AppSettings;
    messages: ChatMessage[];
    condenser: CondenserState;
    pinnedExcerpts: PinnedExcerpt[];
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createCampaignSlice: StateCreator<CampaignDeps, [], [], CampaignSlice> = (set, get) => {
    // Register a fresh-state getter so debouncedSaveCampaignState always writes current data,
    // not a stale closure snapshot from the time the action was called.
    _registerCampaignStateGetter(() => {
        const s = get();
        return { activeCampaignId: s.activeCampaignId, context: s.context, messages: s.messages, condenser: s.condenser, loreChunks: s.loreChunks, npcLedger: s.npcLedger, enemyCompendium: s.enemyCompendium, enemyInstances: s.enemyInstances, locationLedger: s.locationLedger, pinnedExcerpts: s.pinnedExcerpts };
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
    enemyCompendium: [],
    setEnemyCompendium: (enemies) => set((s) => {
        debouncedSaveEnemyCompendium(s.activeCampaignId, enemies);
        return { enemyCompendium: enemies } as Partial<CampaignDeps>;
    }),
    addEnemy: (enemy) => set((s) => {
        const enemies = [...s.enemyCompendium, enemy];
        debouncedSaveEnemyCompendium(s.activeCampaignId, enemies);
        return { enemyCompendium: enemies } as Partial<CampaignDeps>;
    }),
    updateEnemy: (id, patch) => set((s) => {
        const enemies = s.enemyCompendium.map(e => e.id === id ? { ...e, ...patch, updatedAt: Date.now() } : e);
        debouncedSaveEnemyCompendium(s.activeCampaignId, enemies);
        return { enemyCompendium: enemies } as Partial<CampaignDeps>;
    }),
    removeEnemy: (id) => set((s) => {
        preOpBackup(s.activeCampaignId, 'pre-delete-enemy');
        const enemies = s.enemyCompendium.filter(e => e.id !== id);
        debouncedSaveEnemyCompendium(s.activeCampaignId, enemies);
        return { enemyCompendium: enemies } as Partial<CampaignDeps>;
    }),
    enemyInstances: [],
    setEnemyInstances: (instances) => set((s) => {
        debouncedSaveEnemyInstances(s.activeCampaignId, instances);
        return { enemyInstances: instances } as Partial<CampaignDeps>;
    }),
    spawnEnemyInstance: (templateId) => {
        const s = get();
        const template = s.enemyCompendium.find(enemy => enemy.id === templateId);
        if (!template) return null;
        const instance = createEnemyInstance(template, s.enemyInstances);
        const instances = [...s.enemyInstances, instance];
        debouncedSaveEnemyInstances(s.activeCampaignId, instances);
        set({ enemyInstances: instances } as Partial<CampaignDeps>);
        return instance;
    },
    updateEnemyInstance: (id, patch) => set((s) => {
        const instances = s.enemyInstances.map(instance =>
            instance.id === id ? { ...instance, ...patch, updatedAt: Date.now() } : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, instances);
        return { enemyInstances: instances } as Partial<CampaignDeps>;
    }),
    removeEnemyInstance: (id) => set((s) => {
        const instances = s.enemyInstances.filter(instance => instance.id !== id);
        debouncedSaveEnemyInstances(s.activeCampaignId, instances);
        return { enemyInstances: instances } as Partial<CampaignDeps>;
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
    locationLedger: [],
    setLocationLedger: (locations) => set((s) => {
        debouncedSaveLocationLedger(s.activeCampaignId, locations);
        return { locationLedger: locations } as Partial<CampaignDeps>;
    }),
    addLocation: (loc) => set((s) => {
        const withNew = [...s.locationLedger, loc];
        debouncedSaveLocationLedger(s.activeCampaignId, withNew);
        return { locationLedger: withNew } as Partial<CampaignDeps>;
    }),
    updateLocation: (id, patch) => set((s) => {
        const newLedger = s.locationLedger.map(l => l.id === id ? { ...l, ...patch } : l);
        debouncedSaveLocationLedger(s.activeCampaignId, newLedger);
        return { locationLedger: newLedger } as Partial<CampaignDeps>;
    }),
    removeLocation: (id) => set((s) => {
        preOpBackup(s.activeCampaignId, 'pre-delete-location');
        const newLedger = s.locationLedger.filter(l => l.id !== id);
        debouncedSaveLocationLedger(s.activeCampaignId, newLedger);
        // If the deleted entry was the current place, clear the pointer (do NOT silently
        // redirect — the player should re-anchor).
        const ctx = s.context;
        let contextPatch: Partial<GameContext> | undefined;
        if (ctx.currentPlaceId === id) {
            contextPatch = { currentPlaceId: null, currentFeature: null };
        }
        if (contextPatch) {
            const newContext = migrateLegacyContext({ ...ctx, ...contextPatch });
            debouncedSaveCampaignState();
            return { locationLedger: newLedger, context: newContext } as Partial<CampaignDeps>;
        }
        return { locationLedger: newLedger } as Partial<CampaignDeps>;
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
