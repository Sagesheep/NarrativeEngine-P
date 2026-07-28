import type { ArchiveChapter, Campaign, LoreChunk, GameContext, ChatMessage, CondenserState, NPCEntry, EnemyEntry, AbilityEntry, EnemyInstance, EnemyEncounter, EnemyEncounterResolution, EnemyCombatConfig, ArchiveIndexEntry, SemanticFact, EntityEntry, BackupMeta, TimelineEvent, DivergenceRegister, PinnedExcerpt, LocationEntry } from '../types';
import { affinityToPcRelation } from '../services/npc/agency/agencyBands';

import { API_BASE as API } from '../lib/apiBase';

export type CampaignState = {
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    pinnedExcerpts?: PinnedExcerpt[];
};

// ─── Campaign CRUD ───

export async function listCampaigns(): Promise<Campaign[]> {
    const res = await fetch(`${API}/campaigns`);
    return res.json();
}

export async function getCampaign(id: string): Promise<Campaign | undefined> {
    const res = await fetch(`${API}/campaigns/${id}`);
    if (!res.ok) return undefined;
    return res.json();
}

export async function saveCampaign(campaign: Campaign): Promise<void> {
    await fetch(`${API}/campaigns/${campaign.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(campaign),
    });
}

export async function deleteCampaign(id: string): Promise<void> {
    await fetch(`${API}/campaigns/${id}`, { method: 'DELETE' });
}

export async function exportCampaign(id: string): Promise<void> {
    const res = await fetch(`${API}/campaigns/${id}/export`);
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') ?? '';
    const fnMatch = cd.match(/filename="([^"]+)"/);
    const filename = fnMatch?.[1] ?? `campaign_${id}.campaign`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export async function importCampaign(bundle: unknown): Promise<{ id: string; name: string }> {
    const res = await fetch(`${API}/campaigns/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bundle),
    });
    if (!res.ok) throw new Error('Import failed');
    return res.json();
}

// ─── Campaign State ───

export async function saveCampaignState(campaignId: string, state: CampaignState): Promise<void> {
    const stripped: CampaignState = {
        ...state,
        messages: state.messages.map((m) => {
            const msg = { ...m };
            delete msg.debugPayload;
            // Smart Retry v1 — ephemerals must never reach disk. A persisted
            // `retryable` yields a Retry button that survives restart with no
            // in-memory payload behind it (dead button → "Context lost" toast).
            delete msg.retryable;
            delete msg.precontext;
            return msg;
        }),
    };
    await fetch(`${API}/campaigns/${campaignId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stripped),
    });
}

export async function loadCampaignState(campaignId: string): Promise<CampaignState | null> {
    const res = await fetch(`${API}/campaigns/${campaignId}/state`);
    if (!res.ok) return null;
    const record = await res.json();
    const { context, messages, condenser } = record;
    return { context, messages, condenser };
}

// ─── Lore Chunks ───

export async function saveLoreChunks(campaignId: string, chunks: LoreChunk[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/lore`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chunks),
    });
}

export async function getLoreChunks(campaignId: string): Promise<LoreChunk[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/lore`);
    return res.json();
}

// ─── NPC Ledger ───

export async function saveNPCLedger(campaignId: string, npcs: NPCEntry[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/npcs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(npcs),
    });
}

export async function getNPCLedger(campaignId: string): Promise<NPCEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/npcs`);
    if (!res.ok) return [];
    const npcs: NPCEntry[] = await res.json();
    // B2 — lazy migration for existing saves: home pcRelation for any NPC where it's still
    // undefined. populateAgencyFields only runs on UN-populated NPCs, and generated NPCs were
    // born populated:true with pcRelation unset, so legacy NPCs read "[Aff: Neutral]" forever
    // and Phase 2's reaction-menu relationship scoring never saw real drift. Home them here on
    // load regardless of `populated`, mirroring the birth-block fix in profile.ts. Skip PCs
    // (matches populateAgencyFields' !n.isPC filter). Never clobber an explicit value, never
    // touch affinity. Persistence happens via the normal store-update path on the next mutation.
    for (const n of npcs) {
        if (!n.isPC && n.pcRelation === undefined) {
            n.pcRelation = affinityToPcRelation(n.affinity ?? 50);
        }
        // Coerce any scalar NPCEntry fields that were stored as arrays/objects by a pre-coerce
        // fix in the NPC generator (profile.ts). The render prompt asks the model for strings
        // (e.g. "aliases": "Comma separated aliases..."), but models often returned arrays
        // (e.g. ["Scholar", "Caretaker of the Ancients"]) which were assigned verbatim into
        // `string`-typed fields. The corruption threw `TypeError: x.split is not a function`
        // from downstream `.split(',')` call sites (scoring.ts, witnessCapture.ts, etc.) and
        // locked the UI in 'gathering-context' once a chapter was sealed (the only path that
        // routes through the affected rankChapters→extractContextActivations call). Flatten in
        // place here so already-corrupted saves recover on load. Idempotent — no-op on healthy
        // campaigns. Persistence happens via the normal store-update path on the next mutation.
        if (Array.isArray(n.aliases)) n.aliases = (n.aliases as unknown[]).map(String).filter(Boolean).join(', ');
        if (Array.isArray(n.goals)) n.goals = (n.goals as unknown[]).map(String).filter(Boolean).join('; ');
        if (Array.isArray(n.appearance)) n.appearance = (n.appearance as unknown[]).map(String).filter(Boolean).join(' ');
        if (n.disposition && typeof n.disposition !== 'string') n.disposition = String(n.disposition);
        if (n.voice && typeof n.voice !== 'string') n.voice = String(n.voice);
        if (n.personality && typeof n.personality !== 'string') n.personality = String(n.personality);
        if (n.faction && typeof n.faction !== 'string') n.faction = String(n.faction);
        if (n.status && typeof n.status !== 'string') n.status = String(n.status);
        if (n.storyRelevance && typeof n.storyRelevance !== 'string') n.storyRelevance = String(n.storyRelevance);
        if (n.exampleOutput && typeof n.exampleOutput !== 'string') n.exampleOutput = String(n.exampleOutput);
    }
    return npcs;
}

// ─── Enemy Compendium ───

export async function saveEnemyCompendium(campaignId: string, enemies: EnemyEntry[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/enemies`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enemies),
    });
}

export async function getEnemyCompendium(campaignId: string): Promise<EnemyEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/enemies`);
    return res.ok ? res.json() : [];
}

// ─── Ability & Power Compendium ───

export async function saveAbilityCompendium(campaignId: string, abilities: AbilityEntry[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/abilities`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(abilities),
    });
}

export async function getAbilityCompendium(campaignId: string): Promise<AbilityEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/abilities`);
    return res.ok ? res.json() : [];
}

// ─── Enemy Instances ───

export async function getEnemyInstances(campaignId: string): Promise<EnemyInstance[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/enemy-instances`);
    return res.ok ? res.json() : [];
}

/** Persists the live instance pool after an atomic encounter resolution. */
export async function saveEnemyInstances(campaignId: string, instances: EnemyInstance[]): Promise<void> {
    const res = await fetch(`${API}/campaigns/${campaignId}/enemy-instances`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(instances),
    });
    if (!res.ok) throw new Error(`Failed to save enemy instances (${res.status})`);
}

// ─── Enemy Encounters ───

export async function getEnemyEncounters(campaignId: string): Promise<EnemyEncounter[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/enemy-encounters`);
    return res.ok ? res.json() : [];
}

/** Persists encounter lifecycle changes after an atomic resolution. */
export async function saveEnemyEncounters(campaignId: string, encounters: EnemyEncounter[]): Promise<void> {
    const res = await fetch(`${API}/campaigns/${campaignId}/enemy-encounters`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(encounters),
    });
    if (!res.ok) throw new Error(`Failed to save enemy encounters (${res.status})`);
}

// ─── Enemy Encounter Resolutions ─────────────────────────────────────────────

/** Loads immutable Phase 5 encounter outcomes and optional instance archives. */
export async function getEnemyResolutions(campaignId: string): Promise<EnemyEncounterResolution[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/enemy-resolutions`);
    return res.ok ? res.json() : [];
}

/** Persists the complete immutable encounter-resolution ledger. */
export async function saveEnemyResolutions(
    campaignId: string,
    resolutions: EnemyEncounterResolution[],
): Promise<void> {
    const res = await fetch(`${API}/campaigns/${campaignId}/enemy-resolutions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(resolutions),
    });
    if (!res.ok) throw new Error(`Failed to save enemy resolutions (${res.status})`);
}

// ─── Optional Enemy Combat Configuration ─────────────────────────────────────

/** Loads the campaign's optional combat rules; missing files are normalized by the hydrator. */
export async function getEnemyCombatConfig(campaignId: string): Promise<Partial<EnemyCombatConfig> | null> {
    const res = await fetch(`${API}/campaigns/${campaignId}/enemy-combat`);
    return res.ok ? res.json() : null;
}

// ─── Location Ledger ───

export async function saveLocationLedger(campaignId: string, locations: LocationEntry[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/locations`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(locations),
    });
}

export async function getLocationLedger(campaignId: string): Promise<LocationEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/locations`);
    if (!res.ok) return [];
    return res.json();
}

// ─── Archive Index (Tier 4) ───

/** Load the archive search index from disk. Built automatically by the server on every turn. */
export async function loadArchiveIndex(campaignId: string): Promise<ArchiveIndexEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/index`);
    if (!res.ok) return [];
    return res.json();
}

export async function loadSemanticFacts(campaignId: string): Promise<SemanticFact[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/facts`);
    if (!res.ok) return [];
    return res.json();
}

export async function loadEntities(campaignId: string): Promise<EntityEntry[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/entities`);
    if (!res.ok) return [];
    return res.json();
}

// --- Chapters (Phase 1) ---

export async function loadChapters(campaignId: string): Promise<ArchiveChapter[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`);
    if (!res.ok) return [];
    return res.json();
}

export async function createChapter(campaignId: string, title?: string): Promise<ArchiveChapter | undefined> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
    });
    if (!res.ok) return undefined;
    return res.json();
}

export async function createBackup(
    campaignId: string,
    opts: { label?: string; trigger?: string; isAuto?: boolean } = {}
): Promise<{ timestamp: number; hash: string; fileCount: number; skipped?: boolean } | undefined> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(opts),
        });
        if (res.ok) return await res.json();
    } catch (err) {
        console.warn('[Backup] Create failed:', err);
    }
    return undefined;
}

export async function listBackups(campaignId: string): Promise<BackupMeta[]> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backups`);
        if (res.ok) {
            const data = await res.json();
            return data.backups || [];
        }
    } catch (err) {
        console.warn('[Backup] List failed:', err);
    }
    return [];
}

export async function restoreBackup(campaignId: string, timestamp: number): Promise<boolean> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}/restore`, {
            method: 'POST',
        });
        return res.ok;
    } catch (err) {
        console.warn('[Backup] Restore failed:', err);
    }
    return false;
}

export async function deleteBackup(campaignId: string, timestamp: number): Promise<boolean> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}`, {
            method: 'DELETE',
        });
        return res.ok;
    } catch (err) {
        console.warn('[Backup] Delete failed:', err);
    }
    return false;
}

export async function updateBackup(campaignId: string, timestamp: number, label: string): Promise<boolean> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label }),
        });
        return res.ok;
    } catch (err) {
        console.warn('[Backup] Update failed:', err);
    }
    return false;
}

// ─── Timeline ───────────────────────────────────────────────────────────

export async function loadTimeline(campaignId: string): Promise<TimelineEvent[]> {
    const res = await fetch(`${API}/campaigns/${campaignId}/timeline`);
    if (!res.ok) return [];
    return res.json();
}

export async function addTimelineEvent(
    campaignId: string,
    event: Omit<TimelineEvent, 'id' | 'source'>
): Promise<TimelineEvent | undefined> {
    const res = await fetch(`${API}/campaigns/${campaignId}/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
    });
    if (!res.ok) return undefined;
    return res.json();
}

export async function removeTimelineEvent(campaignId: string, eventId: string): Promise<boolean> {
    const res = await fetch(`${API}/campaigns/${campaignId}/timeline/${eventId}`, {
        method: 'DELETE',
    });
    return res.ok;
}

export async function updateChapter(campaignId: string, chapterId: string, patch: Partial<ArchiveChapter>): Promise<ArchiveChapter | undefined> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!res.ok) return undefined;
    return res.json();
}

export async function saveDivergenceRegister(campaignId: string, register: DivergenceRegister): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/divergence`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(register),
    });
}

export async function loadDivergenceRegister(campaignId: string): Promise<DivergenceRegister> {
    const res = await fetch(`${API}/campaigns/${campaignId}/divergence`);
    if (!res.ok) return { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 };
    const data = await res.json();
    return { ...data, chapterToggles: data.chapterToggles ?? {}, categoryToggles: data.categoryToggles ?? {} };
}

export async function saveChapters(campaignId: string, chapters: ArchiveChapter[]): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/archive/chapters`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chapters),
    });
}
