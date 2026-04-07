import type { ChatMessage, GameContext, ProviderConfig, EndpointConfig, CoreMemorySlot, ArchiveChapter } from '../types';
import { countTokens } from './tokenizer';

// ─── Header Index Section Headers (from header_index.md template) ───
const HEADER_INDEX_SECTIONS = [
    'SECTION 1 — ARC / SESSION HEADER DATABASE',
    'SECTION 2 — PENDING LOOPS',
];

const HEADER_INDEX_REQUIRED_FIELDS = [
    'SESSION_ID:',
    'SCENE_HEADERS:',
];

// ─── Validators ───

const DASH_VARIANTS = /[\u2014\u2013\u2012\u2010\u00AF\u02D7\u2011\u2043\u2212\u30FC\u2015]/g;
const REPLACEMENT_CHAR = /\uFFFD/g;

function normalizeForComparison(text: string): string {
    return text.normalize('NFC').replace(DASH_VARIANTS, '—').replace(REPLACEMENT_CHAR, '—');
}

function containsNormalized(haystack: string, needle: string): boolean {
    return normalizeForComparison(haystack).includes(normalizeForComparison(needle));
}

export function validateCanonState(output: string): { valid: boolean; missing: string[]; slots?: CoreMemorySlot[] } {
    const missing: string[] = [];

    let cleaned = output.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    let slots: CoreMemorySlot[] | undefined;
    try {
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) {
            return { valid: false, missing: ['Output is not a JSON array'] };
        }
        slots = parsed;

        const keys = new Set(parsed.map((s: any) => (s.key || '').toUpperCase()));
        if (!keys.has('PLAYER_STATUS')) missing.push('PLAYER_STATUS slot');
        if (!keys.has('LOCATION')) missing.push('LOCATION slot');
        if (!keys.has('TIME_DATE')) missing.push('TIME_DATE slot');

        for (const slot of parsed) {
            if (!slot.key || typeof slot.value !== 'string' || typeof slot.priority !== 'number') {
                missing.push('Invalid slot structure');
                break;
            }
        }
    } catch (e) {
        return { valid: false, missing: ['Failed to parse JSON'] };
    }

    return { valid: missing.length === 0, missing, slots };
}

export function validateHeaderIndex(output: string): { valid: boolean; missing: string[] } {
    const missing = [
        ...HEADER_INDEX_SECTIONS.filter((s) => !containsNormalized(output, s)),
        ...HEADER_INDEX_REQUIRED_FIELDS.filter((f) => !containsNormalized(output, f)),
    ];
    return { valid: missing.length === 0, missing };
}

// ─── LLM Call Helper ───

async function llmCall(provider: ProviderConfig | EndpointConfig, prompt: string): Promise<string> {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: provider.modelName,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        }),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`SaveFileEngine API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
}

// ─── Canon State Generator ───

function buildCanonStatePrompt(recentMessages: ChatMessage[], existingCanonState: string): string {
    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    return [
        'You are a TTRPG session state tracker. Generate the CURRENT Canon State as a JSON array of memory slots.',
        '',
        'OUTPUT FORMAT — You MUST output a JSON array. Each element is an object with these fields:',
        '  - key: A SHORT_CAPS_IDENTIFIER (e.g. "PLAYER_STATUS", "LOCATION", "X_DEATH", "ACTIVE_QUEST")',
        '  - value: A concise factual string (e.g. "X - DEAD (killed by Malachar, scene 020)")',
        '  - priority: A number 1-10 (10 = critical/unlosable, 1 = trivial detail)',
        '  - sceneId: The scene number where this was established (e.g. "020")',
        '',
        'REQUIRED SLOTS (you MUST include these):',
        '  - PLAYER_STATUS: Current HP, mana, effects, equipment',
        '  - LOCATION: Current location and atmosphere',
        '  - TIME_DATE: Current in-game time/date',
        '',
        'ADDITIONAL SLOTS — add as many as needed for:',
        '  - Character deaths (priority 10, key format: "NAME_DEATH")',
        '  - Major reveals/plot twists (priority 8-10)',
        '  - Destroyed/changed locations (priority 8-10)',
        '  - Active threats (priority 7-9)',
        '  - Faction state changes (priority 6-8)',
        '  - Important items acquired/lost (priority 5-7)',
        '',
        'RULES:',
        '1. Merge the existing slots with new information',
        '2. For deaths and irreversible events: ALWAYS keep them (append-only). Priority 10.',
        '3. Preserve ALL proper nouns exactly as written',
        '4. Use factual, concise values — NO prose or narrative',
        '5. Maximum 15 slots total',
        '6. Output ONLY the JSON array, no markdown fences, no commentary',
        '',
        'EXISTING CORE MEMORY SLOTS:',
        existingCanonState || '[]',
        '',
        'RECENT SESSION TURNS:',
        turns,
    ].join('\n');
}

export async function generateCanonState(
    provider: ProviderConfig | EndpointConfig,
    recentMessages: ChatMessage[],
    existingCanonState: string,
    maxRetries = 1
): Promise<{ canonState: string; slots: CoreMemorySlot[]; success: boolean }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
            ? buildCanonStatePrompt(recentMessages, existingCanonState)
            : buildCanonStatePrompt(recentMessages, existingCanonState) +
            '\n\nPREVIOUS ATTEMPT FAILED VALIDATION. Output ONLY a valid JSON array of slot objects. No markdown fences.';

        console.log(`[SaveFileEngine] Generating Canon State... (Attempt ${attempt + 1})`, {
            messages: recentMessages.length,
            promptTokens: countTokens(prompt)
        });

        const output = await llmCall(provider, prompt);
        const result = validateCanonState(output);

        if (result.valid && result.slots) {
            return { canonState: JSON.stringify(result.slots), slots: result.slots, success: true };
        }
        console.warn(`[SaveFileEngine] Canon State attempt ${attempt + 1} failed validation:`, result.missing);
    }

    let existingSlots: CoreMemorySlot[] = [];
    try {
        existingSlots = JSON.parse(existingCanonState);
        if (!Array.isArray(existingSlots)) existingSlots = [];
    } catch { existingSlots = []; }

    return { canonState: existingCanonState, slots: existingSlots, success: false };
}

// ─── Header Index Generator ───

function buildHeaderIndexPrompt(recentMessages: ChatMessage[], existingHeaderIndex: string): string {
    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    return [
        'You are a TTRPG session indexer. Generate NEW scene header entries for the Header Index.',
        '',
        'OUTPUT FORMAT — You MUST include BOTH sections with these EXACT headers:',
        '',
        '=====================================================================',
        'SECTION 1 — ARC / SESSION HEADER DATABASE',
        '=====================================================================',
        'SESSION_ID: [ARC_SESSION_ID]',
        'SESSION_TITLE: [title]',
        '',
        'SCENE_HEADERS:',
        '  - SCENE_ID: [unique scene ID]',
        '    HEADER: [TAG:TAG] factual header',
        '    THREADS: [THREAD_A], [THREAD_B]',
        '    DELTA: { Key: +Change }',
        '',
        '=====================================================================',
        'SECTION 2 — PENDING LOOPS (UNRESOLVED THREADS)',
        '=====================================================================',
        'LOOP_ID: [THREAD_TAG] Description. (Pressure: Low|Medium|High)',
        '',
        'RULES:',
        '1. For Section 1: output ONLY NEW scene headers from the recent turns',
        '2. For Section 2: output the COMPLETE current list of unresolved threads',
        '3. Use SCENE_ID format that follows existing patterns',
        '4. NO prose — factual index entries only',
        '5. Each SCENE_HEADERS entry must have SCENE_ID, HEADER, THREADS, and DELTA',
        '',
        'EXISTING HEADER INDEX (for reference — do NOT repeat existing SCENE_IDs):',
        existingHeaderIndex || '[No prior index — generate fresh from turns]',
        '',
        'RECENT SESSION TURNS:',
        turns,
    ].join('\n');
}

function splitHeaderIndexSections(text: string): { section1: string; section2: string } {
    const normalized = normalizeForComparison(text);
    const s2Regex = /SECTION 2[—–\u2013\u2014\u2015]PENDING LOOPS/;
    const match = s2Regex.exec(normalized);

    if (!match) {
        return { section1: text, section2: '' };
    }

    const s2Pos = match.index;
    const beforeS2 = text.substring(0, s2Pos);
    const lastSep = beforeS2.lastIndexOf('=====');
    const splitPoint = lastSep !== -1 ? lastSep : s2Pos;

    return {
        section1: text.substring(0, splitPoint).trim(),
        section2: text.substring(splitPoint).trim(),
    };
}

function extractSceneIds(text: string): Set<string> {
    const ids = new Set<string>();
    const regex = /SCENE_ID:\s*(\S+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        ids.add(match[1]);
    }
    return ids;
}

export function mergeHeaderIndex(existing: string, llmOutput: string): string {
    const existingSections = splitHeaderIndexSections(existing);
    const newSections = splitHeaderIndexSections(llmOutput);

    // Section 1: Append new scene headers (deduplicate by SCENE_ID)
    const existingIds = extractSceneIds(existingSections.section1);
    const newS1Lines = newSections.section1.split('\n');

    // Extract only new scene blocks that don't have duplicate SCENE_IDs
    const newSceneBlocks: string[] = [];
    let currentBlock: string[] = [];
    let currentId = '';
    let inBlock = false;

    for (const line of newS1Lines) {
        const idMatch = line.match(/SCENE_ID:\s*(\S+)/);
        if (idMatch) {
            // Save previous block if it has a new ID
            if (inBlock && currentBlock.length > 0 && currentId && !existingIds.has(currentId)) {
                newSceneBlocks.push(currentBlock.join('\n'));
            }
            currentBlock = [line];
            currentId = idMatch[1];
            inBlock = true;
        } else if (inBlock) {
            currentBlock.push(line);
        }
    }
    // Don't forget the last block
    if (inBlock && currentBlock.length > 0 && currentId && !existingIds.has(currentId)) {
        newSceneBlocks.push(currentBlock.join('\n'));
    }

    // Build merged Section 1: existing + new entries appended
    let mergedSection1 = existingSections.section1;
    if (!mergedSection1.trim()) {
        mergedSection1 = newSections.section1;
    } else if (newSceneBlocks.length > 0) {
        mergedSection1 = mergedSection1.trimEnd() + '\n\n' + newSceneBlocks.join('\n\n');
    }

    // Section 2: Full overwrite with new pending loops
    const mergedSection2 = newSections.section2 || existingSections.section2;

    return mergedSection1 + '\n\n' + mergedSection2;
}

export async function generateHeaderIndex(
    provider: ProviderConfig | EndpointConfig,
    recentMessages: ChatMessage[],
    existingHeaderIndex: string,
    maxRetries = 1
): Promise<{ headerIndex: string; success: boolean }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
            ? buildHeaderIndexPrompt(recentMessages, existingHeaderIndex)
            : buildHeaderIndexPrompt(recentMessages, existingHeaderIndex) +
            '\n\nPREVIOUS ATTEMPT FAILED VALIDATION. Ensure BOTH sections are present with SCENE_HEADERS entries.';

        console.log(`[SaveFileEngine] Generating Header Index... (Attempt ${attempt + 1})`, {
            messages: recentMessages.length,
            promptTokens: countTokens(prompt)
        });

        const output = await llmCall(provider, prompt);
        const { valid } = validateHeaderIndex(output);

        if (valid) {
            const merged = mergeHeaderIndex(existingHeaderIndex, output);
            const mergedValid = validateHeaderIndex(merged);
            if (mergedValid.valid) {
                return { headerIndex: merged, success: true };
            }
            console.warn(`[SaveFileEngine] Header Index merged result failed validation:`, mergedValid.missing);
        }
        console.warn(`[SaveFileEngine] Header Index attempt ${attempt + 1} failed validation`);
    }

    return { headerIndex: existingHeaderIndex, success: false };
}

// ─── Full Pipeline ───

export async function runSaveFilePipeline(
    provider: ProviderConfig | EndpointConfig,
    recentMessages: ChatMessage[],
    context: GameContext
): Promise<{ canonState: string; headerIndex: string; canonSuccess: boolean; indexSuccess: boolean; coreMemorySlots?: CoreMemorySlot[] }> {
    // Run both LLM calls in parallel — each takes 5-15s, so sequential was 10-30s total.
    const [canonResult, indexResult] = await Promise.all([
        generateCanonState(provider, recentMessages, context.canonState),
        generateHeaderIndex(provider, recentMessages, context.headerIndex),
    ]);

    return {
        canonState: canonResult.canonState,
        headerIndex: indexResult.headerIndex,
        canonSuccess: canonResult.success,
        indexSuccess: indexResult.success,
        coreMemorySlots: canonResult.slots,
    };
}

// ─── Chapter Summary Generator ───

const CHAPTER_SUMMARY_TOKEN_BUDGET = 8000;

export type ChapterSummaryOutput = {
    title: string;
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
};

function truncateScenesToBudget(
    scenes: { sceneId: string; content: string }[],
    budget: number = CHAPTER_SUMMARY_TOKEN_BUDGET
): { sceneId: string; content: string }[] {
    const totalTokens = scenes.reduce((sum, s) => sum + countTokens(s.content), 0);
    if (totalTokens <= budget) return scenes;

    // Strategy: keep ~20% oldest + ~60% newest, drop middle oldest scenes
    const keepCount = Math.floor(scenes.length * 0.8);
    const dropCount = scenes.length - keepCount;
    const dropFromStart = Math.floor(dropCount * 0.25); // Keep some oldest context
    const dropFromEnd = dropCount - dropFromStart;

    return [
        ...scenes.slice(0, scenes.length - dropFromEnd - dropFromStart),
        ...scenes.slice(scenes.length - dropFromEnd),
    ];
}

function buildChapterSummaryPrompt(
    chapter: ArchiveChapter,
    scenes: { sceneId: string; content: string }[],
    headerIndex: string
): string {
    const truncated = truncateScenesToBudget(scenes);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');
    const sceneRangeStr = `${chapter.sceneRange[0]} to ${chapter.sceneRange[1]}`;

    return [
        'You are a TTRPG campaign archivist. Generate a structured chapter summary.',
        '',
        `CHAPTER: ${chapter.title || 'Untitled'}`,
        `SCENES: ${sceneRangeStr} (${chapter.sceneCount} scenes)`,
        '',
        'OUTPUT FORMAT — respond with a JSON object:',
        '{',
        '    "title": "Short evocative chapter title",',
        '    "summary": "3-5 sentence narrative summary of what happened",',
        '    "keywords": ["keyword1", "keyword2", ...],',
        '    "npcs": ["NPC Name 1", "NPC Name 2", ...],',
        '    "majorEvents": ["Event description 1", "Event description 2"],',
        '    "unresolvedThreads": ["Thread 1", "Thread 2"],',
        '    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",',
        '    "themes": ["theme1", "theme2"]',
        '}',
        '',
        'RULES:',
        '1. Keywords should be distinctive nouns/places/factions — not generic words',
        '2. NPCs should include all significant named characters who appeared or were discussed',
        '3. Major events are plot-critical beats only (not every combat round)',
        '4. Unresolved threads are open plot hooks, promises, or mysteries',
        '5. Title should be 2-5 words, evocative',
        '6. Summary should read like a campaign journal entry, not a list',
        '',
        'HEADER INDEX REFERENCE (for thread tracking):',
        headerIndex.slice(0, 2000), // Truncate header index if very long
        '',
        'SCENE CONTENT:',
        sceneContent,
    ].join('\n');
}

/**
 * Extract JSON from LLM output, handling markdown fences and common errors.
 */
export function parseChapterSummaryOutput(raw: string): ChapterSummaryOutput | null {
    let cleaned = raw.trim();

    // Remove markdown fences
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) cleaned = fenceMatch[1].trim();

    try {
        const parsed = JSON.parse(cleaned);

        // Validate required fields
        const required: (keyof ChapterSummaryOutput)[] = [
            'title', 'summary', 'keywords', 'npcs',
            'majorEvents', 'unresolvedThreads', 'tone', 'themes'
        ];

        for (const field of required) {
            if (!(field in parsed)) {
                console.warn(`[ChapterSummary] Missing field: ${field}`);
                parsed[field] = field === 'summary' || field === 'tone' ? '' : [];
            }
        }

        return parsed as ChapterSummaryOutput;
    } catch (e) {
        console.error('[ChapterSummary] Failed to parse JSON:', e);
        return null;
    }
}

export async function generateChapterSummary(
    provider: ProviderConfig | EndpointConfig,
    chapter: ArchiveChapter,
    scenes: { sceneId: string; content: string }[],
    headerIndex: string,
    maxRetries = 1
): Promise<ChapterSummaryOutput | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
            ? buildChapterSummaryPrompt(chapter, scenes, headerIndex)
            : buildChapterSummaryPrompt(chapter, scenes, headerIndex) +
            '\n\nPREVIOUS ATTEMPT FAILED. Output ONLY valid JSON with all required fields.';

        console.log(`[SaveFileEngine] Generating Chapter Summary... (Attempt ${attempt + 1})`, {
            chapterId: chapter.chapterId,
            sceneCount: scenes.length,
            promptTokens: countTokens(prompt)
        });

        const output = await llmCall(provider, prompt);
        const result = parseChapterSummaryOutput(output);

        if (result) {
            return result;
        }
        console.warn(`[SaveFileEngine] Chapter Summary attempt ${attempt + 1} failed parsing`);
    }

    return null;
}


