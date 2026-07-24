import type { DivergenceEntry, DivergenceRegister, DivergenceCategory, ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, EndpointConfig, ProviderConfig } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { toast } from '../../components/Toast';
import { llmCall } from '../../utils/llmCall';
import { isKnownToAnyOnStage } from './knowledgeScope';

export const EMPTY_REGISTER: DivergenceRegister = {
    entries: [],
    chapterToggles: {},
    categoryToggles: {},
    lastUpdatedSceneId: '',
    lastUpdatedAt: 0,
    version: 2,
};

export const DIVERGENCE_CATEGORIES: DivergenceCategory[] = [
    'locations',
    'npc_events',
    'promises_debts',
    'world_state',
    'party_facts',
    'rules_lore',
    'misc',
];

export const CATEGORY_LABELS: Record<DivergenceCategory, string> = {
    locations: 'Locations',
    npc_events: 'NPC Events',
    promises_debts: 'Promises & Debts',
    world_state: 'World State',
    party_facts: 'Party Facts',
    rules_lore: 'Rules & Lore',
    misc: 'Miscellaneous',
};

export const CATEGORY_DEFINITIONS: Record<DivergenceCategory, string> = {
    locations: 'New, changed, or destroyed locations and geography',
    npc_events: 'Significant actions, decisions, or fates of named NPCs',
    promises_debts: 'Oaths, bargains, favors owed, or obligations created/fulfilled',
    world_state: 'Changes to political, economic, magical, or environmental conditions',
    party_facts: 'Player character decisions, acquisitions, relationships, or status changes',
    rules_lore: 'Homebrew rules, lore discoveries, or canon established by the DM',
    misc: 'Anything that does not fit the other categories',
};

export function coerceCategory(raw: string): DivergenceCategory {
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
    if ((DIVERGENCE_CATEGORIES as readonly string[]).includes(normalized)) {
        return normalized as DivergenceCategory;
    }
    return 'misc';
}

export function buildSceneMap(
    archiveIndex: ArchiveIndexEntry[],
    messages: ChatMessage[]
): { sceneIdsByMessageId: Record<string, string>; index: Array<{ sceneId: string; importance?: number }> } {
    const sceneIdsByMessageId: Record<string, string> = {};
    const userMessages = messages.filter(m => m.role === 'user');
    const pairCount = Math.min(userMessages.length, archiveIndex.length);
    const userTail = userMessages.slice(-pairCount);
    const archiveTail = archiveIndex.slice(-pairCount);
    for (let i = 0; i < pairCount; i++) {
        sceneIdsByMessageId[userTail[i].id] = archiveTail[i].sceneId;
    }
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'assistant' && !sceneIdsByMessageId[msg.id]) {
            for (let j = i - 1; j >= 0; j--) {
                if (messages[j].role === 'user' && sceneIdsByMessageId[messages[j].id]) {
                    sceneIdsByMessageId[msg.id] = sceneIdsByMessageId[messages[j].id];
                    break;
                }
            }
        }
    }
    return {
        sceneIdsByMessageId,
        index: archiveIndex.map(e => ({ sceneId: e.sceneId, importance: e.importance })),
    };
}

export function stripReasoning(raw: string): string {
    let clean = raw.replace(/<think[\s\S]*?<\/think\s*>/gi, '');
    const fence = clean.match(/```(?:\w+)?\s*([\s\S]*?)```/);
    if (fence) clean = fence[1];
    return clean.trim();
}

/** State slots are intentionally limited to facts with exactly one current value. */
const STATE_KEY_RE = /^(?:item|npc|place|debt):[a-z0-9][a-z0-9_-]*:(?:holder|location|status|allegiance|controller)$/;

export function isValidStateKey(value: unknown): value is string {
    return typeof value === 'string' && STATE_KEY_RE.test(value);
}

/** Missing lifecycle data is the backward-compatible active state for old campaigns. */
export function isFactActive(entry: DivergenceEntry): boolean {
    return entry.status !== 'superseded' && entry.status !== 'retracted';
}

export function mergeSealEntries(
    register: DivergenceRegister,
    newEntries: DivergenceEntry[],
    sceneId: string
): DivergenceRegister {
    if (newEntries.length === 0) return register;

    const entries = [...register.entries, ...newEntries];

    return {
        entries,
        chapterToggles: register.chapterToggles,
        categoryToggles: register.categoryToggles,
        lastUpdatedSceneId: sceneId,
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}

/**
 * Applies guarded state replacements. Existing `mergeSealEntries` remains append-only
 * for legacy callers such as the arc engine.
 */
export function mergeLifecycleEntries(
    register: DivergenceRegister,
    newEntries: DivergenceEntry[],
    sceneId: string,
): DivergenceRegister {
    if (newEntries.length === 0) return register;

    const entries = [...register.entries];
    for (const extracted of newEntries) {
        // This is an extraction instruction, not persistent campaign data.
        const { supersedesFactId, ...entry } = extracted;
        const nextEntry: DivergenceEntry = { ...entry, status: 'active' };

        // Fail closed: replace only an active, unpinned fact in the exact same
        // state slot. Ambiguous model output becomes a harmless additive fact.
        if (supersedesFactId && isValidStateKey(nextEntry.stateKey)) {
            const targetIndex = entries.findIndex(e => e.id === supersedesFactId);
            const target = targetIndex >= 0 ? entries[targetIndex] : undefined;
            if (target && isFactActive(target) && !target.pinned && target.stateKey === nextEntry.stateKey) {
                entries[targetIndex] = {
                    ...target,
                    status: 'superseded',
                    supersededBy: nextEntry.id,
                };
            }
        }

        entries.push(nextEntry);
    }

    return {
        entries,
        chapterToggles: register.chapterToggles,
        categoryToggles: register.categoryToggles,
        lastUpdatedSceneId: sceneId,
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}

export function renderRegisterForPayload(
    register: DivergenceRegister,
    chapters?: import('../../types').ArchiveChapter[],
    onStageNpcIds?: string[],
    npcLedger?: NPCEntry[],
    publicOnly = false
): string {
    if (register.entries.length === 0) return '';

    const chapterTitleMap = new Map<string, string>();
    if (chapters) {
        for (const ch of chapters) {
            chapterTitleMap.set(ch.chapterId, ch.title);
        }
    }

    const activeEntries = register.entries.filter(e => {
        // Cached-canon path (publicOnly) renders ONLY broadcast facts. Scoped facts
        // (knownBy defined, incl. pinned ones) are withheld from the cached prefix and
        // surfaced per-turn in the [FACTS KNOWN TO ON-STAGE CHARACTERS] world block
        // instead. "Is knownBy defined" is a static fact property → cast-independent →
        // cache-safe: the cached block stays byte-identical when only the cast changes.
        if (publicOnly && e.knownBy !== undefined) return false;
        if (e.enabled === false) return false;
        if (!isFactActive(e)) return false;
        if (e.pinned) return true;
        const chapterOn = register.chapterToggles[e.chapterId] !== false;
        if (!chapterOn) return false;
        const catToggles = register.categoryToggles[e.chapterId];
        if (catToggles && catToggles[e.category] === false) return false;
        return true;
    });

    if (activeEntries.length === 0) return '';

    const onStageSet = new Set(onStageNpcIds ?? []);
    const offStageSet = new Set<string>();
    if (npcLedger && onStageSet.size > 0) {
        for (const n of npcLedger) {
            if (!n.archived && !onStageSet.has(n.id)) {
                offStageSet.add(n.id);
            }
        }
    }

    const byChapter = new Map<string, DivergenceEntry[]>();
    for (const e of activeEntries) {
        if (!byChapter.has(e.chapterId)) byChapter.set(e.chapterId, []);
        byChapter.get(e.chapterId)!.push(e);
    }

    const renderEntries = (entries: DivergenceEntry[]): string => {
        const byCategory = new Map<DivergenceCategory, DivergenceEntry[]>();
        for (const e of entries) {
            if (!byCategory.has(e.category)) byCategory.set(e.category, []);
            byCategory.get(e.category)!.push(e);
        }

        const catSections: string[] = [];
        for (const [cat, catEntries] of byCategory) {
            const label = CATEGORY_LABELS[cat] ?? cat.toUpperCase();
            const lines = catEntries.map(e => {
                const pin = e.pinned ? ' ★' : '';
                const manual = e.source === 'manual' ? ' ⚡' : '';
                return `• ${e.text}${pin}${manual}`;
            });
            catSections.push(`${label}:\n${lines.join('\n')}`);
        }
        return catSections.join('\n\n');
    };

    if (onStageSet.size === 0 || offStageSet.size === 0) {
        const sections: string[] = [];
        for (const [chapterId, chapterEntries] of byChapter) {
            const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
            sections.push(`${title}:\n${renderEntries(chapterEntries)}`);
        }
        const pinnedCount = register.entries.filter(e => e.pinned).length;
        const banner = `${activeEntries.length} active facts across ${byChapter.size} chapters${pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}`;
        return `[ESTABLISHED FACTS]\n[${banner}]\nThese facts are TRUE in this campaign.\n\n${sections.join('\n\n')}\n[END ESTABLISHED FACTS]`;
    }

    const onStageEntries = activeEntries;
    // Off-stage view: facts an off-stage NPC would know. Resolves the knownBy token
    // grammar (npc:<id>, faction:<name>, player, bare ID) via knowledgeScope.
    //   - undefined knownBy → public → off-stage NPCs know it (include)
    //   - [] → secret → nobody knows it (exclude)
    //   - 'player' token alone → only the player knows it; off-stage NPCs do not (exclude)
    //   - 'npc:<id>' / bare id → include iff that NPC is off-stage
    //   - 'faction:<name>' → include iff some off-stage NPC is in that faction
    const offStageNpcIds = [...offStageSet];
    const offStageEntries = activeEntries.filter(e => {
        if (e.knownBy === undefined) return true;
        return isKnownToAnyOnStage(e.knownBy, offStageNpcIds, npcLedger ?? []);
    });

    const sections: string[] = [];
    for (const [chapterId, chapterEntries] of byChapter) {
        const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
        sections.push(`${title}:\n${renderEntries(chapterEntries)}`);
    }
    const pinnedCount = register.entries.filter(e => e.pinned).length;
    const banner = `${activeEntries.length} active facts across ${byChapter.size} chapters${pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}`;

    if (offStageEntries.length === activeEntries.length) {
        return `[ESTABLISHED FACTS]\n[${banner}]\nThese facts are TRUE in this campaign.\n\n${sections.join('\n\n')}\n[END ESTABLISHED FACTS]`;
    }

    const onStageSections: string[] = [];
    const onStageByChapter = new Map<string, DivergenceEntry[]>();
    for (const e of onStageEntries) {
        if (!onStageByChapter.has(e.chapterId)) onStageByChapter.set(e.chapterId, []);
        onStageByChapter.get(e.chapterId)!.push(e);
    }
    for (const [chapterId, chapterEntries] of onStageByChapter) {
        const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
        onStageSections.push(`${title}:\n${renderEntries(chapterEntries)}`);
    }

    const offStageSections: string[] = [];
    const offStageByChapter = new Map<string, DivergenceEntry[]>();
    for (const e of offStageEntries) {
        if (!offStageByChapter.has(e.chapterId)) offStageByChapter.set(e.chapterId, []);
        offStageByChapter.get(e.chapterId)!.push(e);
    }
    for (const [chapterId, chapterEntries] of offStageByChapter) {
        const title = chapterTitleMap.get(chapterId) ?? `Chapter ${chapterId}`;
        offStageSections.push(`${title}:\n${renderEntries(chapterEntries)}`);
    }

    const onStageBanner = `${onStageEntries.length} facts (on-stage view · all)`;
    const offStageBanner = `${offStageEntries.length} facts (off-stage view · bounded)`;

    return `[ESTABLISHED FACTS — ON-STAGE]\n[${onStageBanner}]\n${onStageSections.join('\n\n')}\n[END ON-STAGE FACTS]\n\n[ESTABLISHED FACTS — OFF-STAGE]\n[${offStageBanner}]\n${offStageSections.join('\n\n')}\n[END OFF-STAGE FACTS]`;
}

export function countRegisterTokens(register: DivergenceRegister): number {
    return countTokens(renderRegisterForPayload(register));
}

export function getDivergenceSceneIds(register: DivergenceRegister): Set<string> {
    const ids = new Set<string>();
    for (const e of register.entries) {
        ids.add(e.sceneRef);
    }
    return ids;
}

export function toggleChapter(register: DivergenceRegister, chapterId: string, on: boolean): DivergenceRegister {
    return {
        ...register,
        chapterToggles: { ...register.chapterToggles, [chapterId]: on },
        lastUpdatedAt: Date.now(),
    };
}

export function toggleCategory(register: DivergenceRegister, chapterId: string, category: DivergenceCategory, on: boolean): DivergenceRegister {
    const existing = register.categoryToggles[chapterId] ?? {};
    return {
        ...register,
        categoryToggles: {
            ...register.categoryToggles,
            [chapterId]: { ...existing, [category]: on },
        },
        lastUpdatedAt: Date.now(),
    };
}

export function pinFact(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, pinned: !e.pinned } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function editFact(register: DivergenceRegister, entryId: string, text: string): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, text, source: 'manual' as const } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function deleteFact(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.filter(e => e.id !== entryId);
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function dismissReviewFlag(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, reviewFlag: undefined, unrecognizedNpcNames: undefined } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function toggleFact(register: DivergenceRegister, factId: string): DivergenceRegister {
    const entries = register.entries.map(e => {
        if (e.id !== factId) return e;
        const currentEnabled = e.enabled !== false;
        return { ...e, enabled: !currentEnabled };
    });
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function deleteChapter(register: DivergenceRegister, sceneId: string): DivergenceRegister {
    const entries = register.entries.filter(
        e => e.sceneRef !== sceneId || e.source === 'manual'
    );
    const chapterToggles = { ...register.chapterToggles };
    delete chapterToggles[sceneId];
    return { ...register, entries, chapterToggles, lastUpdatedAt: Date.now() };
}

export function resetRegister(): DivergenceRegister {
    return { ...EMPTY_REGISTER, lastUpdatedAt: Date.now() };
}

export function deleteReviewedEntry(register: DivergenceRegister, id: string): DivergenceRegister {
    const entries = register.entries.filter(e => e.id !== id);
    const prunedLog = (register.prunedLog ?? []).filter(e => e.id !== id);
    return { ...register, entries, prunedLog, lastUpdatedAt: Date.now() };
}

export function getEntriesForChapter(register: DivergenceRegister, chapterId: string): DivergenceEntry[] {
    return register.entries.filter(e => e.chapterId === chapterId);
}

export function getEntriesForNpc(register: DivergenceRegister, npcId: string): DivergenceEntry[] {
    return register.entries.filter(e => e.npcIds.includes(npcId));
}

export function migrateV1ToV2(v1: { entries: unknown[]; lastUpdatedSceneId?: string; lastUpdatedAt?: number; version?: number }): DivergenceRegister {
    console.log('[DivergenceRegister] Migrating v1 register to v2 — wiping all entries');
    toast.info('Divergence register redesigned. Existing entries cleared. New facts will be extracted at chapter seal.');
    return {
        entries: [],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: v1.lastUpdatedSceneId ?? '',
        lastUpdatedAt: Date.now(),
        version: 2,
    };
}

export async function pruneChapterEntries(
    provider: EndpointConfig | ProviderConfig,
    chapter: ArchiveChapter,
    register: DivergenceRegister,
    allChapters: ArchiveChapter[]
): Promise<DivergenceRegister> {
    const chapterEntries = getEntriesForChapter(register, chapter.chapterId);
    if (chapterEntries.length === 0) return register;

    const otherChapterSummaries = allChapters
        .filter(c => c.chapterId !== chapter.chapterId && c.summary)
        .map(c => `Chapter "${c.title}" (${c.chapterId}): ${c.summary}`)
        .join('\n\n');

    const entryLines = chapterEntries.map((e, i) =>
        `[${i}] (${e.category}) ${e.text}${e.pinned ? ' [PINNED]' : ''}`
    ).join('\n');

    const prompt = `You are a TTRPG campaign consistency checker. After sealing a chapter, some divergence entries may be redundant, contradicted, or no longer relevant.

SEALED CHAPTER: "${chapter.title}" (${chapter.chapterId})
CHAPTER SUMMARY: ${chapter.summary || '(no summary)'}
UNRESOLVED THREADS: ${chapter.unresolvedThreads?.join('; ') || '(none)'}

OTHER CHAPTER SUMMARIES:
${otherChapterSummaries || '(no other chapters)'}

DIVERGENCE ENTRIES FOR THIS CHAPTER:
${entryLines}

Decide which entries to KEEP (still relevant to future scenes) and which to DROP (redundant, contradicted, or no longer consequential).

Reply with ONLY a JSON array of integers — the indices of entries to KEEP. Example: [0, 2, 5]
If all entries should be kept, reply with all indices. If none matter, reply with [].`;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const raw = await llmCall(provider, prompt, { priority: 'low', maxTokens: 500 });
            const cleaned = raw.replace(/```json\s*|```\s*/g, '').trim();
            const indices: number[] = JSON.parse(cleaned);

            if (!Array.isArray(indices) || indices.some(i => typeof i !== 'number')) {
                console.warn('[PruneChapter] LLM returned non-integer array, keeping all entries');
                return register;
            }

            const keepSet = new Set(indices);
            const filtered = chapterEntries.filter((_, i) => keepSet.has(i));
            const remainingEntries = register.entries.filter(e => e.chapterId !== chapter.chapterId).concat(filtered);

            const pruned: DivergenceRegister = {
                ...register,
                entries: remainingEntries,
                lastUpdatedAt: Date.now(),
            };

            const removed = chapterEntries.length - filtered.length;
            if (removed > 0) {
                console.log(`[PruneChapter] Removed ${removed}/${chapterEntries.length} entries for chapter ${chapter.chapterId}`);
            }

            return pruned;
        } catch (err) {
            console.warn(`[PruneChapter] Attempt ${attempt + 1} failed:`, err);
        }
    }

    return register;
}