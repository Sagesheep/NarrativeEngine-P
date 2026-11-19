import type { ArchiveIndexEntry } from '../../types';
import { API_BASE as API } from '../../lib/apiBase';
import { safeSceneNum } from '../../utils/helpers';
import { fetchArchiveScenes, retrieveArchiveMemory } from './recall';

/**
 * archive-memory/archiveToolSearch.ts
 *
 * The archive half of the story AI's `query_campaign_lore` tool. The tool used to
 * search lore chunks only while its chip said "Searched archives", so asking it
 * for "scene 598" or for something that happened twenty turns ago could never
 * succeed. This looks scenes up by number when the query names one, and
 * otherwise runs the same hybrid ranker (keyword + embedding) the turn recall uses.
 */

const TOOL_ARCHIVE_TOKEN_BUDGET = 2500;
const TOOL_ARCHIVE_MAX_SCENES = 3;
const MAX_NAMED_SCENES = 3;

// A number right after a word for "scene" in most languages the app is played in
// (scene, scena/scenę/scenie, Szene, escena, scène, сцена) or after "#".
const SCENE_REF = /(?:(?<![\p{L}])(?:sc[eè]n|szen|escen|сцен)[\p{L}]*\.?\s*#?\s*|#\s*)(\d{1,6})(?!\d)/giu;
const BARE_NUMBERS = /^\s*#?\d{1,6}(?:\s*[,;&]\s*#?\d{1,6})*\s*$/u;

/**
 * Scene ids the query names explicitly, resolved against the index ("scene 598",
 * "scena 598", "#598", or a query that is only numbers). Unknown numbers are dropped.
 */
export function namedSceneIds(query: string, index: readonly ArchiveIndexEntry[]): string[] {
    const byNum = new Map(index.map(e => [safeSceneNum(e.sceneId), e.sceneId]));
    const nums: number[] = [];
    for (const m of query.matchAll(SCENE_REF)) nums.push(parseInt(m[1], 10));
    if (nums.length === 0 && BARE_NUMBERS.test(query)) {
        for (const m of query.matchAll(/\d{1,6}/g)) nums.push(parseInt(m[0], 10));
    }
    const ids: string[] = [];
    for (const n of nums) {
        const id = byNum.get(n);
        if (id && !ids.includes(id)) ids.push(id);
    }
    return ids.slice(0, MAX_NAMED_SCENES);
}

async function semanticSceneIds(campaignId: string, query: string): Promise<string[] | undefined> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/archive/semantic-candidates`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        if (!res.ok) return undefined;
        const data = await res.json();
        return data.pending || !Array.isArray(data.sceneIds) ? undefined : data.sceneIds as string[];
    } catch {
        return undefined;
    }
}

/**
 * Past scenes for a tool query, formatted for the tool result, or '' when none match.
 * Named scenes are returned whole (within budget); otherwise the best few by ranking.
 */
export async function searchArchiveForTool(
    campaignId: string | null | undefined,
    index: readonly ArchiveIndexEntry[] | undefined,
    query: string,
): Promise<string> {
    if (!campaignId || !index || index.length === 0 || !query.trim()) return '';

    let ids = namedSceneIds(query, index);
    if (ids.length === 0) {
        const semantic = await semanticSceneIds(campaignId, query);
        ids = retrieveArchiveMemory(
            index as ArchiveIndexEntry[], query, [], undefined, TOOL_ARCHIVE_MAX_SCENES,
            undefined, undefined, undefined, semantic, undefined, undefined, undefined, 'lean', campaignId,
        ).slice(0, TOOL_ARCHIVE_MAX_SCENES);
    }
    if (ids.length === 0) return '';

    const scenes = await fetchArchiveScenes(campaignId, ids, TOOL_ARCHIVE_TOKEN_BUDGET);
    return scenes.map(s => `### Archive scene ${s.sceneId}\n${s.content}`).join('\n\n');
}
