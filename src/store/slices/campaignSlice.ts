import type { StateCreator } from 'zustand';
import type { ArchiveChapter, ChatMessage, CondenserState, GameContext, LoreChunk, ArchiveIndexEntry, NPCEntry, SemanticFact } from '../../types';
import { toast } from '../../components/Toast';
import { debouncedSaveSettings } from './settingsSlice';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
} from './settingsSlice';

const API = '/api';

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
let _getStateForSave: (() => { activeCampaignId: string | null; context: GameContext; messages: ChatMessage[]; condenser: CondenserState }) | null = null;
export function _registerCampaignStateGetter(
    getter: () => { activeCampaignId: string | null; context: GameContext; messages: ChatMessage[]; condenser: CondenserState }
) {
    _getStateForSave = getter;
}

let stateTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced campaign state save. Always reads fresh state at fire time (no stale closures). */
export function debouncedSaveCampaignState() {
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
        if (!_getStateForSave) return;
        const { activeCampaignId, context, messages, condenser } = _getStateForSave();
        if (!activeCampaignId) return;
        fetch(`${API}/campaigns/${activeCampaignId}/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context, messages, condenser }),
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
export function dedupeNPCLedger(ledger: NPCEntry[]): NPCEntry[] {
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

    return ledger.filter((_, idx) => !removeIndices.has(idx));
}

// ── Default context ────────────────────────────────────────────────────

export const defaultContext: GameContext = {
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    characterProfile: '',
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    diceConfig: {
        catastrophe: 2,
        failure: 6,
        success: 15,
        triumph: 19,
        crit: 20
    },
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
    // --- AI Players (Enemy, Neutral, Ally) ---
    worldVibe: '',
    enemyPlayerActive: false,
    neutralPlayerActive: false,
    allyPlayerActive: false,
    enemyPlayerPrompt: 'You are the ENEMY AI. Inject narrative friction and opposition.',
    neutralPlayerPrompt: 'You are the NEUTRAL AI. Inject environmental chaos or third-party reactions.',
    allyPlayerPrompt: 'You are the ALLY AI. Inject narrative assistance and beneficial outcomes.',
    interventionChance: 25,
    enemyCooldown: 2,
    neutralCooldown: 2,
    allyCooldown: 2,
    interventionQueue: [],
    worldEventConfig: {
        initialDC: 498,
        dcReduction: 2,
        who: [...DEFAULT_WORLD_WHO],
        where: [...DEFAULT_WORLD_WHERE],
        why: [...DEFAULT_WORLD_WHY],
        what: [...DEFAULT_WORLD_WHAT],
    },
    coreMemorySlots: [],
};

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
    semanticFacts: SemanticFact[];
    setSemanticFacts: (facts: SemanticFact[]) => void;

    context: GameContext;
    updateContext: (patch: Partial<GameContext>) => void;
};

// ── Combined state needed for cross-slice access ───────────────────────

type CampaignDeps = CampaignSlice & {
    settings: import('../../types').AppSettings;
    messages: ChatMessage[];
    condenser: CondenserState;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createCampaignSlice: StateCreator<CampaignDeps, [], [], CampaignSlice> = (set, get) => {
    // Register a fresh-state getter so debouncedSaveCampaignState always writes current data,
    // not a stale closure snapshot from the time the action was called.
    _registerCampaignStateGetter(() => {
        const s = get();
        return { activeCampaignId: s.activeCampaignId, context: s.context, messages: s.messages, condenser: s.condenser };
    });

    return {
    activeCampaignId: null,
    setActiveCampaign: (id) => {
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
        const withNew = [...s.npcLedger, npc];
        const deduped = dedupeNPCLedger(withNew);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    addNPCs: (newNpcs) => set((s) => {
        const withNew = [...s.npcLedger, ...newNpcs];
        const deduped = dedupeNPCLedger(withNew);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    updateNPC: (id, patch) => set((s) => {
        const newLedger = s.npcLedger.map(n => n.id === id ? { ...n, ...patch } : n);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    removeNPC: (id) => set((s) => {
        preOpBackup(s.activeCampaignId, 'pre-delete-npc');
        const newLedger = s.npcLedger.filter(n => n.id !== id);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    semanticFacts: [],
    // Read-only hydration setter — facts are derived server-side from archive. No client persistence needed.
    setSemanticFacts: (facts) => set({ semanticFacts: facts } as Partial<CampaignDeps>),

    context: { ...defaultContext },
    updateContext: (patch) =>
        set((s) => {
            const newContext = { ...s.context, ...patch };
            debouncedSaveCampaignState();
            return { context: newContext };
        }),
    }; // end of returned slice object
}; // end of createCampaignSlice
