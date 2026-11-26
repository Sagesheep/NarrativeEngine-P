import type { DivergenceRegister, TopicClusters, TopicCluster, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { countTokens } from '../infrastructure/tokenizer';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { normalizeSubjectToken } from './knowledgeScope';

export type ClusteringCancelled = { cancelled: boolean };

export async function runFactClustering(
    register: DivergenceRegister,
    utilityProvider: EndpointConfig | ProviderConfig,
    contextLimit: number = 8192,
    cancel: ClusteringCancelled = { cancelled: false },
    onStatus: (msg: string) => void = () => {},
): Promise<TopicClusters> {
    const entries = register.entries;
    if (entries.length === 0) {
        return { groups: [], generatedAt: new Date().toISOString(), generatedFromFactCount: 0 };
    }

    const textLimit = entries.length > 150 ? 80 : 120;
    const factLines = entries
        .map(e => `${e.id}|${e.chapterId}|${e.text.slice(0, textLimit)}`)
        .join('\n');

    const prompt = `You are organizing campaign facts for a TTRPG. Group the facts below by recurring entity or theme — a specific NPC, a location, an ongoing storyline, a faction, or a concept that appears across multiple facts.

FACTS (id|chapter|text):
${factLines}

RULES:
- Each fact must appear in exactly one group.
- Aim for 8–20 groups. Prefer specific names (e.g. "Yuki", "The Bridge District") over generic labels.
- IMPORTANT: Include ALL ${entries.length} fact IDs across your groups — do not omit any.
- Return ONLY valid complete JSON, no prose, no truncation:
{"groups":[{"name":"Yuki","factIds":["id1","id2"]},{"name":"Reaper Contract","factIds":["id3"]}]}`;

    const promptTokens = countTokens(prompt);
    const maxTokens = Math.floor(contextLimit * 0.75);

    const modelName = (utilityProvider as EndpointConfig).modelName || utilityProvider.endpoint;
    console.log(
        `[FactClusterer] ${entries.length} facts · prompt: ${promptTokens} tkns · maxResponse: ${maxTokens} tkns · model: ${modelName}`
    );
    onStatus(`Sending ${promptTokens.toLocaleString()} tokens to model…`);

    const raw = await llmCall(utilityProvider, prompt, {
        temperature: 0.2,
        maxTokens,
        // 24 h sentinel — native readTimeout is 600 s; this just keeps the tracker alive.
        // Real "stop" is the cancel flag checked after the call.
        timeoutMs: 24 * 60 * 60 * 1000,
        trackingLabel: 'fact-clusterer',
    });

    if (cancel.cancelled) throw new Error('Clustering cancelled.');

    onStatus(`Parsing response (${raw.length.toLocaleString()} chars)…`);
    console.log(`[FactClusterer] Response: ${raw.length} chars`);

    const { value: parsed, parseOk } = extractJsonRobust<{ groups: Array<{ name: string; factIds: string[] }> }>(
        raw,
        { groups: [] },
    );

    if (!parseOk || !Array.isArray(parsed.groups)) {
        throw new Error(parseOk ? 'AI response missing "groups" array.' : 'Response was truncated and could not be recovered. Try a model with a larger output limit.');
    }

    const knownIds = new Set(entries.map(e => e.id));
    const assignedIds = new Set<string>();

    const groups: TopicCluster[] = parsed.groups
        .filter(g => g.name && Array.isArray(g.factIds))
        .map((g, i) => {
            const validIds = g.factIds.filter(id => knownIds.has(id) && !assignedIds.has(id));
            validIds.forEach(id => assignedIds.add(id));
            return {
                id: `cluster-${i}-${g.name.toLowerCase().replace(/\s+/g, '-').slice(0, 20)}`,
                name: g.name,
                factIds: validIds,
            };
        })
        .filter(g => g.factIds.length > 0);

    // Any facts the AI omitted → Uncategorized
    const unassigned = entries.map(e => e.id).filter(id => !assignedIds.has(id));
    if (unassigned.length > 0) {
        groups.push({
            id: 'cluster-uncategorized',
            name: 'Uncategorized',
            factIds: unassigned,
        });
    }

    const result: TopicClusters = {
        groups,
        generatedAt: new Date().toISOString(),
        generatedFromFactCount: entries.length,
    };

    console.log(`[FactClusterer] Done — ${groups.length} groups, ${assignedIds.size} assigned, ${unassigned.length} uncategorized`);
    return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Find Similarity (WO-11.2): assign / repair `subjectToken` across the register.
// Reuses runFactClustering (the existing single LLM grouping call). NEVER
// disables or deletes facts — only subjectToken changes. Distinct action and
// button from Find Duplicates.
// ─────────────────────────────────────────────────────────────────────────

export type SubjectTokenUpdate = { id: string; subjectToken: string };
export type AssignSubjectTokensResult = {
    updates: SubjectTokenUpdate[];
    groupCount: number;
    factCount: number;
};

/**
 * Derive canonical subjectToken updates from a clustering result.
 * Pure — no LLM call. Exposed for testing.
 *
 * Canonical-token selection rule:
 *   1. For each cluster with >= 2 facts: if any member already has a subjectToken,
 *      reuse the MOST COMMON existing token among members (drift repair — merges
 *      two tokens that should have been one). If there is no existing token,
 *      synthesize one from the cluster's `name` via normalizeSubjectToken
 *      (the clusterer emits readable labels like "Yuki" or "Alex Chen").
 *   2. Singleton clusters (1 fact) are left alone: a fact with an existing token
 *      keeps it; a fact with no token stays undefined. (We never overwrite a
 *      singleton's token — it may already be correctly grouped with facts the
 *      clusterer happened to put in another bucket this run.)
 *
 * The "Uncategorized" bucket from runFactClustering is treated as singletons:
 * we do NOT assign all uncategorized facts one shared token.
 */
export function deriveSubjectTokenUpdates(
    register: DivergenceRegister,
    clusters: TopicClusters,
): SubjectTokenUpdate[] {
    const byId = new Map(register.entries.map(e => [e.id, e]));
    const updates: SubjectTokenUpdate[] = [];

    for (const group of clusters.groups) {
        // Only multi-fact groups get a shared token. Singletons are left alone.
        if (group.factIds.length < 2) continue;

        const members = group.factIds
            .map(id => byId.get(id))
            .filter((e): e is NonNullable<typeof e> => !!e);
        if (members.length < 2) continue;

        // Tally existing tokens among members.
        const tokenCounts = new Map<string, number>();
        for (const m of members) {
            if (typeof m.subjectToken === 'string' && m.subjectToken) {
                tokenCounts.set(m.subjectToken, (tokenCounts.get(m.subjectToken) ?? 0) + 1);
            }
        }

        let canonical: string | undefined;
        if (tokenCounts.size > 0) {
            // Pick the most common existing token (drift repair — unifies tokens).
            let best = '';
            let bestCount = -1;
            for (const [tok, count] of tokenCounts) {
                if (count > bestCount || (count === bestCount && tok < best)) {
                    best = tok;
                    bestCount = count;
                }
            }
            canonical = best;
        } else {
            // No existing token — synthesize from the cluster's readable name.
            canonical = normalizeSubjectToken(group.name) ?? undefined;
        }

        if (!canonical) continue;

        for (const m of members) {
            // Only emit an update when the token would actually change.
            if (m.subjectToken !== canonical) {
                updates.push({ id: m.id, subjectToken: canonical });
            }
        }
    }

    return updates;
}

/**
 * Run the clustering pass and produce subjectToken updates. Reuses the existing
 * runFactClustering LLM call — NO new call type. Cancel-safe (mirrors dedup).
 * Never disables or deletes facts.
 */
export async function assignSubjectTokens(
    register: DivergenceRegister,
    utilityProvider: EndpointConfig | ProviderConfig,
    contextLimit: number,
    cancel: ClusteringCancelled,
    onStatus: (msg: string) => void,
): Promise<AssignSubjectTokensResult> {
    if (register.entries.length === 0) {
        return { updates: [], groupCount: 0, factCount: 0 };
    }

    onStatus('Grouping facts by subject…');
    const clusters = await runFactClustering(register, utilityProvider, contextLimit, cancel, onStatus);
    if (cancel.cancelled) throw new Error('Find Similarity cancelled.');

    const updates = deriveSubjectTokenUpdates(register, clusters);
    const grouped = new Set(updates.map(u => u.id));

    return {
        updates,
        groupCount: clusters.groups.filter(g => g.factIds.length >= 2).length,
        factCount: grouped.size,
    };
}
