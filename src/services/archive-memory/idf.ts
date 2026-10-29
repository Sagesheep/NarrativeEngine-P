import type { ArchiveIndexEntry } from '../../types';

/**
 * archive-memory/idf.ts
 *
 * Signature-gated, campaign-scoped IDF cache over the archive index. IDF only
 * changes when the archive itself changes, so a cheap signature distinguishes
 * "same index" from "index changed". The optional campaignId is folded into the
 * signature so two campaigns can never share a stale IDF table.
 */

let _idfCache: { sig: string; idf: Record<string, number> } | null = null;

function indexSignature(index: ArchiveIndexEntry[], campaignId?: string): string {
    if (index.length === 0) return campaignId ? `${campaignId}:empty` : '';
    const first = index[0].sceneId;
    const last = index[index.length - 1].sceneId;
    const tsLast = index[index.length - 1].timestamp;
    return `${campaignId ?? ''}:${index.length}:${first}:${last}:${tsLast}`;
}

export function computeArchiveIdf(index: ArchiveIndexEntry[], campaignId?: string): Record<string, number> {
    const sig = indexSignature(index, campaignId);
    if (_idfCache && _idfCache.sig === sig) return _idfCache.idf;

    const N = index.length;
    const df: Record<string, number> = {};

    for (const entry of index) {
        const seen = new Set<string>();
        const kwStrengths = entry.keywordStrengths ?? {};
        const npcStrengths = entry.npcStrengths ?? {};
        if (Object.keys(kwStrengths).length > 0 || Object.keys(npcStrengths).length > 0) {
            for (const kw of Object.keys(kwStrengths)) {
                const k = kw.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
            for (const npc of Object.keys(npcStrengths)) {
                const k = npc.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
        } else {
            for (const kw of entry.keywords) {
                const k = kw.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
            for (const npc of entry.npcsMentioned) {
                const k = npc.toLowerCase();
                if (!seen.has(k)) { seen.add(k); df[k] = (df[k] || 0) + 1; }
            }
        }
    }

    const idf: Record<string, number> = {};
    for (const [term, count] of Object.entries(df)) {
        idf[term] = Math.log(1 + (N - count + 0.5) / (count + 0.5));
    }

    _idfCache = { sig, idf };
    return idf;
}

export function clearArchiveIdfCache(): void {
    _idfCache = null;
}
