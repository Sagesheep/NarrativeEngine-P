import { API_BASE as API } from '../../lib/apiBase';
import { fetchArchiveScenes, retrieveArchiveMemory } from '../archiveMemory';
import type { OocCampaignSnapshot, OocSource } from './types';

const SEARCH_HINT = /\b(archive|earlier|previous|past|history|remember|happened|when|where|who|lore|rule|rules|record|canon|named)\b/i;
const QUESTION_WORDS = new Set(['what', 'when', 'where', 'who', 'why', 'how', 'can', 'does', 'do', 'is', 'are', 'was', 'were', 'tell', 'please', 'should', 'could', 'would', 'will', 'may']);
const short = (value: string, max = 700) => value.trim().replace(/\s+/g, ' ').slice(0, max);

export function shouldSearchOoc(question: string, forceSearch = false): boolean {
    return forceSearch || SEARCH_HINT.test(question) || (question.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).some(name => !QUESTION_WORDS.has(name.toLowerCase()));
}

async function semanticIds(campaignId: string, question: string, signal?: AbortSignal): Promise<{ archive: string[]; lore: string[]; rules: string[] }> {
    try {
        const body = JSON.stringify({ query: question, limit: 4 });
        const [archive, lore, rules] = await Promise.all([
            fetch(`${API}/campaigns/${campaignId}/archive/semantic-candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
            fetch(`${API}/campaigns/${campaignId}/lore/semantic-candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
            fetch(`${API}/campaigns/${campaignId}/rules/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal }),
        ]);
        const parse = async (response: Response, key: 'sceneIds' | 'loreIds' | 'ruleIds') => {
            if (!response.ok) return [] as string[];
            const data = await response.json();
            return data.pending || !Array.isArray(data[key]) ? [] : data[key] as string[];
        };
        return {
            archive: await parse(archive, 'sceneIds'),
            lore: await parse(lore, 'loreIds'),
            rules: await parse(rules, 'ruleIds'),
        };
    } catch (error) {
        if (signal?.aborted) throw error;
        return { archive: [], lore: [], rules: [] };
    }
}

/** Read-only bounded retrieval for OOC. It does not construct a TurnState or call gatherContext. */
export async function searchCampaignRecords(
    snapshot: OocCampaignSnapshot,
    question: string,
    signal?: AbortSignal,
): Promise<{ text: string; sources: OocSource[] }> {
    if (!snapshot.campaignId) return { text: '', sources: [] };
    const semantic = await semanticIds(snapshot.campaignId, question, signal);
    const localArchiveIds = retrieveArchiveMemory(
        snapshot.archiveIndex, question, snapshot.messages, snapshot.npcLedger, 2,
        snapshot.semanticFacts, undefined, undefined, semantic.archive, undefined, undefined,
        undefined, 'lean', snapshot.campaignId,
    ).slice(0, 2);
    const archive = await fetchArchiveScenes(snapshot.campaignId, localArchiveIds, 500);
    const selectedLoreIds = new Set([...semantic.lore, ...semantic.rules]);
    const chunks = [...snapshot.loreChunks, ...(snapshot.context.rulesChunks ?? [])]
        .filter(chunk => selectedLoreIds.has(chunk.id) || (!selectedLoreIds.size && chunk.triggerKeywords.some(keyword => question.toLowerCase().includes(keyword.toLowerCase()))))
        .filter((chunk, index, all) => all.findIndex(other => other.id === chunk.id) === index)
        .slice(0, 3);
    const sources: OocSource[] = [
        ...archive.map(scene => ({ kind: 'archive' as const, id: scene.sceneId, label: `Archive scene ${scene.sceneId}`, excerpt: short(scene.content, 750) })),
        ...chunks.map(chunk => ({
            kind: (snapshot.context.rulesChunks ?? []).some(rule => rule.id === chunk.id) ? 'rules' as const : 'lore' as const,
            id: chunk.id,
            label: chunk.header || 'Campaign record',
            excerpt: short(chunk.summary || chunk.content, 500),
        })),
    ];
    const text = sources.map(source => `[${source.kind.toUpperCase()}: ${source.label}]\n${source.excerpt}`).join('\n\n');
    return { text, sources };
}
