import type { StateCreator } from 'zustand';
import type { ArchiveChapter, ChatMessage, CondenserState, GameContext, LoreChunk, ArchiveIndexEntry, NPCEntry, EnemyEntry, AbilityEntry, EnemyInstance, EnemyEncounter, EnemyEncounterResolution, EnemyEncounterStatus, EnemyEncounterWave, EnemyCombatConfig, EnemySuggestion, NpcSuggestion, SemanticFact, EntityEntry, TimelineEvent, InventoryItem, CharacterProfile, PinnedExcerpt, LocationEntry, LocationSuggestion } from '../../types';
import { DEFAULT_CHARACTER_PROFILE, DEFAULT_INVENTORY, migrateLegacyContext, buildDefaultDiceSystem, normalizeInventoryItem } from '../../types';
import { createEnemyInstance } from '../../services/enemy/enemyInstance';
import { createEnemyEncounter as makeEnemyEncounter, createEnemyEncounterWave } from '../../services/enemy/enemyEncounter';
import {
    DEFAULT_ENEMY_COMBAT_CONFIG,
    addEnemyResource as addCombatResource,
    adjustEnemyResource as adjustCombatResource,
    applyEnemyDamage as resolveEnemyDamage,
    beginEnemyTurn as resolveEnemyTurnStart,
    normalizeEnemyCombatConfig,
    rollEnemyInitiative as resolveEnemyInitiative,
    spendEnemyAction as resolveEnemyAction,
    type EnemyDamageResult,
} from '../../services/enemy/enemyCombat';
import {
    buildEnemyResolutionTimelineEvent,
    createEnemyEncounterResolution,
    getEncounterInstances,
    type EnemyResolutionDraft,
} from '../../services/enemy/enemyResolution';
import { canonicalEnemyName } from '../../services/enemy/enemySchema';
import {
    addTimelineEvent as persistTimelineEvent,
    saveEnemyEncounters,
    saveEnemyInstances,
    saveEnemyResolutions,
} from '../campaignStore';
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
let _getStateForSave: (() => { activeCampaignId: string | null; context: GameContext; messages: ChatMessage[]; condenser: CondenserState; loreChunks: LoreChunk[]; npcLedger: NPCEntry[]; enemyCompendium: EnemyEntry[]; abilityCompendium: AbilityEntry[]; enemyInstances: EnemyInstance[]; enemyEncounters: EnemyEncounter[]; enemyCombatConfig: EnemyCombatConfig; locationLedger: LocationEntry[]; pinnedExcerpts: PinnedExcerpt[] }) | null = null;
export function _registerCampaignStateGetter(
    getter: () => { activeCampaignId: string | null; context: GameContext; messages: ChatMessage[]; condenser: CondenserState; loreChunks: LoreChunk[]; npcLedger: NPCEntry[]; enemyCompendium: EnemyEntry[]; abilityCompendium: AbilityEntry[]; enemyInstances: EnemyInstance[]; enemyEncounters: EnemyEncounter[]; enemyCombatConfig: EnemyCombatConfig; locationLedger: LocationEntry[]; pinnedExcerpts: PinnedExcerpt[] }
) {
    _getStateForSave = getter;
}

let stateTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelPendingSaves() {
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    if (loreTimer)  { clearTimeout(loreTimer);  loreTimer  = null; }
    if (npcTimer)   { clearTimeout(npcTimer);   npcTimer   = null; }
    if (enemyTimer) { clearTimeout(enemyTimer); enemyTimer = null; }
    if (abilityTimer) { clearTimeout(abilityTimer); abilityTimer = null; }
    if (enemyInstanceTimer) { clearTimeout(enemyInstanceTimer); enemyInstanceTimer = null; }
    if (enemyEncounterTimer) { clearTimeout(enemyEncounterTimer); enemyEncounterTimer = null; }
    if (enemyCombatTimer) { clearTimeout(enemyCombatTimer); enemyCombatTimer = null; }
    if (locationTimer) { clearTimeout(locationTimer); locationTimer = null; }
}

/** Immediately fires any pending debounced saves so the latest in-memory state is on
 *  disk before a backup is created. Awaiting this guarantees the backup reads current data. */
export async function flushAllPendingSaves(): Promise<void> {
    if (!_getStateForSave) return;
    const { activeCampaignId, context, messages, condenser, loreChunks, npcLedger, enemyCompendium, abilityCompendium, enemyInstances, enemyEncounters, enemyCombatConfig, locationLedger, pinnedExcerpts } = _getStateForSave();
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

    if (abilityTimer) {
        clearTimeout(abilityTimer);
        abilityTimer = null;
        saves.push(fetch(`${API}/campaigns/${activeCampaignId}/abilities`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(abilityCompendium),
        }).catch(e => console.error('[FlushSave] abilities failed:', e)));
    }

    if (enemyInstanceTimer) {
        clearTimeout(enemyInstanceTimer);
        enemyInstanceTimer = null;
        saves.push(fetch(`${API}/campaigns/${activeCampaignId}/enemy-instances`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enemyInstances),
        }).catch(e => console.error('[FlushSave] enemy instances failed:', e)));
    }

    if (enemyEncounterTimer) {
        clearTimeout(enemyEncounterTimer);
        enemyEncounterTimer = null;
        saves.push(fetch(`${API}/campaigns/${activeCampaignId}/enemy-encounters`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enemyEncounters),
        }).catch(e => console.error('[FlushSave] enemy encounters failed:', e)));
    }

    if (enemyCombatTimer) {
        clearTimeout(enemyCombatTimer);
        enemyCombatTimer = null;
        saves.push(fetch(`${API}/campaigns/${activeCampaignId}/enemy-combat`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(enemyCombatConfig),
        }).catch(e => console.error('[FlushSave] enemy combat config failed:', e)));
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

let abilityTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveAbilityCompendium(campaignId: string | null, abilities: AbilityEntry[]) {
    if (!campaignId) return;
    if (abilityTimer) clearTimeout(abilityTimer);
    abilityTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/abilities`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(abilities),
        }).catch((error) => { console.error(error); toast.error('Failed to save ability compendium'); });
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

let enemyEncounterTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveEnemyEncounters(campaignId: string | null, encounters: EnemyEncounter[]) {
    if (!campaignId) return;
    if (enemyEncounterTimer) clearTimeout(enemyEncounterTimer);
    enemyEncounterTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/enemy-encounters`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(encounters),
        }).catch((e) => { console.error(e); toast.error('Failed to save enemy encounters'); });
    }, 1000);
}

let enemyCombatTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveEnemyCombatConfig(campaignId: string | null, config: EnemyCombatConfig) {
    if (!campaignId) return;
    if (enemyCombatTimer) clearTimeout(enemyCombatTimer);
    enemyCombatTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/enemy-combat`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        }).catch((e) => { console.error(e); toast.error('Failed to save enemy combat configuration'); });
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
    abilityCompendium: AbilityEntry[];
    setAbilityCompendium: (abilities: AbilityEntry[]) => void;
    addAbility: (ability: AbilityEntry) => void;
    updateAbility: (id: string, patch: Partial<AbilityEntry>) => void;
    removeAbility: (id: string) => void;
    enemySuggestions: EnemySuggestion[];
    addEnemySuggestions: (suggestions: Array<Omit<EnemySuggestion, 'id' | 'firstSeen' | 'context'>>, context?: string) => void;
    updateEnemySuggestion: (id: string, patch: Partial<EnemySuggestion>) => void;
    dismissEnemySuggestion: (id: string) => void;
    clearEnemySuggestions: () => void;
    enemyInstances: EnemyInstance[];
    setEnemyInstances: (instances: EnemyInstance[]) => void;
    spawnEnemyInstance: (templateId: string) => EnemyInstance | null;
    updateEnemyInstance: (id: string, patch: Partial<EnemyInstance>) => void;
    removeEnemyInstance: (id: string) => void;
    enemyEncounters: EnemyEncounter[];
    setEnemyEncounters: (encounters: EnemyEncounter[]) => void;
    createEnemyEncounter: (name: string) => EnemyEncounter;
    updateEnemyEncounter: (id: string, patch: Partial<EnemyEncounter>) => void;
    addEnemyEncounterWave: (encounterId: string) => EnemyEncounterWave | null;
    updateEnemyEncounterWave: (encounterId: string, waveId: string, patch: Partial<EnemyEncounterWave>) => void;
    setEnemyEncounterStatus: (id: string, status: EnemyEncounterStatus) => void;
    setEnemyEncounterInstanceAssigned: (encounterId: string, waveId: string, instanceId: string, assigned: boolean) => void;
    setEnemyEncounterInstanceActive: (encounterId: string, waveId: string, instanceId: string, active: boolean) => void;
    addEnemyReinforcement: (encounterId: string, waveId: string, templateId: string) => EnemyInstance | null;
    enemyResolutions: EnemyEncounterResolution[];
    resolveEnemyEncounter: (encounterId: string, draft: EnemyResolutionDraft) => Promise<EnemyEncounterResolution | null>;
    enemyCombatConfig: EnemyCombatConfig;
    setEnemyCombatConfig: (patch: Partial<EnemyCombatConfig>) => void;
    applyEnemyDamage: (id: string, amount: number, damageType: string, bypassBarrier?: boolean) => EnemyDamageResult | null;
    rollEnemyInitiatives: (instanceIds: string[]) => void;
    setEnemyInitiative: (id: string, initiative: number | null) => void;
    beginEnemyTurn: (id: string) => void;
    spendEnemyAction: (id: string, actionName: string, cooldownRounds: number) => void;
    addEnemyResource: (id: string, name: string, max: number) => void;
    adjustEnemyResource: (id: string, resourceId: string, delta: number) => void;
    removeEnemyResource: (id: string, resourceId: string) => void;
    clearEnemyCooldown: (id: string, cooldownId: string) => void;
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
        return { activeCampaignId: s.activeCampaignId, context: s.context, messages: s.messages, condenser: s.condenser, loreChunks: s.loreChunks, npcLedger: s.npcLedger, enemyCompendium: s.enemyCompendium, abilityCompendium: s.abilityCompendium, enemyInstances: s.enemyInstances, enemyEncounters: s.enemyEncounters, enemyCombatConfig: s.enemyCombatConfig, locationLedger: s.locationLedger, pinnedExcerpts: s.pinnedExcerpts };
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
            // Enemy discovery single-flight + cooldown state is per-campaign. Clear
            // the old campaign's in-flight flag so a reopened campaign is not
            // permanently blocked by a stale flag from a closed/switched-away one.
            try {
                const { clearEnemyDiscoveryState } = await import('../../services/turn/postTurnPipeline');
                clearEnemyDiscoveryState(currentId);
            } catch (e) {
                console.warn('[CampaignSwitch] clearEnemyDiscoveryState failed:', e);
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
    abilityCompendium: [],
    setAbilityCompendium: (abilities) => set((s) => {
        debouncedSaveAbilityCompendium(s.activeCampaignId, abilities);
        return { abilityCompendium: abilities } as Partial<CampaignDeps>;
    }),
    addAbility: (ability) => set((s) => {
        const abilities = [...s.abilityCompendium, ability];
        debouncedSaveAbilityCompendium(s.activeCampaignId, abilities);
        return { abilityCompendium: abilities } as Partial<CampaignDeps>;
    }),
    updateAbility: (id, patch) => set((s) => {
        const abilities = s.abilityCompendium.map(ability =>
            ability.id === id ? { ...ability, ...patch, updatedAt: Date.now() } : ability);
        debouncedSaveAbilityCompendium(s.activeCampaignId, abilities);
        return { abilityCompendium: abilities } as Partial<CampaignDeps>;
    }),
    removeAbility: (id) => set((s) => {
        preOpBackup(s.activeCampaignId, 'pre-delete-ability');
        const abilities = s.abilityCompendium.filter(ability => ability.id !== id);
        debouncedSaveAbilityCompendium(s.activeCampaignId, abilities);
        return { abilityCompendium: abilities } as Partial<CampaignDeps>;
    }),
    // Review-only discoveries. Nothing enters the canonical compendium until
    // the player accepts it in EnemyCompendiumModal.
    enemySuggestions: [],
    addEnemySuggestions: (suggestions, context) => set((s) => {
        const knownNames = new Set(s.enemyCompendium.flatMap(enemy =>
            [enemy.name, ...(enemy.aliases || '').split(',')].map(canonicalEnemyName).filter(Boolean)));
        const existing = new Set(s.enemySuggestions.map(suggestion =>
            `${suggestion.kind}:${suggestion.targetEnemyId ?? ''}:${canonicalEnemyName(suggestion.name)}`));
        const now = Date.now();
        const fresh: EnemySuggestion[] = [];

        for (const suggestion of suggestions) {
            const name = suggestion.name.trim();
            const nameKey = canonicalEnemyName(name);
            if (!nameKey || knownNames.has(nameKey)) continue;
            if (suggestion.kind === 'alias' && !s.enemyCompendium.some(enemy => enemy.id === suggestion.targetEnemyId)) continue;
            const key = `${suggestion.kind}:${suggestion.targetEnemyId ?? ''}:${nameKey}`;
            if (existing.has(key)) continue;
            existing.add(key);
            fresh.push({
                ...suggestion,
                id: crypto.randomUUID(),
                name,
                context: context?.slice(-500),
                firstSeen: now,
            });
            if (fresh.length + s.enemySuggestions.length >= 30) break;
        }
        return fresh.length
            ? { enemySuggestions: [...s.enemySuggestions, ...fresh] } as Partial<CampaignDeps>
            : {};
    }),
    updateEnemySuggestion: (id, patch) => set((s) => ({
        enemySuggestions: s.enemySuggestions.map(suggestion =>
            suggestion.id === id ? { ...suggestion, ...patch } : suggestion),
    }) as Partial<CampaignDeps>),
    dismissEnemySuggestion: (id) => set((s) => ({
        enemySuggestions: s.enemySuggestions.filter(suggestion => suggestion.id !== id),
    }) as Partial<CampaignDeps>),
    clearEnemySuggestions: () => set({ enemySuggestions: [] } as Partial<CampaignDeps>),
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
        const now = Date.now();
        const encounters = s.enemyEncounters.map(encounter => ({
            ...encounter,
            waves: encounter.waves.map(wave => ({
                ...wave,
                instanceIds: wave.instanceIds.filter(instanceId => instanceId !== id),
                activeInstanceIds: wave.activeInstanceIds.filter(instanceId => instanceId !== id),
                updatedAt: now,
            })),
            updatedAt: now,
        }));
        debouncedSaveEnemyInstances(s.activeCampaignId, instances);
        debouncedSaveEnemyEncounters(s.activeCampaignId, encounters);
        return { enemyInstances: instances, enemyEncounters: encounters } as Partial<CampaignDeps>;
    }),
    enemyEncounters: [],
    setEnemyEncounters: (encounters) => set((s) => {
        debouncedSaveEnemyEncounters(s.activeCampaignId, encounters);
        return { enemyEncounters: encounters } as Partial<CampaignDeps>;
    }),
    createEnemyEncounter: (name) => {
        const s = get();
        const now = Date.now();
        const encounter = makeEnemyEncounter(name, now);
        const encounters = [
            ...s.enemyEncounters.map(existing =>
                existing.status === 'active'
                    ? { ...existing, status: 'paused' as const, updatedAt: now }
                    : existing
            ),
            encounter,
        ];
        debouncedSaveEnemyEncounters(s.activeCampaignId, encounters);
        set({ enemyEncounters: encounters } as Partial<CampaignDeps>);
        return encounter;
    },
    updateEnemyEncounter: (id, patch) => set((s) => {
        const encounters = s.enemyEncounters.map(encounter =>
            encounter.id === id ? { ...encounter, ...patch, updatedAt: Date.now() } : encounter
        );
        debouncedSaveEnemyEncounters(s.activeCampaignId, encounters);
        return { enemyEncounters: encounters } as Partial<CampaignDeps>;
    }),
    addEnemyEncounterWave: (encounterId) => {
        const s = get();
        const encounter = s.enemyEncounters.find(candidate => candidate.id === encounterId);
        if (!encounter) return null;
        const now = Date.now();
        const wave = createEnemyEncounterWave(encounter.waves.length + 1, now);
        const encounters = s.enemyEncounters.map(candidate =>
            candidate.id === encounterId
                ? { ...candidate, waves: [...candidate.waves, wave], activeWaveId: wave.id, updatedAt: now }
                : candidate
        );
        debouncedSaveEnemyEncounters(s.activeCampaignId, encounters);
        set({ enemyEncounters: encounters } as Partial<CampaignDeps>);
        return wave;
    },
    updateEnemyEncounterWave: (encounterId, waveId, patch) => set((s) => {
        const now = Date.now();
        const encounters = s.enemyEncounters.map(encounter =>
            encounter.id === encounterId
                ? {
                    ...encounter,
                    waves: encounter.waves.map(wave =>
                        wave.id === waveId ? { ...wave, ...patch, updatedAt: now } : wave
                    ),
                    updatedAt: now,
                }
                : encounter
        );
        debouncedSaveEnemyEncounters(s.activeCampaignId, encounters);
        return { enemyEncounters: encounters } as Partial<CampaignDeps>;
    }),
    setEnemyEncounterStatus: (id, status) => {
        const s = get();
        const target = s.enemyEncounters.find(encounter => encounter.id === id);
        if (!target || (target.resolutionId && status !== 'ended')) return;
        const now = Date.now();
        const encounters = s.enemyEncounters.map(encounter => {
            if (status === 'active' && encounter.id !== id && encounter.status === 'active') {
                return { ...encounter, status: 'paused' as const, updatedAt: now };
            }
            if (encounter.id !== id) return encounter;
            return {
                ...encounter,
                status,
                updatedAt: now,
                endedAt: status === 'ended' ? now : undefined,
            };
        });
        debouncedSaveEnemyEncounters(s.activeCampaignId, encounters);
        set({ enemyEncounters: encounters } as Partial<CampaignDeps>);
    },
    setEnemyEncounterInstanceAssigned: (encounterId, waveId, instanceId, assigned) => {
        const s = get();
        const encounter = s.enemyEncounters.find(candidate => candidate.id === encounterId);
        const wave = encounter?.waves.find(candidate => candidate.id === waveId);
        if (!encounter || !wave) return;
        const instanceIds = assigned
            ? [...new Set([...wave.instanceIds, instanceId])]
            : wave.instanceIds.filter(id => id !== instanceId);
        const activeInstanceIds = assigned
            ? wave.activeInstanceIds
            : wave.activeInstanceIds.filter(id => id !== instanceId);
        get().updateEnemyEncounterWave(encounterId, waveId, { instanceIds, activeInstanceIds });
    },
    setEnemyEncounterInstanceActive: (encounterId, waveId, instanceId, active) => {
        const s = get();
        const encounter = s.enemyEncounters.find(candidate => candidate.id === encounterId);
        const wave = encounter?.waves.find(candidate => candidate.id === waveId);
        if (!encounter || !wave || !wave.instanceIds.includes(instanceId)) return;
        const activeInstanceIds = active
            ? [...new Set([...wave.activeInstanceIds, instanceId])]
            : wave.activeInstanceIds.filter(id => id !== instanceId);
        get().updateEnemyEncounterWave(encounterId, waveId, { activeInstanceIds });
    },
    addEnemyReinforcement: (encounterId, waveId, templateId) => {
        const s = get();
        const template = s.enemyCompendium.find(enemy => enemy.id === templateId);
        const encounter = s.enemyEncounters.find(candidate => candidate.id === encounterId);
        const wave = encounter?.waves.find(candidate => candidate.id === waveId);
        if (!template || !encounter || !wave) return null;
        const instance = createEnemyInstance(template, s.enemyInstances);
        const instances = [...s.enemyInstances, instance];
        const now = Date.now();
        const encounters = s.enemyEncounters.map(candidate =>
            candidate.id === encounterId
                ? {
                    ...candidate,
                    waves: candidate.waves.map(candidateWave =>
                        candidateWave.id === waveId
                            ? {
                                ...candidateWave,
                                instanceIds: [...new Set([...candidateWave.instanceIds, instance.id])],
                                activeInstanceIds: [...new Set([...candidateWave.activeInstanceIds, instance.id])],
                                updatedAt: now,
                            }
                            : candidateWave
                    ),
                    updatedAt: now,
                }
                : candidate
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, instances);
        debouncedSaveEnemyEncounters(s.activeCampaignId, encounters);
        set({ enemyInstances: instances, enemyEncounters: encounters } as Partial<CampaignDeps>);
        return instance;
    },
    enemyResolutions: [],
    resolveEnemyEncounter: async (encounterId, draft) => {
        const s = get();
        const encounter = s.enemyEncounters.find(candidate => candidate.id === encounterId);
        if (!encounter || encounter.resolutionId) return null;

        const campaignId = s.activeCampaignId;
        preOpBackup(campaignId, 'pre-resolve-enemy-encounter');
        // The resolution writes authoritative arrays immediately. Cancel older
        // debounced snapshots so they cannot overwrite the cleaned instance pool.
        if (enemyInstanceTimer) { clearTimeout(enemyInstanceTimer); enemyInstanceTimer = null; }
        if (enemyEncounterTimer) { clearTimeout(enemyEncounterTimer); enemyEncounterTimer = null; }
        const now = Date.now();
        const resolution = createEnemyEncounterResolution(encounter, s.enemyInstances, draft, now);
        const resolvedInstanceIds = new Set(
            getEncounterInstances(encounter, s.enemyInstances).map(instance => instance.id),
        );
        const enemyInstances = s.enemyInstances.filter(instance => !resolvedInstanceIds.has(instance.id));
        const enemyEncounters = s.enemyEncounters.map(candidate => {
            let changed = candidate.id === encounterId;
            const waves = candidate.waves.map(wave => {
                const waveChanged = wave.instanceIds.some(id => resolvedInstanceIds.has(id))
                    || wave.activeInstanceIds.some(id => resolvedInstanceIds.has(id));
                if (!waveChanged) return wave;
                changed = true;
                return {
                    ...wave,
                    instanceIds: wave.instanceIds.filter(id => !resolvedInstanceIds.has(id)),
                    activeInstanceIds: wave.activeInstanceIds.filter(id => !resolvedInstanceIds.has(id)),
                    updatedAt: now,
                };
            });
            if (!changed) return candidate;
            return {
                ...candidate,
                waves,
                ...(candidate.id === encounterId
                    ? { status: 'ended' as const, endedAt: now, resolutionId: resolution.id }
                    : {}),
                updatedAt: now,
            };
        });
        let enemyResolutions = [...s.enemyResolutions, resolution];

        set({ enemyInstances, enemyEncounters, enemyResolutions } as Partial<CampaignDeps>);

        if (campaignId) {
            try {
                await Promise.all([
                    saveEnemyInstances(campaignId, enemyInstances),
                    saveEnemyEncounters(campaignId, enemyEncounters),
                    saveEnemyResolutions(campaignId, enemyResolutions),
                ]);
            } catch (error) {
                console.error('[Enemy Resolution] Failed to persist resolution state:', error);
                toast.error('Encounter resolved locally, but saving failed');
            }
        }

        if (draft.createTimelineEvent && campaignId) {
            let timelineEvent: TimelineEvent | undefined;
            try {
                timelineEvent = await persistTimelineEvent(
                    campaignId,
                    buildEnemyResolutionTimelineEvent(
                        resolution,
                        s.archiveIndex.at(-1)?.sceneId ?? '000',
                        s.chapters.find(chapter => !chapter.sealedAt)?.chapterId ?? 'CH00',
                    ),
                );
            } catch (error) {
                console.error('[Enemy Resolution] Failed to create timeline event:', error);
            }
            if (timelineEvent) {
                enemyResolutions = enemyResolutions.map(candidate =>
                    candidate.id === resolution.id
                        ? { ...candidate, timelineEventId: timelineEvent.id }
                        : candidate
                );
                if (get().activeCampaignId === campaignId) {
                    set((current) => ({
                        enemyResolutions,
                        timeline: current.timeline.some(event => event.id === timelineEvent.id)
                            ? current.timeline
                            : [...current.timeline, timelineEvent],
                    }) as Partial<CampaignDeps>);
                }
                try {
                    await saveEnemyResolutions(campaignId, enemyResolutions);
                } catch (error) {
                    console.error('[Enemy Resolution] Failed to link timeline event:', error);
                }
                return enemyResolutions.find(candidate => candidate.id === resolution.id) ?? resolution;
            }
        }

        return resolution;
    },
    enemyCombatConfig: { ...DEFAULT_ENEMY_COMBAT_CONFIG },
    setEnemyCombatConfig: (patch) => set((s) => {
        const enemyCombatConfig = normalizeEnemyCombatConfig({ ...s.enemyCombatConfig, ...patch });
        debouncedSaveEnemyCombatConfig(s.activeCampaignId, enemyCombatConfig);
        return { enemyCombatConfig } as Partial<CampaignDeps>;
    }),
    applyEnemyDamage: (id, amount, damageType, bypassBarrier = false) => {
        const s = get();
        const target = s.enemyInstances.find(instance => instance.id === id);
        if (!target) return null;
        const resolved = resolveEnemyDamage(target, amount, damageType, s.enemyCombatConfig, bypassBarrier);
        if (resolved.instance !== target) {
            const enemyInstances = s.enemyInstances.map(instance =>
                instance.id === id ? resolved.instance : instance
            );
            debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
            set({ enemyInstances } as Partial<CampaignDeps>);
        }
        return resolved.result;
    },
    rollEnemyInitiatives: (ids) => set((s) => {
        const targets = new Set(ids);
        const enemyInstances = s.enemyInstances.map(instance =>
            targets.has(instance.id)
                ? resolveEnemyInitiative(instance, s.enemyCombatConfig)
                : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
        return { enemyInstances } as Partial<CampaignDeps>;
    }),
    setEnemyInitiative: (id, initiative) => set((s) => {
        if (!s.enemyCombatConfig.enabled) return {};
        const enemyInstances = s.enemyInstances.map(instance =>
            instance.id === id
                ? { ...instance, initiative: Number.isFinite(initiative) ? initiative : null, updatedAt: Date.now() }
                : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
        return { enemyInstances } as Partial<CampaignDeps>;
    }),
    beginEnemyTurn: (id) => set((s) => {
        const enemyInstances = s.enemyInstances.map(instance =>
            instance.id === id ? resolveEnemyTurnStart(instance, s.enemyCombatConfig) : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
        return { enemyInstances } as Partial<CampaignDeps>;
    }),
    spendEnemyAction: (id, actionName, cooldownRounds = 0) => set((s) => {
        const enemyInstances = s.enemyInstances.map(instance =>
            instance.id === id
                ? resolveEnemyAction(instance, actionName, cooldownRounds, s.enemyCombatConfig)
                : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
        return { enemyInstances } as Partial<CampaignDeps>;
    }),
    addEnemyResource: (id, name, max) => set((s) => {
        if (!s.enemyCombatConfig.enabled || !s.enemyCombatConfig.resourcesEnabled) return {};
        const enemyInstances = s.enemyInstances.map(instance =>
            instance.id === id ? addCombatResource(instance, name, max) : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
        return { enemyInstances } as Partial<CampaignDeps>;
    }),
    adjustEnemyResource: (id, resourceId, delta) => set((s) => {
        if (!s.enemyCombatConfig.enabled || !s.enemyCombatConfig.resourcesEnabled) return {};
        const enemyInstances = s.enemyInstances.map(instance =>
            instance.id === id ? adjustCombatResource(instance, resourceId, delta) : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
        return { enemyInstances } as Partial<CampaignDeps>;
    }),
    removeEnemyResource: (id, resourceId) => set((s) => {
        if (!s.enemyCombatConfig.enabled || !s.enemyCombatConfig.resourcesEnabled) return {};
        const enemyInstances = s.enemyInstances.map(instance =>
            instance.id === id
                ? {
                    ...instance,
                    resources: instance.resources.filter(resource => resource.id !== resourceId),
                    updatedAt: Date.now(),
                }
                : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
        return { enemyInstances } as Partial<CampaignDeps>;
    }),
    clearEnemyCooldown: (id, cooldownId) => set((s) => {
        if (!s.enemyCombatConfig.enabled || !s.enemyCombatConfig.cooldownsEnabled) return {};
        const enemyInstances = s.enemyInstances.map(instance =>
            instance.id === id
                ? {
                    ...instance,
                    cooldowns: instance.cooldowns.filter(cooldown => cooldown.id !== cooldownId),
                    updatedAt: Date.now(),
                }
                : instance
        );
        debouncedSaveEnemyInstances(s.activeCampaignId, enemyInstances);
        return { enemyInstances } as Partial<CampaignDeps>;
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
