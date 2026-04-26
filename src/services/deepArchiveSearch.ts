import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage, EndpointConfig } from '../types';
import { callLLM } from './callLLM';
import { fetchArchiveScenes } from './archiveMemory';

const TIMEOUT_CHAPTER_SCAN_MS = 120_000;
const TIMEOUT_SCENE_SCAN_MS = 210_000;
const TIMEOUT_SUMMARIZE_MS = 180_000;

function extractJson(text: string): string {
    let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) clean = mdMatch[1];
    const firstObj = clean.indexOf('{');
    const lastObj = clean.lastIndexOf('}');
    const firstArr = clean.indexOf('[');
    const lastArr = clean.lastIndexOf(']');
    if (firstObj !== -1 && lastObj > firstObj && (firstArr === -1 || firstObj < firstArr)) {
        return clean.substring(firstObj, lastObj + 1);
    }
    if (firstArr !== -1 && lastArr > firstArr) {
        return clean.substring(firstArr, lastArr + 1);
    }
    return clean.trim();
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`[DeepArchiveSearch] ${label} timed out after ${ms}ms`));
        }, ms);
        promise.then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

function buildConversationExcerpt(messages: ChatMessage[], userMessage: string, depth = 6): string {
    const recent = messages.slice(-depth);
    const lines = recent.map(m => {
        const role = m.role === 'user' ? 'PLAYER' : m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
        return `[${role}]: ${(m.content || '').slice(0, 300)}`;
    });
    lines.push(`[PLAYER]: ${userMessage.slice(0, 300)}`);
    return lines.join('\n\n');
}

function buildChapterOverview(chapters: ArchiveChapter[]): string {
    return chapters.map(ch => {
        const parts = [
            `[${ch.chapterId}] ${ch.title} (Scenes ${ch.sceneRange[0]}\u2013${ch.sceneRange[1]})`,
            `  Summary: ${ch.summary.slice(0, 200)}`,
        ];
        if (ch.npcs.length > 0) parts.push(`  NPCs: ${ch.npcs.join(', ')}`);
        if (ch.majorEvents.length > 0) parts.push(`  Events: ${ch.majorEvents.slice(0, 3).join('; ')}`);
        if (ch.keywords.length > 0) parts.push(`  Keywords: ${ch.keywords.slice(0, 10).join(', ')}`);
        return parts.join('\n');
    }).join('\n\n');
}

function buildSceneOverview(
    entries: ArchiveIndexEntry[],
    chapterRanges: [string, string][],
    targetTokens: number
): string {
    const filtered = entries.filter(entry => {
        const sceneNum = parseInt(entry.sceneId, 10);
        return chapterRanges.some(([start, end]) => {
            const s = parseInt(start, 10);
            const e = parseInt(end, 10);
            return sceneNum >= s && sceneNum <= e;
        });
    });

    const sorted = [...filtered].sort((a, b) => (b.importance ?? 5) - (a.importance ?? 5));

    const tokensPerEntry = targetTokens / Math.max(sorted.length, 1);
    const compact = tokensPerEntry < 140;

    return sorted.map(entry => {
        const parts = [`[${entry.sceneId}] imp:${entry.importance ?? 5}`];
        if (entry.npcsMentioned.length > 0) parts.push(`npcs:${entry.npcsMentioned.join(',')}`);
        if (entry.keywords.length > 0) parts.push(`kw:${entry.keywords.slice(0, 8).join(',')}`);
        if (!compact && entry.userSnippet) parts.push(`"${entry.userSnippet.slice(0, 120)}"`);
        return parts.join(' ');
    }).join('\n');
}

async function scanChapters(
    utilityEndpoint: EndpointConfig,
    sealedChapters: ArchiveChapter[],
    messages: ChatMessage[],
    userMessage: string,
    signal?: AbortSignal
): Promise<string[]> {
    const overview = buildChapterOverview(sealedChapters);
    const conversation = buildConversationExcerpt(messages, userMessage);

    const prompt = [
        'You are a narrative archaeologist for a tabletop RPG engine.',
        'Given the current conversation and a list of sealed campaign chapters, identify ALL chapters that contain scenes relevant to the current narrative moment.',
        'Consider: direct references, NPC involvement, unresolved plot threads, foreshadowing, location continuity, thematic connections.',
        'Return EVERY relevant chapter \u2014 do not artificially limit the count.',
        '',
        '[SEALED CHAPTERS]',
        overview,
        '',
        '[RECENT CONVERSATION]',
        conversation,
        '',
        'Respond with ONLY valid JSON in this exact format:',
        '{"chapters": ["CH01", "CH03", ...]}',
    ].join('\n');

    const rawContent = await withTimeout(
        callLLM(utilityEndpoint, prompt, {
            temperature: 0.1,
            signal,
            priority: 'high',
        }),
        TIMEOUT_CHAPTER_SCAN_MS,
        'Chapter scan'
    );

    const jsonStr = extractJson(rawContent);
    try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.chapters && Array.isArray(parsed.chapters)) {
            const validIds = new Set(sealedChapters.map(c => c.chapterId));
            return parsed.chapters.filter((id: unknown) => typeof id === 'string' && validIds.has(id));
        }
    } catch {
        console.warn('[DeepArchiveSearch] Failed to parse chapter scan response');
    }
    return [];
}

async function scanScenes(
    utilityEndpoint: EndpointConfig,
    archiveIndex: ArchiveIndexEntry[],
    selectedChapters: ArchiveChapter[],
    messages: ChatMessage[],
    userMessage: string,
    signal?: AbortSignal
): Promise<Set<string>> {
    const chapterRanges: [string, string][] = selectedChapters.map(c => c.sceneRange);
    const targetTokens = 20000;
    const overview = buildSceneOverview(archiveIndex, chapterRanges, targetTokens);
    const conversation = buildConversationExcerpt(messages, userMessage);

    const prompt = [
        'You are a narrative archaeologist for a tabletop RPG engine.',
        'Given the current conversation and scene index entries from selected chapters, identify ALL scenes that are relevant.',
        'Consider: direct references, NPC involvement, unresolved threads, foreshadowing, location continuity, thematic connections.',
        'Return EVERY relevant scene ID \u2014 do not artificially limit the count.',
        '',
        '[SCENE INDEX \u2014 selected chapters]',
        overview,
        '',
        '[RECENT CONVERSATION]',
        conversation,
        '',
        'Respond with ONLY valid JSON in this exact format:',
        '{"scenes": ["042", "011", ...]}',
    ].join('\n');

    const rawContent = await withTimeout(
        callLLM(utilityEndpoint, prompt, {
            temperature: 0.1,
            signal,
            priority: 'high',
        }),
        TIMEOUT_SCENE_SCAN_MS,
        'Scene scan'
    );

    const jsonStr = extractJson(rawContent);
    const result = new Set<string>();
    try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.scenes && Array.isArray(parsed.scenes)) {
            const validIds = new Set(archiveIndex.map(e => e.sceneId));
            for (const id of parsed.scenes) {
                if (typeof id === 'string' && validIds.has(id)) {
                    result.add(id);
                }
            }
        }
    } catch {
        console.warn('[DeepArchiveSearch] Failed to parse scene scan response');
    }
    return result;
}

async function summarizeToBudget(
    utilityEndpoint: EndpointConfig,
    text: string,
    budget: number,
    signal?: AbortSignal
): Promise<string> {
    const prompt = [
        'Compress this narrative content to its essential lore facts. Preserve:',
        '- NPC states, relationships, and motivations',
        '- Key outcomes and consequences',
        '- Unresolved threads and foreshadowing',
        '- Location and timeline continuity',
        '',
        `Target approximately ${budget} tokens. Be concise but complete.`,
        '',
        '[NARRATIVE CONTENT]',
        text,
    ].join('\n');

    return withTimeout(
        callLLM(utilityEndpoint, prompt, {
            temperature: 0.2,
            signal,
            priority: 'high',
            maxTokens: Math.min(budget * 2, 8000),
        }),
        TIMEOUT_SUMMARIZE_MS,
        'Summarize'
    );
}

async function summarizePartitions(
    utilityEndpoint: EndpointConfig,
    sceneTexts: string[],
    budget: number,
    signal?: AbortSignal
): Promise<string> {
    const PARTITION_SIZE = 8000;

    if (sceneTexts.length <= 1) {
        return summarizeToBudget(utilityEndpoint, sceneTexts[0] || '', budget, signal);
    }

    const totalTokens = sceneTexts.reduce((sum, t) => sum + estimateTokens(t), 0);

    if (totalTokens <= budget) {
        const combined = sceneTexts.map((t, i) => `[Scene Partition ${i + 1}]\n${t}`).join('\n\n');
        return summarizeToBudget(utilityEndpoint, combined, budget, signal);
    }

    const partitions: string[] = [];
    let current: string[] = [];
    let currentTokens = 0;

    for (const text of sceneTexts) {
        const t = estimateTokens(text);
        if (currentTokens + t > PARTITION_SIZE && current.length > 0) {
            partitions.push(current.join('\n\n'));
            current = [];
            currentTokens = 0;
        }
        current.push(text);
        currentTokens += t;
    }
    if (current.length > 0) {
        partitions.push(current.join('\n\n'));
    }

    const partitionBudget = Math.floor(budget / Math.max(partitions.length, 1));
    const partitionSummaries: string[] = [];

    for (let i = 0; i < partitions.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
            const summary = await summarizeToBudget(utilityEndpoint, partitions[i], partitionBudget, signal);
            partitionSummaries.push(`[Partition ${i + 1} Summary]\n${summary}`);
        } catch (err) {
            console.warn(`[DeepArchiveSearch] Partition ${i + 1}/${partitions.length} failed:`, err);
            if (partitionSummaries.length === 0) throw err;
        }
    }

    if (partitionSummaries.length <= 1) {
        return partitionSummaries[0] || '';
    }

    const mergePrompt = [
        'Merge these narrative summaries into one coherent brief. Preserve all unique lore facts, NPC states, outcomes, and unresolved threads.',
        `Target approximately ${budget} tokens.`,
        '',
        ...partitionSummaries,
    ].join('\n\n');

    return callLLM(utilityEndpoint, mergePrompt, {
        temperature: 0.2,
        signal,
        priority: 'high',
        maxTokens: Math.min(budget * 2, 8000),
    });
}

export async function deepArchiveScan(
    utilityEndpoint: EndpointConfig,
    archiveIndex: ArchiveIndexEntry[],
    sealedChapters: ArchiveChapter[],
    campaignId: string,
    messages: ChatMessage[],
    userMessage: string,
    availableBudget: number,
    onStatus: (msg: string) => void,
    signal?: AbortSignal
): Promise<string> {
    if (sealedChapters.length === 0) {
        console.log('[DeepArchiveSearch] No sealed chapters \u2014 skipping');
        return '';
    }

    onStatus('Deep Archive: Scanning chapters...');
    console.log(`[DeepArchiveSearch] Round 1: Scanning ${sealedChapters.length} sealed chapters`);

    let selectedChapterIds: string[];
    try {
        selectedChapterIds = await scanChapters(utilityEndpoint, sealedChapters, messages, userMessage, signal);
    } catch (err) {
        console.warn('[DeepArchiveSearch] Chapter scan failed:', err);
        return '';
    }

    if (selectedChapterIds.length === 0) {
        console.log('[DeepArchiveSearch] No relevant chapters found \u2014 aborting');
        return '';
    }
    console.log(`[DeepArchiveSearch] Round 1: ${sealedChapters.length} chapters \u2192 ${selectedChapterIds.length} selected`);

    const selectedChapters = sealedChapters.filter(c => selectedChapterIds.includes(c.chapterId));

    onStatus(`Deep Archive: Scanning scenes in ${selectedChapterIds.length} chapters...`);
    let notebookIds: Set<string>;
    try {
        notebookIds = await scanScenes(utilityEndpoint, archiveIndex, selectedChapters, messages, userMessage, signal);
    } catch (err) {
        console.warn('[DeepArchiveSearch] Scene scan failed:', err);
        return '';
    }
    console.log(`[DeepArchiveSearch] Round 1 scenes: ${notebookIds.size} selected`);

    const scannedSceneRanges = selectedChapters.map(c => c.sceneRange);
    for (const id of notebookIds) {
        const sceneNum = parseInt(id, 10);
        const inScanned = scannedSceneRanges.some(([start, end]) => {
            return sceneNum >= parseInt(start, 10) && sceneNum <= parseInt(end, 10);
        });
        if (!inScanned) {
            const parentChapter = sealedChapters.find(c => {
                const s = parseInt(c.sceneRange[0], 10);
                const e = parseInt(c.sceneRange[1], 10);
                return sceneNum >= s && sceneNum <= e;
            });
            if (parentChapter && !selectedChapterIds.includes(parentChapter.chapterId)) {
                selectedChapterIds.push(parentChapter.chapterId);
                console.log(`[DeepArchiveSearch] Round 2: Adding unscanned chapter ${parentChapter.chapterId}`);
            }
        }
    }

    const additionalChapterIds = selectedChapterIds.filter(
        id => !selectedChapters.some(c => c.chapterId === id)
    );
    if (additionalChapterIds.length > 0) {
        onStatus('Deep Archive: Round 2 \u2014 scanning newly discovered chapters...');
        const additionalChapters = sealedChapters.filter(c => additionalChapterIds.includes(c.chapterId));
        try {
            const additionalIds = await scanScenes(utilityEndpoint, archiveIndex, additionalChapters, messages, userMessage, signal);
            for (const id of additionalIds) notebookIds.add(id);
            console.log(`[DeepArchiveSearch] Round 2: ${additionalChapters.length} new chapters \u2192 ${additionalIds.size} additional scenes`);
        } catch (err) {
            console.warn('[DeepArchiveSearch] Round 2 scene scan failed, proceeding with Round 1 results:', err);
        }
    }

    if (notebookIds.size === 0) {
        console.log('[DeepArchiveSearch] No scenes found \u2014 returning empty');
        return '';
    }

    onStatus(`Deep Archive: Fetching ${notebookIds.size} scenes...`);
    const scenes = await fetchArchiveScenes(campaignId, Array.from(notebookIds), availableBudget + availableBudget * 2);

    if (scenes.length === 0) {
        console.log('[DeepArchiveSearch] No scenes fetched \u2014 returning empty');
        return '';
    }

    const totalSceneTokens = scenes.reduce((sum, s) => sum + (s.tokens || estimateTokens(s.content)), 0);
    onStatus(`Deep Archive: Summarizing ${scenes.length} scenes (~${totalSceneTokens} tokens)...`);

    let deepContextSummary: string;

    try {
        if (totalSceneTokens <= availableBudget) {
            const combined = scenes.map(s => `[Scene #${s.sceneId}]\n${s.content}`).join('\n\n');
            deepContextSummary = await summarizeToBudget(utilityEndpoint, combined, availableBudget, signal);
        } else {
            const sceneTexts = scenes.map(s => `[Scene #${s.sceneId}]\n${s.content}`);
            deepContextSummary = await summarizePartitions(utilityEndpoint, sceneTexts, availableBudget, signal);
        }
    } catch (err) {
        console.warn('[DeepArchiveSearch] Summarization failed, using raw scene content:', err);
        const budgetChars = availableBudget * 4;
        const rawContent = scenes.map(s => `[Scene #${s.sceneId}]\n${s.content}`).join('\n\n');
        deepContextSummary = rawContent.slice(0, budgetChars);
    }

    const briefTokens = estimateTokens(deepContextSummary);
    console.log(`[DeepArchiveSearch] Brief generated: ~${briefTokens} tokens (budget: ${availableBudget})`);
    return deepContextSummary;
}