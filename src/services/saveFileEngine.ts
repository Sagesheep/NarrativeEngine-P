import type { ChatMessage, GameContext, ProviderConfig, EndpointConfig } from '../types';
import { countTokens } from './tokenizer';

// ─── Canon State Section Headers (from canon_state.md template) ───
const CANON_STATE_SECTIONS = [
    'SECTION 1 — IMMEDIATE CONTEXT',
    'SECTION 2 � WORLD STATE',
    'SECTION 3 � IMMUTABLE CANON LEDGERS',
];

const CANON_STATE_REQUIRED_FIELDS = [
    'TIME_DATE:',
    'LOCATION:',
    'CURRENT_STATUS_PLAYER:',
];

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

export function validateCanonState(output: string): { valid: boolean; missing: string[] } {
    const missing = [
        ...CANON_STATE_SECTIONS.filter((s) => !output.includes(s)),
        ...CANON_STATE_REQUIRED_FIELDS.filter((f) => !output.includes(f)),
    ];
    return { valid: missing.length === 0, missing };
}

export function validateHeaderIndex(output: string): { valid: boolean; missing: string[] } {
    const missing = [
        ...HEADER_INDEX_SECTIONS.filter((s) => !output.includes(s)),
        ...HEADER_INDEX_REQUIRED_FIELDS.filter((f) => !output.includes(f)),
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
        'You are a TTRPG session state tracker. Generate the CURRENT Canon State based on the recent session turns.',
        '',
        'OUTPUT FORMAT — You MUST include ALL of these sections with these EXACT headers:',
        '',
        '=====================================================================',
        'SECTION 1 — IMMEDIATE CONTEXT (THE "NOW")',
        '=====================================================================',
        'TIME_DATE: [current time/date]',
        'LOCATION: [current location]',
        'ATMOSPHERE: [current mood]',
        'NARRATIVE_MODE: [Combat / Survival / Social / Downtime]',
        '',
        'CURRENT_STATUS_PLAYER:',
        '  - HP:',
        '  - MANA/STAMINA:',
        '  - ACTIVE_EFFECTS:',
        '  - EQUIPMENT_LOADOUT:',
        '',
        'CURRENT_STATUS_PARTY:',
        '  - [Name]: [Status]',
        '',
        'IMMEDIATE_THREATS:',
        '  - [Threat]',
        '',
        '=====================================================================',
        'SECTION 2 � WORLD STATE (MUTABLE)',
        '=====================================================================',
        '## 2.1 LOCATION STATES',
        '## 2.2 PLAYER CAPABILITIES',
        '',
        '',
        '=====================================================================',
        'SECTION 3 � IMMUTABLE CANON LEDGERS (APPEND-ONLY)',
        '=====================================================================',
        '## 3.1 MAJOR REVEALS / TRUTHS',
        '## 3.2 DESTROYED / IRREVERSIBLY CHANGED LOCATIONS',
        '',
        'RULES:',
        '1. Merge the existing Canon State with new information from the turns',
        '2. For Section 3 (ledgers): ONLY APPEND new entries, never remove existing ones',
        '3. Preserve ALL proper nouns exactly as written',
        '4. Use factual, concise entries — NO prose or narrative',
        '',
        'EXISTING CANON STATE:',
        existingCanonState || '[No prior state — generate fresh from turns]',
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
): Promise<{ canonState: string; success: boolean }> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
            ? buildCanonStatePrompt(recentMessages, existingCanonState)
            : buildCanonStatePrompt(recentMessages, existingCanonState) +
            '\n\nPREVIOUS ATTEMPT FAILED VALIDATION. Ensure ALL sections are present.';

        console.log(`[SaveFileEngine] Generating Canon State... (Attempt ${attempt + 1})`, {
            messages: recentMessages.length,
            promptTokens: countTokens(prompt)
        });

        const output = await llmCall(provider, prompt);
        const { valid } = validateCanonState(output);

        if (valid) {
            return { canonState: output, success: true };
        }
        console.warn(`[SaveFileEngine] Canon State attempt ${attempt + 1} failed validation`);
    }

    return { canonState: existingCanonState, success: false };
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
    const s2Marker = 'SECTION 2 — PENDING LOOPS';
    const s2Pos = text.indexOf(s2Marker);

    if (s2Pos === -1) {
        return { section1: text, section2: '' };
    }

    // Find the separator line before Section 2
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

    for (const line of newS1Lines) {
        const idMatch = line.match(/SCENE_ID:\s*(\S+)/);
        if (idMatch) {
            // Save previous block if it has a new ID
            if (currentBlock.length > 0 && currentId && !existingIds.has(currentId)) {
                newSceneBlocks.push(currentBlock.join('\n'));
            }
            currentBlock = [line];
            currentId = idMatch[1];
        } else if (currentBlock.length > 0 && (line.trim().startsWith('HEADER:') || line.trim().startsWith('THREADS:') || line.trim().startsWith('DELTA:'))) {
            currentBlock.push(line);
        }
    }
    // Don't forget the last block
    if (currentBlock.length > 0 && currentId && !existingIds.has(currentId)) {
        newSceneBlocks.push(currentBlock.join('\n'));
    }

    // Build merged Section 1: existing + new entries appended
    let mergedSection1 = existingSections.section1;
    if (newSceneBlocks.length > 0) {
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
            return { headerIndex: merged, success: true };
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
): Promise<{ canonState: string; headerIndex: string; canonSuccess: boolean; indexSuccess: boolean }> {
    // Step 1: Generate Canon State (full overwrite)
    const canonResult = await generateCanonState(provider, recentMessages, context.canonState);

    // Step 2: Generate Header Index (append S1, overwrite S2)
    const indexResult = await generateHeaderIndex(provider, recentMessages, context.headerIndex);

    return {
        canonState: canonResult.canonState,
        headerIndex: indexResult.headerIndex,
        canonSuccess: canonResult.success,
        indexSuccess: indexResult.success,
    };
}


