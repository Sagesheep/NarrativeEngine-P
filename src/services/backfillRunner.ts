import { API_BASE as API } from '../lib/apiBase';

export type BackfillStatus = {
    scenes: { total: number; current: number; stale: number };
    lore: { total: number; current: number; stale: number };
    version: number;
};

export type BackfillResult = {
    reindexedScenes: number;
    reindexedLore: number;
    status: BackfillStatus;
};

export async function getEmbeddingStatus(campaignId: string): Promise<BackfillStatus> {
    const res = await fetch(`${API}/campaigns/${campaignId}/embeddings/status`);
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Failed to get embedding status: ${err}`);
    }
    return res.json();
}

export async function runBackfill(
    campaignId: string,
    type: 'all' | 'scene' | 'lore' = 'all',
    onProgress?: (msg: string) => void
): Promise<BackfillResult> {
    onProgress?.('Starting re-index...');
    
    const res = await fetch(`${API}/campaigns/${campaignId}/embeddings/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Re-index failed: ${err}`);
    }

    const result: BackfillResult = await res.json();
    onProgress?.(`Done: ${result.reindexedScenes} scenes, ${result.reindexedLore} lore re-indexed`);
    return result;
}