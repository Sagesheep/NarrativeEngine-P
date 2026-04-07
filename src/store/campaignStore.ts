import type { ArchiveChapter, Campaign, LoreChunk, GameContext, ChatMessage, CondenserState, NPCEntry, ArchiveIndexEntry, SemanticFact, BackupMeta } from '../types';

const API = '/api';

export type CampaignState = {
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
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

// ─── Campaign State ───

export async function saveCampaignState(campaignId: string, state: CampaignState): Promise<void> {
    await fetch(`${API}/campaigns/${campaignId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
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

export async function updateChapter(campaignId: string, chapterId: string, patch: Partial<ArchiveChapter>): Promise<ArchiveChapter | undefined> {
    const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    if (!res.ok) return undefined;
    return res.json();
}
