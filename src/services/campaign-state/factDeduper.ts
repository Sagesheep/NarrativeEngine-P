import type { DivergenceRegister, DivergenceEntry, NPCEntry, ArchiveChapter, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { CATEGORY_LABELS } from './divergenceRegister';
import { extractJsonRobust } from '../infrastructure/jsonExtract';

export type DedupGroup = {
    bucketLabel: string;
    keepId: string;
    disableIds: string[];
    reason?: string;
};

export type DedupCancelled = { cancelled: boolean };

export type DedupResult = {
    groups: DedupGroup[];
    failedBuckets: string[];
};

export async function runFactDedup(
    register: DivergenceRegister,
    npcLedger: NPCEntry[],
    chapters: ArchiveChapter[],
    utilityProvider: EndpointConfig | ProviderConfig,
    cancel: DedupCancelled,
    onProgress: (msg: string, done: number, total: number) => void,
): Promise<DedupResult> {
    const eligible = register.entries.filter(e => !e.pinned && e.enabled !== false);

    if (eligible.length === 0) return { groups: [], failedBuckets: [] };

    const npcNameMap = new Map<string, string>();
    for (const n of npcLedger) {
        npcNameMap.set(n.id, n.name);
    }

    const chapterIndexMap = new Map<string, number>();
    for (let i = 0; i < chapters.length; i++) {
        chapterIndexMap.set(chapters[i].chapterId, i);
    }

    const bucketMap = new Map<string, { label: string; entries: DivergenceEntry[] }>();

    for (const entry of eligible) {
        const primaryNpc = entry.npcIds.length > 0 ? entry.npcIds[0] : null;

        if (primaryNpc) {
            if (!bucketMap.has(primaryNpc)) {
                const name = npcNameMap.get(primaryNpc) ?? primaryNpc;
                bucketMap.set(primaryNpc, { label: name, entries: [] });
            }
            bucketMap.get(primaryNpc)!.entries.push(entry);
        } else {
            const catKey = `__cat_${entry.category}`;
            if (!bucketMap.has(catKey)) {
                bucketMap.set(catKey, { label: CATEGORY_LABELS[entry.category] ?? entry.category, entries: [] });
            }
            bucketMap.get(catKey)!.entries.push(entry);
        }
    }

    const buckets = [...bucketMap.values()].filter(b => b.entries.length >= 3);

    if (buckets.length === 0) return { groups: [], failedBuckets: [] };

    const allGroups: DedupGroup[] = [];
    const failedBuckets: string[] = [];

    for (let i = 0; i < buckets.length; i++) {
        if (cancel.cancelled) throw new Error('Dedup cancelled.');

        const bucket = buckets[i];
        onProgress(`Checking ${bucket.label} — ${i + 1} / ${buckets.length} entities`, i, buckets.length);

        const factLines = bucket.entries
            .map(e => `${e.id} | #${e.sceneRef} | ${e.text}`)
            .join('\n');

        const prompt = `You are deduplicating campaign facts about ${bucket.label}.

FACTS (id | scene | text):
${factLines}

Identify groups where multiple facts describe the SAME EVENT or SAME STATE in different words.

DO NOT GROUP:
- Different events sharing a trait ("X saved A" + "X saved B")
- Contradictions / arc reversals ("X hates Y" + "X loves Y")
- General + specific ("X is brave" + "X charged the dragon")
- Related but distinct ("Bridge is dangerous" + "Bridge collapsed")

GROUP:
- Restatements of one event ("X rescued a civilian" + "X saved a bystander")
- Same state in different words ("X has the amulet" + "X carries the amulet")

Schema (do not copy example values):
{"duplicates":[{"ids":["<fact_id>","<fact_id>"],"reason":"<one short sentence>"}]}

If nothing duplicates, return {"duplicates":[]} exactly.`;

        let raw: string;
        try {
            raw = await llmCall(utilityProvider, prompt, {
                temperature: 0.15,
                maxTokens: 4096,
                trackingLabel: 'fact-dedup',
                timeoutMs: 24 * 60 * 60 * 1000,
            });
        } catch (err) {
            console.warn(`[FactDeduper] LLM call failed for bucket "${bucket.label}":`, err);
            failedBuckets.push(bucket.label);
            continue;
        }

        if (cancel.cancelled) throw new Error('Dedup cancelled.');

        const { value: parsed, parseOk } = extractJsonRobust<{ duplicates: Array<{ ids: string[]; reason?: string }> }>(
            raw,
            { duplicates: [] },
        );

        if (!parseOk) {
            console.warn('[FactDeduper] Bad response for bucket', bucket.label, raw);
            failedBuckets.push(bucket.label);
            continue;
        }

        if (!Array.isArray(parsed.duplicates)) continue;

        const entryById = new Map<string, DivergenceEntry>();
        for (const e of bucket.entries) entryById.set(e.id, e);

        const bucketIdSet = new Set(bucket.entries.map(e => e.id));

        for (const group of parsed.duplicates) {
            if (!Array.isArray(group.ids)) continue;

            const validIds = group.ids.filter(id => bucketIdSet.has(id));
            if (validIds.length < 2) continue;

            const sortedByRecency = [...validIds].sort((a, b) => {
                const entryA = entryById.get(a);
                const entryB = entryById.get(b);
                if (!entryA || !entryB) return 0;
                const chIdxA = chapterIndexMap.get(entryA.chapterId) ?? 0;
                const chIdxB = chapterIndexMap.get(entryB.chapterId) ?? 0;
                if (chIdxA !== chIdxB) return chIdxA - chIdxB;
                return entryA.sceneRef.localeCompare(entryB.sceneRef);
            });

            const keepId = sortedByRecency[sortedByRecency.length - 1];
            const disableIds = sortedByRecency.slice(0, -1);

            allGroups.push({
                bucketLabel: bucket.label,
                keepId,
                disableIds,
                reason: group.reason,
            });
        }
    }

    onProgress(`Done — ${allGroups.length} duplicate groups found`, buckets.length, buckets.length);

    return { groups: allGroups, failedBuckets };
}
