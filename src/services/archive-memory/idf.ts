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

const definitionWordsCache = new WeakMap<ArchiveIndexEntry, Record<string, number>>();

/**
 * The words a scene is matched on by the keyword ranker. A scene with an AI-written
 * definition is matched on the words of that definition; otherwise on the keywords the
 * server pulled from its full text. Full-text keywords gave ~570 matching scenes per
 * turn and buried good meaning-search hits; on the Turn Prep probes (578-scene copy)
 * definition words put a target in the top 10 for 9/9 probes instead of 7/9 (summed
 * target rank 34 vs 59). Blending some full-text keywords back in did not help.
 */
export function sceneSearchWords(entry: ArchiveIndexEntry): Record<string, number> {
    if (!entry.definition) return entry.keywordStrengths ?? {};
    let words = definitionWordsCache.get(entry);
    if (!words) {
        words = {};
        for (const w of entry.definition.toLowerCase().match(/[a-z]{3,}/g) ?? []) words[w] = 1;
        definitionWordsCache.set(entry, words);
    }
    return words;
}

function indexSignature(index: ArchiveIndexEntry[], campaignId?: string): string {
    if (index.length === 0) return campaignId ? `${campaignId}:empty` : '';
    const first = index[0].sceneId;
    const last = index[index.length - 1].sceneId;
    const tsLast = index[index.length - 1].timestamp;
    // Definitions arrive after the scene (post-turn, or the Chapters backfill) and change the words.
    const defined = index.reduce((n, e) => n + (e.definition ? 1 : 0), 0);
    return `${campaignId ?? ''}:${index.length}:${first}:${last}:${tsLast}:${defined}`;
}

export function computeArchiveIdf(index: ArchiveIndexEntry[], campaignId?: string): Record<string, number> {
    const sig = indexSignature(index, campaignId);
    if (_idfCache && _idfCache.sig === sig) return _idfCache.idf;

    const N = index.length;
    const df: Record<string, number> = {};

    for (const entry of index) {
        const seen = new Set<string>();
        const kwStrengths = sceneSearchWords(entry);
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
