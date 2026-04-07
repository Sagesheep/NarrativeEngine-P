import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, ArchiveScene } from '../types';
import { extractContextActivations, expandActivationsWithFacts, retrieveArchiveMemory, fetchArchiveScenes } from './archiveMemory';

const AUTO_SEAL_SCENE_THRESHOLD = 25; // ~25 exchanges is a meaningful arc

// Phase 3 constants
const MAX_LLM_ITERATIONS = 5;
const MAX_CONFIRMED_CHAPTERS = 3;

export type AutoSealResult = {
    shouldSeal: boolean;
    reason: string;
    sessionId?: string;
};

/**
 * Extract SESSION_IDs from header index string.
 * Parses lines like "SESSION_ID: abc-123-def"
 */
export function extractSessionIds(headerIndex: string): string[] {
    const matches = headerIndex.match(/SESSION_ID:\s*(\S+)/g) || [];
    return matches.map(m => m.replace('SESSION_ID:', '').trim());
}

/**
 * Check if a chapter should be auto-sealed based on scene threshold or session boundary.
 * Returns the most recent sessionId if available (for tracking on the new chapter).
 */
export function shouldAutoSeal(
    chapters: ArchiveChapter[],
    headerIndex: string
): AutoSealResult {
    const openChapter = chapters.find(c => !c.sealedAt);
    if (!openChapter) {
        return { shouldSeal: false, reason: 'no_open_chapter' };
    }

    // Count scenes in open chapter's range
    const startNum = parseInt(openChapter.sceneRange[0], 10);
    const endNum = parseInt(openChapter.sceneRange[1], 10);
    const sceneCount = endNum - startNum + 1;

    if (sceneCount >= AUTO_SEAL_SCENE_THRESHOLD) {
        return { shouldSeal: true, reason: 'scene_threshold' };
    }

    // Check for new SESSION_ID in header index that doesn't match open chapter
    const sessionIds = extractSessionIds(headerIndex);
    const lastSessionId = sessionIds[sessionIds.length - 1];
    
    if (lastSessionId && openChapter._lastSeenSessionId && lastSessionId !== openChapter._lastSeenSessionId) {
        return { shouldSeal: true, reason: 'session_boundary', sessionId: lastSessionId };
    }

    return { shouldSeal: false, reason: '' };
}

/**
 * Seal the open chapter and create a new open chapter.
 * Returns the sealed chapter and the new open chapter.
 */
export function sealChapter(
    chapters: ArchiveChapter[],
    currentSessionId?: string
): { sealedChapter: ArchiveChapter; newOpenChapter: ArchiveChapter } {
    const openChapter = chapters.find(c => !c.sealedAt);
    if (!openChapter) {
        throw new Error('No open chapter to seal');
    }

    // Determine next scene number
    const lastScene = parseInt(openChapter.sceneRange[1], 10);
    const nextScene = String(lastScene + 1).padStart(3, '0');

    // Seal the open chapter
    const sealed: ArchiveChapter = {
        ...openChapter,
        sealedAt: Date.now(),
    };

    // Create new open chapter
    const nextChapterNum = chapters.length + 1;
    const newOpen: ArchiveChapter = {
        chapterId: `CH${String(nextChapterNum).padStart(2, '0')}`,
        title: 'Open Chapter',
        sceneRange: [nextScene, nextScene],
        summary: '',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 0,
        _lastSeenSessionId: currentSessionId,
    };

    return { sealedChapter: sealed, newOpenChapter: newOpen };
}

/**
 * Update the open chapter's _lastSeenSessionId if it hasn't been set yet.
 * Call this when a new chapter is created or when first sessionId is detected.
 */
export function updateChapterSessionId(
    chapters: ArchiveChapter[],
    sessionId: string
): ArchiveChapter[] {
    const openChapter = chapters.find(c => !c.sealedAt);
    if (!openChapter) return chapters;
    
    if (!openChapter._lastSeenSessionId) {
        return chapters.map(c => 
            c.chapterId === openChapter.chapterId 
                ? { ...c, _lastSeenSessionId: sessionId }
                : c
        );
    }
    return chapters;
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 3 — Iterative Funnel Retrieval
// Chapter-aware archive retrieval using 3D scoring + iterative LLM validation.
// ─────────────────────────────────────────────────────────────────────────────

// Re-export types for Phase 3
export type EndpointConfig = {
    endpoint: string;
    apiKey: string;
    modelName: string;
};

export type ProviderConfig = EndpointConfig;

// ─── 3A. Chapter-Level 3D Scoring ───

/**
 * Score a single chapter using 3D scoring formula adapted for chapters.
 * score = (0.5 × recency) + (1.0 × importance) + (2.0 × activation)
 */
export function scoreChapter(
    chapter: ArchiveChapter,
    contextActivations: Record<string, number>,
    latestSceneNum: number
): number {
    // D1: Recency — use sceneRange midpoint position relative to current scene
    const midScene = (parseInt(chapter.sceneRange[0]) + parseInt(chapter.sceneRange[1])) / 2;
    const chaptersSince = latestSceneNum - midScene;
    const recencyBonus = 1 / (1 + Math.log(1 + Math.max(0, chaptersSince)));

    // D2: Intrinsic importance — derived from majorEvents count + has unresolved threads
    const importance = Math.min(10, 3 + chapter.majorEvents.length + (chapter.unresolvedThreads.length * 2));

    // D3: Activation strength — keyword + NPC match against current context
    let activation = 0;
    for (const keyword of chapter.keywords) {
        const kw = keyword.toLowerCase();
        if (contextActivations[kw]) {
            activation += contextActivations[kw] * 1.0;
        }
    }
    for (const npc of chapter.npcs) {
        const npcLower = npc.toLowerCase();
        if (contextActivations[npcLower]) {
            activation += contextActivations[npcLower] * 2.0; // NPCs weighted higher
        }
    }

    return (0.5 * recencyBonus) + (1.0 * importance) + (2.0 * activation);
}

/**
 * Rank all sealed chapters with summaries by 3D score.
 * Returns chapters sorted by score descending (best first).
 */
export function rankChapters(
    chapters: ArchiveChapter[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    semanticFacts?: { subject: string; predicate: string; object: string; importance: number }[]
): ArchiveChapter[] {
    // Only score sealed chapters with summaries
    const sealed = chapters.filter(c => c.sealedAt && c.summary);

    if (sealed.length === 0) return [];

    const contextActivations = extractContextActivations(userMessage, recentMessages, npcLedger);
    const expandedActivations = expandActivationsWithFacts(contextActivations, semanticFacts);

    // Find the latest scene number from all chapters
    const allEndScenes = chapters.map(c => parseInt(c.sceneRange[1], 10));
    const latestSceneNum = Math.max(...allEndScenes, 0);

    const scored = sealed.map(ch => ({
        chapter: ch,
        score: scoreChapter(ch, expandedActivations, latestSceneNum),
    }));

    return scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(s => s.chapter);
}

// ─── 3B. Iterative LLM Validation ───

/**
 * Ask LLM if a chapter is relevant to current context.
 * Uses tiny prompt (~200 tokens), expects YES/NO response (~5 tokens).
 * Fail-open: returns true on any error (never lose data).
 */
async function validateChapterRelevance(
    chapter: ArchiveChapter,
    userMessage: string,
    recentContext: string,
    provider: EndpointConfig | ProviderConfig
): Promise<boolean> {
    const prompt = [
        'You are a TTRPG story continuity checker. Given the current situation and a chapter summary, is this chapter relevant?',
        '',
        'Respond with ONLY: YES or NO',
        '',
        'CURRENT SITUATION:',
        userMessage.slice(0, 200), // Truncate to keep prompt small
        '',
        'RECENT CONTEXT:',
        recentContext.slice(-500), // keep it small
        '',
        'CHAPTER SUMMARY:',
        `Title: ${chapter.title}`,
        `Scenes: ${chapter.sceneRange[0]}-${chapter.sceneRange[1]}`,
        chapter.summary.slice(0, 300), // truncate to keep prompt small
        `NPCs: ${chapter.npcs.join(', ')}`,
        `Key events: ${chapter.majorEvents.slice(0, 3).join('; ')}`,
    ].join('\n');

    // 3s timeout per validation call — matches the outer FUNNEL_TIMEOUT_MS in turnOrchestrator
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
        const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

        const res = await fetch(url, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                model: provider.modelName,
                messages: [{ role: 'user', content: prompt }],
                stream: false,
                max_tokens: 10, // we only need YES/NO
            }),
        });

        clearTimeout(timeoutId);
        if (!res.ok) return true; // on failure, assume relevant (don't lose data)

        const data = await res.json();
        const answer = (data.choices?.[0]?.message?.content ?? '').trim().toUpperCase();
        return answer.startsWith('YES');
    } catch {
        clearTimeout(timeoutId);
        return true; // on timeout/error, assume relevant (fail-open)
    }
}

/**
 * Iteratively validate chapters with LLM until we have MAX_CONFIRMED_CHAPTERS
 * or reach MAX_LLM_ITERATIONS.
 * If no utilityProvider, gracefully degrades to top 3 by 3D score.
 */
export async function iterativeChapterFilter(
    rankedChapters: ArchiveChapter[],
    userMessage: string,
    recentMessages: ChatMessage[],
    utilityProvider?: EndpointConfig | ProviderConfig
): Promise<ArchiveChapter[]> {
    // If no utility AI configured, accept top 3 by 3D score (graceful degradation)
    if (!utilityProvider) {
        return rankedChapters.slice(0, MAX_CONFIRMED_CHAPTERS);
    }

    const recentContext = recentMessages.slice(-5).map(m => m.content || '').join('\n');
    const confirmed: ArchiveChapter[] = [];
    let iterations = 0;

    for (const chapter of rankedChapters) {
        if (confirmed.length >= MAX_CONFIRMED_CHAPTERS) break;
        if (iterations >= MAX_LLM_ITERATIONS) break;

        const isRelevant = await validateChapterRelevance(
            chapter, userMessage, recentContext, utilityProvider
        );
        iterations++;

        if (isRelevant) {
            confirmed.push(chapter);
        }
        // If NO → continue to next ranked chapter
    }

    return confirmed;
}

// ─── 3D. Main Funnel Orchestrator ───

/**
 * Main chapter-aware retrieval funnel.
 *
 * Phase 1: Chapter-level 3D scoring
 * Phase 2: Iterative LLM validation
 * Phase 3: Build scene ranges from confirmed chapters + open chapter
 * Phase 4: Scene-level 3D scoring within ranges
 * Phase 5: Fetch scenes within token budget
 */
export async function recallWithChapterFunnel(
    chapters: ArchiveChapter[],
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    semanticFacts?: { subject: string; predicate: string; object: string; importance: number }[],
    utilityProvider?: EndpointConfig | ProviderConfig,
    campaignId?: string,
    tokenBudget = 3000
): Promise<ArchiveScene[]> {
    // ─── Phase 1: Chapter-level 3D scoring ───
    const ranked = rankChapters(chapters, userMessage, recentMessages, npcLedger, semanticFacts);

    if (ranked.length === 0) {
        // No sealed chapters with summaries — fall back to open chapter scenes only
        // or full flat retrieval handled by caller
        return [];
    }

    // ─── Phase 2: Iterative LLM validation ───
    const confirmed = await iterativeChapterFilter(
        ranked, userMessage, recentMessages, utilityProvider
    );

    // ─── Phase 3: Build scene ranges ───
    const sceneRanges: [string, string][] = confirmed.map(ch => ch.sceneRange);

    // Always include the open chapter's scenes
    const openChapter = chapters.find(c => !c.sealedAt);
    if (openChapter) {
        sceneRanges.push(openChapter.sceneRange);
    }

    // ─── Phase 4: Scene-level 3D scoring within ranges ───
    const matchedIds = retrieveArchiveMemory(
        index, userMessage, recentMessages, npcLedger,
        undefined, semanticFacts, sceneRanges
    );

    if (matchedIds.length === 0) return [];

    // ─── Phase 5: Fetch within budget ───
    if (!campaignId) return [];
    return fetchArchiveScenes(campaignId, matchedIds, tokenBudget);
}

// Re-export constants for testing
export { MAX_LLM_ITERATIONS, MAX_CONFIRMED_CHAPTERS };

