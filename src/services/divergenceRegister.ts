import type { EndpointConfig, DivergenceEntry, DivergenceRegister, DivergenceCategory, ArchiveIndexEntry, ArchiveChapter, ChatMessage, PrunedEntry } from '../types';
import { callLLM } from './callLLM';
import { uid } from '../utils/uid';
import { countTokens } from './tokenizer';
import { extractJson } from './payloadBuilder';
import { stripThinkTags } from '../utils/stripThink';
import { toast } from '../components/Toast';

import { safeSceneNum } from '../utils/helpers';

const IMPORTANCE_GATE = 7;
const MAX_PRUNED_LOG = 100;

export const EMPTY_REGISTER: DivergenceRegister = {
    entries: [],
    prunedLog: [],
    lastUpdatedSceneId: '',
    lastUpdatedAt: 0,
    version: 1,
};

const VALID_CATEGORIES: ReadonlySet<DivergenceCategory> = new Set([
    'canon_override', 'world_change', 'entity_state', 'player_state', 'obligation',
]);

const BULLET_RE = /^\s*-?\s*\[\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*scene\s*:\s*([^|\]]+?)\s*(?:\|\s*supersedes\s*:\s*([^|\]]+?)\s*)?\]\s*(.+?)\s*$/i;
const BULLET_RE_LOOSE = /^\s*-?\s*([a-z_]+)\s*\|\s*([^|]+?)\s*\|\s*scene\s*:\s*([^|]+?)\s*(?:\|\s*supersedes\s*:\s*([^|]+?)\s*)?\|\s*(.+?)\s*$/i;

export function stripReasoning(raw: string): string {
    return stripThinkTags(raw);
}

type ParsedBullet = {
    category: DivergenceCategory;
    subject: string;
    divergence: string;
    sceneRef: string;
    supersedes?: string;
    parseError?: boolean;
};

export function parseBulletDivergences(raw: string, validSceneIds: string[]): ParsedBullet[] {
    const cleaned = stripReasoning(raw);
    const fallbackScene = validSceneIds[0] ?? '000';
    const sceneSet = new Set(validSceneIds);
    const out: ParsedBullet[] = [];

    for (const rawLine of cleaned.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        if (/^none$/i.test(line)) continue;
        if (/^\s*importance\s*:\s*\d+\s*$/i.test(line)) continue;
        if (/^(here|the|note|output|entries|new|existing)\b/i.test(line) && !line.includes('[') && !line.includes('|')) continue;

        const m = line.match(BULLET_RE) ?? line.match(BULLET_RE_LOOSE);
        if (!m) {
            out.push({
                category: 'entity_state',
                subject: '(unparsed)',
                divergence: line,
                sceneRef: fallbackScene,
                parseError: true,
            });
            continue;
        }
        const [, catRaw, subjectRaw, sceneRaw, supersedesRaw, divergenceRaw] = m;
        const catNorm = catRaw.toLowerCase().replace(/\s+/g, '_') as DivergenceCategory;
        const category: DivergenceCategory = VALID_CATEGORIES.has(catNorm) ? catNorm : 'entity_state';
        const sceneRef = sceneSet.has(sceneRaw) ? sceneRaw : fallbackScene;
        let divergence = divergenceRaw;
        const sentences = divergence.split(/(?<=[.!?])\s+/);
        if (sentences.length > 2) {
            divergence = sentences.slice(0, 2).join(' ');
        }
        const words = divergence.split(/\s+/);
        if (words.length > 30) {
            divergence = words.slice(0, 30).join(' ') + '...';
        }
        out.push({
            category,
            subject: subjectRaw,
            divergence,
            sceneRef,
            supersedes: supersedesRaw || undefined,
        });
    }

    return out;
}

function buildExtractionPrompt(
    sceneText: string,
    sceneId: string,
    currentRegister: DivergenceRegister,
    multiScene?: boolean
): string {
    const registerLines = currentRegister.entries.length > 0
        ? currentRegister.entries.map(e =>
            `${e.id} [Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
        ).join('\n')
        : '(empty)';
    const registerTokens = countTokens(registerLines);

    const sceneNote = multiScene
        ? 'The scene text below contains messages from multiple scenes, marked with [Scene #XX] headers. Use the matching scene number for each fact.'
        : `Use scene:${sceneId} for every fact unless the text explicitly attributes it to a different scene number.`;

    return `EXISTING REGISTER (${registerTokens} tokens) — facts already captured. Do NOT re-extract these. Only add NEW facts, or use "supersedes:ID" when a new fact updates an existing one above.
${registerLines}

NEW SCENE TEXT (Scene #${sceneId}):
${sceneText}

TASK:
1. Rate this scene's importance 1-10 on the FIRST line as: importance:N
2. ${sceneNote}
3. Extract only facts that would BREAK A FUTURE SCENE if the AI didn't know them. Skip transient details, emotional narration, momentary states, and anything the archive would already surface. Focus on: permanent NPC state changes, items acquired/lost, location changes, relationship shifts, abilities gained/lost, active obligations, world state changes, canon overrides.

Categories (use exactly one per line): canon_override, world_change, entity_state, player_state, obligation.

STYLE RULES (CRITICAL):
- Each divergence must be at most 2 SHORT sentences, maximum 30 words total.
- No compound sentences. No explanations. No "because" or "when" clauses.
- Subject must be a proper noun or specific entity — never a vague pronoun.
- WRONG: The player engaged in a lengthy negotiation with the goblin king and eventually convinced him to join forces
- RIGHT: Goblin King Grak: allied with player
- WRONG: After the intense battle the party discovered that the eastern gate had been destroyed by siege weapons
- RIGHT: Eastern gate: DESTROYED by siege

Output format — one divergence per line after the importance line, no JSON, no markdown:
- [category | subject | scene:NNN] divergence sentence
- [category | subject | scene:NNN | supersedes:ID] divergence sentence

Preserve proper nouns exactly. If there are NO divergences, output only the importance line.`;
}

export async function extractDivergences(
    provider: EndpointConfig,
    sceneText: string,
    sceneId: string,
    currentRegister: DivergenceRegister,
    options?: { forceExtract?: boolean; multiScene?: boolean }
): Promise<{ result: { importance: number } | null; entries: DivergenceEntry[] }> {
    const prompt = buildExtractionPrompt(sceneText, sceneId, currentRegister, options?.multiScene);

    try {
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: 800 });
        const cleaned = stripReasoning(raw);

        const impMatch = cleaned.match(/importance\s*:\s*(\d{1,2})/i);
        const importance = impMatch ? Math.min(10, Math.max(1, parseInt(impMatch[1], 10))) : 5;

        const validIds = options?.multiScene
            ? Array.from(new Set([sceneId, ...Array.from(cleaned.matchAll(/scene\s*:\s*([0-9a-z_-]+)/gi)).map(m => m[1])]))
            : [sceneId];

        const parsed = parseBulletDivergences(cleaned, validIds);

        if (!options?.forceExtract && !options?.multiScene && importance < IMPORTANCE_GATE && parsed.length === 0) {
            return { result: { importance }, entries: [] };
        }

        const entries: DivergenceEntry[] = parsed.map(ne => ({
            id: `div_${uid()}`,
            category: ne.category,
            subject: ne.subject,
            divergence: ne.divergence,
            sceneRef: ne.sceneRef || sceneId,
            linkedSceneIds: [ne.sceneRef || sceneId],
            importance,
            supersedes: ne.supersedes,
            source: options?.forceExtract ? 'manual' : 'auto',
            parseError: ne.parseError,
        }));

        return { result: { importance }, entries };
    } catch (err) {
        console.warn('[DivergenceRegister] Extraction failed:', err);
        return { result: null, entries: [] };
    }
}

function buildBatchExtractionPrompt(
    scenesText: string,
    sceneIds: string[],
    currentRegister: DivergenceRegister
): string {
    const registerLines = currentRegister.entries.length > 0
        ? currentRegister.entries.map(e =>
            `${e.id} [Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
        ).join('\n')
        : '(empty)';
    const registerTokens = countTokens(registerLines);
    const sceneLabel = sceneIds.length === 1 ? `Scene #${sceneIds[0]}` : `Scenes #${sceneIds.join(', #')}`;

    return `EXISTING REGISTER (${registerTokens} tokens) — facts already captured. Do NOT re-extract these. Only add NEW facts, or use "supersedes:ID" when a new fact updates an existing entry above.
${registerLines}

NEW SCENES TEXT (${sceneLabel}):
${scenesText}

TASK: Extract every story-relevant fact that affects future continuity from these scenes. Examples: NPC states (alive/dead/wounded/fled), items acquired/lost/traded, locations discovered/destroyed/changed, relationships formed/broken, abilities gained/lost, debuffs or curses applied, quest progress, obligations or oaths made, world state changes, canon overrides.

Categories (use exactly one per line):
- canon_override — contradicts source material
- world_change — permanent map / world state
- entity_state — NPCs, items, factions
- player_state — abilities, titles, curses
- obligation — debts, promises, oaths

STYLE RULES (CRITICAL):
- Each divergence must be at most 2 SHORT sentences, maximum 30 words total.
- No compound sentences. No explanations. No "because" or "when" clauses.
- Subject must be a proper noun or specific entity — never a vague pronoun.
- WRONG: The player engaged in a lengthy negotiation with the goblin king and eventually convinced him to join forces
- RIGHT: Goblin King Grak: allied with player
- WRONG: After the intense battle the party discovered that the eastern gate had been destroyed by siege weapons
- RIGHT: Eastern gate: DESTROYED by siege

Output format — one divergence per line, no JSON, no markdown:
- [category | subject | scene:NNN] divergence sentence
- [category | subject | scene:NNN | supersedes:ID] divergence sentence

Rules:
- scene:NNN must be one of: ${sceneIds.join(', ')}.
- Preserve proper nouns exactly.
- One sentence per line.
- If there are NO new divergences, output a single line: NONE`;
}

export async function extractFromMessageBatch(
    provider: EndpointConfig,
    messages: ChatMessage[],
    sceneIdsByMessageId: Record<string, string>,
    currentRegister: DivergenceRegister,
    contextLimit: number,
    signal?: AbortSignal,
    divergenceScanBudget?: number,
): Promise<{
    newEntries: DivergenceEntry[];
    supersedes: Array<{ oldId: string; newId: string }>;
    reason?: 'no-scene-mapping';
    parseFailures: number;
    chunkCount: number;
}> {
    if (messages.length === 0) return { newEntries: [], supersedes: [], parseFailures: 0, chunkCount: 0 };

    const scenesBySceneId = new Map<string, { sceneId: string; parts: string[] }>();
    for (const msg of messages) {
        const sceneId = sceneIdsByMessageId[msg.id];
        if (!sceneId) continue;
        if (!scenesBySceneId.has(sceneId)) {
            scenesBySceneId.set(sceneId, { sceneId, parts: [] });
        }
        scenesBySceneId.get(sceneId)!.parts.push(`[${msg.role.toUpperCase()}]: ${msg.content}`);
    }

    if (scenesBySceneId.size === 0) {
        console.error('[DivergenceRegister] No messages mapped to scene IDs — extraction skipped. ' +
            `messages=${messages.length}, mappedIds=${Object.keys(sceneIdsByMessageId).length}. ` +
            'Likely cause: archiveIndex out of sync with chat messages (post-retcon or append failure).');
        return { newEntries: [], supersedes: [], reason: 'no-scene-mapping' as const, parseFailures: 0, chunkCount: 0 };
    }

    const sceneEntries = [...scenesBySceneId.values()].map(s => ({
        sceneId: s.sceneId,
        text: s.parts.join('\n'),
    }));

    const defaultBudget = Math.floor(contextLimit * 0.75);
    const CHUNK_BUDGET = divergenceScanBudget && divergenceScanBudget > 0
        ? divergenceScanBudget
        : defaultBudget;
    const chunks: Array<typeof sceneEntries> = [];
    let currentChunk: typeof sceneEntries = [];
    let currentTokens = 0;

    for (const scene of sceneEntries) {
        const cost = countTokens(scene.text);
        if (currentTokens + cost > CHUNK_BUDGET && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }
        currentChunk.push(scene);
        currentTokens += cost;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);

    const allNewEntries: DivergenceEntry[] = [];
    const allSupersedes: Array<{ oldId: string; newId: string }> = [];
    let parseFailures = 0;

    for (const chunk of chunks) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const combinedText = chunk.map(s => `[Scene #${s.sceneId}]:\n${s.text}`).join('\n\n');
        const sceneIds = chunk.map(s => s.sceneId);
        const prompt = buildBatchExtractionPrompt(combinedText, sceneIds, currentRegister);

        try {
            const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: 1200, signal });
            const parsed = parseBulletDivergences(raw, sceneIds);
            for (const ne of parsed) {
                const entry: DivergenceEntry = {
                    id: `div_${uid()}`,
                    category: ne.category,
                    subject: ne.subject,
                    divergence: ne.divergence,
                    sceneRef: ne.sceneRef,
                    linkedSceneIds: [...sceneIds],
                    importance: 5,
                    supersedes: ne.supersedes,
                    source: 'auto',
                    parseError: ne.parseError,
                };
                allNewEntries.push(entry);
                if (ne.supersedes) {
                    allSupersedes.push({ oldId: ne.supersedes, newId: entry.id });
                }
                if (ne.parseError) parseFailures++;
            }
        } catch (err) {
            if ((err as Error).name === 'AbortError') throw err;
            console.warn('[DivergenceRegister] Batch extraction chunk failed:', err);
            parseFailures++;
        }
    }

    return { newEntries: allNewEntries, supersedes: allSupersedes, parseFailures, chunkCount: chunks.length };
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

    // Also map assistant (GM) messages to the same scene as their preceding user message
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'assistant' && !sceneIdsByMessageId[msg.id]) {
            // Walk backwards to find the nearest user message with a scene ID
            let found = false;
            for (let j = i - 1; j >= 0; j--) {
                if (messages[j].role === 'user' && sceneIdsByMessageId[messages[j].id]) {
                    sceneIdsByMessageId[msg.id] = sceneIdsByMessageId[messages[j].id];
                    found = true;
                    break;
                }
            }
            if (!found) {
                // Edge case: assistant message before any user message
                sceneIdsByMessageId[msg.id] = '000';
            }
        }
    }

    return {
        sceneIdsByMessageId,
        index: archiveIndex.map(e => ({ sceneId: e.sceneId, importance: e.importance })),
    };
}

export function mergeEntries(
    register: DivergenceRegister,
    newEntries: DivergenceEntry[],
    sceneId: string
): DivergenceRegister {
    if (newEntries.length === 0) return register;

    const supersedeIds = new Set(newEntries.filter(e => e.supersedes).map(e => e.supersedes!));
    const surviving = register.entries.filter(e => !supersedeIds.has(e.id));

    const merged = [...surviving];
    for (const ne of newEntries) {
        const existing = ne.supersedes ? register.entries.find(e => e.id === ne.supersedes) : null;
        if (existing) {
            merged.push({
                ...ne,
                linkedSceneIds: [...new Set([...existing.linkedSceneIds, ...ne.linkedSceneIds])],
                importance: Math.max(existing.importance, ne.importance),
            });
        } else {
            merged.push(ne);
        }
    }

    merged.sort((a, b) => safeSceneNum(a.sceneRef) - safeSceneNum(b.sceneRef));

    return {
        entries: merged,
        prunedLog: register.prunedLog ?? [],
        lastUpdatedSceneId: sceneId,
        lastUpdatedAt: Date.now(),
        version: register.version,
    };
}

export function renderRegisterForPayload(register: DivergenceRegister): string {
    if (register.entries.length === 0) return '';

    const byCategory: Record<string, DivergenceEntry[]> = {};
    for (const e of register.entries) {
        if (e.category === 'obligation' && e.resolved) continue;
        const cat = e.category;
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(e);
    }

    const sections: string[] = [];
    const catLabels: Record<string, string> = {
        canon_override: 'CANON OVERRIDES',
        world_change: 'WORLD CHANGES',
        entity_state: 'NPC & ENTITY FATES',
        player_state: 'PLAYER STATE',
        obligation: 'OBLIGATIONS',
    };

    for (const [cat, entries] of Object.entries(byCategory)) {
        const label = catLabels[cat] || cat.toUpperCase();
        const lines = entries.map(e => {
            const marker = e.source === 'manual' ? ' ⚡' : '';
            const resolved = e.category === 'obligation' && !e.resolved ? ' — UNRESOLVED' : '';
            return `• ${e.subject}: ${e.divergence} [Scene #${e.sceneRef}]${marker}${resolved}`;
        });
        sections.push(`${label}:\n${lines.join('\n')}`);
    }

    const latestScene = register.entries.reduce((max, e) =>
        safeSceneNum(e.sceneRef) > safeSceneNum(max) ? e.sceneRef : max, '000'
    );

    return `[CAMPAIGN DIVERGENCE REGISTER — AUTHORITATIVE OVERRIDES]\n[Last updated: Scene #${register.lastUpdatedSceneId || latestScene}]\nThese facts are TRUE in this campaign and override your training data.\n\n${sections.join('\n\n')}\n[END DIVERGENCE REGISTER]`;
}

export function getDivergenceSceneIds(register: DivergenceRegister): Set<string> {
    const ids = new Set<string>();
    for (const e of register.entries) {
        ids.add(e.sceneRef);
        for (const sid of e.linkedSceneIds) ids.add(sid);
    }
    return ids;
}

export function backfillParseErrors(register: DivergenceRegister): DivergenceRegister {
    if (!register.entries.some(e => e.parseError)) return register;

    const allSceneIds = Array.from(getDivergenceSceneIds(register));
    let changed = false;

    const entries = register.entries.map(e => {
        if (!e.parseError) return e;

        const reconstructed = `- ${e.category} | ${e.subject} | scene:${e.sceneRef} | ${e.divergence}`;
        const parsed = parseBulletDivergences(reconstructed, allSceneIds.length > 0 ? allSceneIds : [e.sceneRef]);

        if (parsed.length === 1 && !parsed[0].parseError) {
            changed = true;
            const p = parsed[0];
            return {
                ...e,
                category: p.category,
                subject: p.subject,
                divergence: p.divergence,
                sceneRef: p.sceneRef,
                supersedes: p.supersedes ?? e.supersedes,
                parseError: false,
            };
        }

        if (e.divergence && e.subject === e.divergence.slice(0, 40)) {
            changed = true;
            return { ...e, subject: '(unparsed)' };
        }

        return e;
    });

    return changed ? { ...register, entries } : register;
}

export function countRegisterTokens(register: DivergenceRegister): number {
    return countTokens(renderRegisterForPayload(register));
}

export async function compressRegister(
    provider: EndpointConfig,
    register: DivergenceRegister,
    targetTokens: number
): Promise<DivergenceRegister> {
    const protected_ = register.entries.filter(e => e.importance >= 9);
    const compressible = register.entries.filter(e => e.importance < 9);

    if (compressible.length === 0) return register;

    const currentTokens = countRegisterTokens(register);
    if (currentTokens <= targetTokens) return register;

    const compressibleText = compressible.map(e =>
        `[Scene #${e.sceneRef}, imp:${e.importance}] ${e.category} — ${e.subject}: ${e.divergence}`
    ).join('\n');

    const prompt = `You are compressing part of a campaign divergence register to fit a token budget.

ENTRIES TO COMPRESS (${countTokens(compressibleText)} tokens, target: ${targetTokens} tokens):
${compressibleText}

COMPRESSION RULES:
1. Importance 7-8: Compress to one line but keep all proper nouns.
2. Importance 5-6: Aggressively compress. Merge related entries by subject.
3. Importance ≤ 4: Drop if superseded. Merge into parent if related.
4. If an item was ACQUIRED then LOST/TRADED, merge into one line noting final state.
5. Preserve ALL proper nouns exactly as written.
6. Preserve sceneRef on each output entry (use earliest sceneRef when merging).
7. Target: ${targetTokens} tokens.

OUTPUT: JSON array of entries: [{ "category": "...", "subject": "...", "divergence": "...", "sceneRef": "...", "importance": <number>, "linkedSceneIds": ["..."], "source": "auto" }]`;

    try {
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: 1000 });
        const jsonStr = extractJson(raw);
        const compressed = JSON.parse(jsonStr) as Array<Partial<DivergenceEntry>>;

        const newEntries: DivergenceEntry[] = compressed.map(ce => ({
            id: `div_${uid()}`,
            category: ce.category || 'entity_state',
            subject: ce.subject || '',
            divergence: ce.divergence || '',
            sceneRef: ce.sceneRef || '000',
            linkedSceneIds: ce.linkedSceneIds || [],
            importance: ce.importance ?? 5,
            source: ce.source || 'auto',
        }));

        const merged = [...protected_, ...newEntries];
        merged.sort((a, b) => safeSceneNum(a.sceneRef) - safeSceneNum(b.sceneRef));

        return {
            entries: merged,
            prunedLog: register.prunedLog ?? [],
            lastUpdatedSceneId: register.lastUpdatedSceneId,
            lastUpdatedAt: Date.now(),
            version: register.version + 1,
        };
    } catch (err) {
        console.warn('[DivergenceRegister] Compression failed:', err);
        return register;
    }
}

function repairTruncatedJson(str: string): string {
    let s = str.trim();
    const lastBrace = s.lastIndexOf('}');
    const lastBracket = s.lastIndexOf(']');
    const cut = Math.max(lastBrace, lastBracket);
    if (cut !== -1) {
        s = s.substring(0, cut + 1).trim();
    }
    if (!s.endsWith(']')) s += ']';
    s = s.replace(/,\s*]/g, ']');
    s = s.replace(/,\s*}/g, '}');
    s = s.replace(/}\s*\{/g, '},{');
    return s;
}

export async function mergeSimilarEntries(
    provider: EndpointConfig,
    register: DivergenceRegister
): Promise<DivergenceRegister> {
    if (register.entries.length === 0) return register;

    const entryLines = register.entries.map(e =>
        `${e.id} | ${e.category} | ${e.subject}: ${e.divergence} [Scene #${e.sceneRef}]`
    ).join('\n');

    const prompt = `Merge adjacent or same-subject divergence entries into fewer, denser entries. This is a CAMPAIGN TRUTH register — not a story log. Clusters of micro-beat entries about the same character/subject should collapse into one entry capturing the final state.

ENTRIES:
${entryLines}

RULES:
- Identify clusters sharing the same subject. Group them.
- For each cluster, keep only the entry(s) that represent the CURRENT final state. If 7 entries trace an emotional arc, output 1 entry summarizing the arc's outcome.
- Merge transient micro-beats into their parent entry. "Bram was nervous" + "Bram's hands dropped" + "Bram asked hopefully" → "Bram is emotionally fragile but drawn to Soren's encouragement"
- Drop entries fully superseded: if entry A says "shallow reserves" and entry B says "true depth concealed," keep B, drop A.
- Preserve ALL proper nouns. Keep the earliest sceneRef in the cluster.
- If only 1 entry exists for a subject, keep it as-is unless it's clearly a transient moment (one-time state no longer true).
- Output EVERY entry from the input. For entries you merge, omit them and add a new merged entry. For entries you keep unchanged, include them verbatim.

OUTPUT: JSON array of entries. List ALL entries that should remain in the register — kept originals + new merged entries. Drop entries that are consumed by a merge.
[{ "category": "...", "subject": "...", "divergence": "...", "sceneRef": "...", "importance": <number>, "linkedSceneIds": ["..."], "source": "auto" }]`;

    try {
        const entryCount = register.entries.length;
        const outputTokens = Math.min(64000, Math.max(8000, entryCount * 120));
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: outputTokens });
        const cleaned = stripReasoning(raw);
        const jsonStr = extractJson(cleaned);

        let merged: Array<Partial<DivergenceEntry>> = [];
        try {
            merged = JSON.parse(jsonStr) as typeof merged;
            if (!Array.isArray(merged)) merged = [];
        } catch {
            const repaired = repairTruncatedJson(jsonStr);
            try {
                merged = JSON.parse(repaired) as typeof merged;
                if (!Array.isArray(merged)) merged = [];
            } catch {
                console.warn('[DivergenceMerge] JSON repair failed, raw output:', cleaned.slice(0, 500));
            }
        }

        if (!Array.isArray(merged) || merged.length === 0) {
            toast.error('Merge produced no entries — register unchanged. The model may have exceeded output length.');
            return register;
        }

        const newEntries: DivergenceEntry[] = merged.map(ce => ({
            id: `div_${uid()}`,
            category: ce.category || 'entity_state',
            subject: ce.subject || '',
            divergence: ce.divergence || '',
            sceneRef: ce.sceneRef || '000',
            linkedSceneIds: ce.linkedSceneIds || [ce.sceneRef || '000'],
            importance: ce.importance ?? 5,
            source: ce.source || 'auto',
        }));

        newEntries.sort((a, b) => safeSceneNum(a.sceneRef) - safeSceneNum(b.sceneRef));

        const oldCount = register.entries.length;
        const prunedDuringMerge = oldCount - merged.length;

        console.log(`[DivergenceMerge] ${oldCount} entries → ${newEntries.length} entries (${prunedDuringMerge} consumed by merges)`);
        toast.info(`Merged ${oldCount} entries → ${newEntries.length} entries`);

        return {
            entries: newEntries,
            prunedLog: register.prunedLog ?? [],
            lastUpdatedSceneId: register.lastUpdatedSceneId,
            lastUpdatedAt: Date.now(),
            version: register.version + 1,
        };
    } catch (err) {
        console.warn('[DivergenceMerge] Merge failed, register unchanged:', err);
        toast.error(`Merge failed: ${(err as Error).message || 'Unknown error'}`);
        return register;
    }
}

export async function structureManualEntry(
    provider: EndpointConfig,
    freeText: string
): Promise<{ category: DivergenceCategory; subject: string; divergence: string } | null> {
    const prompt = `A player described a campaign divergence in free text. Structure it into fields.

Player text: "${freeText}"

OUTPUT JSON only: { "category": "<canon_override|world_change|entity_state|player_state|obligation>", "subject": "<entity affected>", "divergence": "<one-line factual statement>" }`;

    try {
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: 200 });
        const jsonStr = extractJson(raw);
        return JSON.parse(jsonStr);
    } catch (err) {
        console.warn('[DivergenceRegister] Manual structuring failed:', err);
        return null;
    }
}

export function getEntriesForSceneRange(
    register: DivergenceRegister,
    sceneRange: [string, string]
): DivergenceEntry[] {
    const startNum = safeSceneNum(sceneRange[0]);
    const endNum = safeSceneNum(sceneRange[1]);
    return register.entries.filter(e => {
        const refNum = safeSceneNum(e.sceneRef);
        return refNum >= startNum && refNum <= endNum;
    });
}

function buildPrunePrompt(
    chapter: ArchiveChapter,
    entries: DivergenceEntry[],
    allChapters: ArchiveChapter[]
): string {
    const npcSet = new Set<string>();
    for (const ch of allChapters) {
        for (const npc of (ch.npcs ?? [])) {
            npcSet.add(npc.toLowerCase());
        }
    }
    const recurringNpcs = [...npcSet];

    const entryLines = entries.map(e =>
        `${e.id} | ${e.category} | ${e.subject}: ${e.divergence} [Scene #${e.sceneRef}]`
    ).join('\n');

    const threadLines = (chapter.unresolvedThreads ?? []).length > 0
        ? chapter.unresolvedThreads.join('\n- ')
        : '(none)';

    return `You are pruning a campaign divergence register after a chapter was sealed. The register is for PERSISTENT CAMPAIGN TRUTH — facts that would break future scenes if the AI didn't know them. It is NOT a story transcript or a log of good moments. Prune aggressively.

CHAPTER: "${chapter.title}" (Scenes ${chapter.sceneRange[0]}-${chapter.sceneRange[1]})
SUMMARY: ${chapter.summary || '(no summary yet)'}
UNRESOLVED THREADS:
- ${threadLines}
RECURRING NPCs ACROSS ALL CHAPTERS: ${recurringNpcs.join(', ') || '(none)'}

ENTRIES FROM THIS CHAPTER:
${entryLines}

CLASSIFY each entry:
- KEEP: If a scene 100 turns from now referenced this without re-explaining it, the reader would be confused. Only permanent truths, lore rules, unresolved plot threads, and major relationship shifts.
- PRUNE: Everything else. This should be the default. The archive index and vector search will surface story moments when they become relevant.
- REVIEW: Only when a keep-or-prune decision hinges on information you don't have. Default to PRUNE if you can't articulate a specific future scene that needs this.

WHAT TO KEEP:
- Permanent world rules and lore that constrain future storytelling (magic systems, faction politics, historical facts)
- Unresolved plot threads with named antagonists, mysteries, or ticking clocks
- Major relationship status changes between recurring characters (alliances formed, betrayals, deaths)
- New recurring characters being introduced with their core identity (name, role, one defining trait)
- Active ongoing deceptions, dual identities, or hidden capabilities being maintained
- Irreversible character transformations (lost limbs, gained powers, broken oaths)

WHAT TO PRUNE (this is the default — apply these liberally):
- Transient ambient details: what someone was wearing, how they were standing, the weather, candlelight
- Play-by-play combat actions: who crawled where, who swung what, who dodged which attack
- Single-scene emotional micro-beats: a character's expression shifting, a momentary silence, a loaded glance — unless it represents a MAJOR relationship status change
- Destroyed props and scenery: broken teacups, shattered windows, toppled furniture
- Scene-setting descriptions: architecture of rooms the party left, landscape features passed through
- Any entry whose subject is a one-off object, weather event, or unnamed bystander
- Intermediate states fully superseded by a later entry: if entry A says "X was wounded" and entry B says "X recovered," merge into one final-state entry or prune A
- Atmospheric NPC mannerisms: how a guard captain looks tired, how a governess twitches — these are NOT campaign facts

OUTPUT: JSON array only, no other text. List EVERY entry. Default to "prune" for anything that isn't clearly essential:
[{ "id": "...", "verdict": "keep"|"prune"|"review", "reason": "short explanation" }]`;
}

export async function pruneChapterEntries(
    provider: EndpointConfig,
    chapter: ArchiveChapter,
    register: DivergenceRegister,
    allChapters: ArchiveChapter[]
): Promise<DivergenceRegister> {
    const chapterEntries = getEntriesForSceneRange(register, chapter.sceneRange);
    if (chapterEntries.length === 0) return register;

    const prompt = buildPrunePrompt(chapter, chapterEntries, allChapters);

    try {
        const outputTokens = Math.min(64000, Math.max(2000, chapterEntries.length * 60));
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: outputTokens });
        const cleaned = stripReasoning(raw);
        const jsonStr = extractJson(cleaned);

        let classifications: Array<{ id: string; verdict: 'keep' | 'prune' | 'review'; reason: string }> = [];
        try {
            classifications = JSON.parse(jsonStr) as typeof classifications;
            if (!Array.isArray(classifications)) classifications = [];
        } catch {
            const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                const m = line.match(/\b(div_[a-zA-Z0-9_-]+)\b.*?\b(keep|prune[ds]?|review)\b/i);
                if (m) {
                    const rawVerdict = m[2].toLowerCase();
                    const verdict: 'keep' | 'prune' | 'review' = rawVerdict.startsWith('prune') ? 'prune' : rawVerdict === 'review' ? 'review' : 'keep';
                    classifications.push({ id: m[1], verdict, reason: 'Parsed from free-text response' });
                }
            }
        }

        const classMap = new Map(classifications.map(c => [c.id, c]));

        const keptEntries: DivergenceEntry[] = [];
        const newPruned: PrunedEntry[] = [];
        const outsideEntries = register.entries.filter(e => {
            const refNum = safeSceneNum(e.sceneRef);
            return refNum < safeSceneNum(chapter.sceneRange[0]) || refNum > safeSceneNum(chapter.sceneRange[1]);
        });

        for (const entry of chapterEntries) {
            const cls = classMap.get(entry.id);
            if (!cls || cls.verdict === 'keep') {
                keptEntries.push(entry);
            } else if (cls.verdict === 'review') {
                keptEntries.push({ ...entry, reviewFlag: true });
            } else {
                newPruned.push({
                    originalEntry: entry,
                    prunedAt: Date.now(),
                    chapterId: chapter.chapterId,
                    verdict: 'auto_pruned',
                    reason: cls?.reason ?? 'Classified as prune during chapter seal',
                });
            }
        }

        const merged = [...outsideEntries, ...keptEntries];
        merged.sort((a, b) => safeSceneNum(a.sceneRef) - safeSceneNum(b.sceneRef));

        const existingPruned = register.prunedLog ?? [];

        const keptCount = keptEntries.filter(e => !e.reviewFlag).length;
        const reviewCount = keptEntries.filter(e => e.reviewFlag).length;
        console.log(`[DivergencePrune] Chapter ${chapter.chapterId}: ${outsideEntries.length} outside, ${keptCount} kept, ${reviewCount} flagged for review, ${newPruned.length} pruned`);

        toast.info(`Pruned ${newPruned.length} entries · ${keptCount} kept · ${reviewCount} flagged for review`);

        return {
            entries: merged,
            prunedLog: [...existingPruned, ...newPruned].slice(-MAX_PRUNED_LOG),
            lastUpdatedSceneId: register.lastUpdatedSceneId,
            lastUpdatedAt: Date.now(),
            version: register.version + 1,
        };
    } catch (err) {
        console.warn('[DivergencePrune] Pruning failed, register unchanged:', err);
        toast.error(`Divergence pruning failed: ${(err as Error).message || 'Unknown error'}`);
        return register;
    }
}

function buildPruneAllPrompt(entries: DivergenceEntry[]): string {
    const entryLines = entries.map(e =>
        `${e.id} | ${e.category} | ${e.subject}: ${e.divergence} [Scene #${e.sceneRef}]`
    ).join('\n');

    return `You are pruning a campaign divergence register. The register holds PERSISTENT CAMPAIGN TRUTH — facts that would break future scenes if the AI didn't know them. It is NOT a story transcript. Prune aggressively.

ENTRIES TO CLASSIFY:
${entryLines}

CLASSIFY each entry:
- KEEP: If a scene 100 turns from now referenced this without re-explaining it, the reader would be confused. Only permanent truths, lore rules, unresolved plot threads, and major relationship shifts.
- PRUNE: Everything else. This should be the default. The archive index and vector search will surface story moments when they become relevant.
- REVIEW: Only when a keep-or-prune decision hinges on information you don't have. Default to PRUNE if you can't articulate a specific future scene that needs this.

WHAT TO KEEP:
- Permanent world rules and lore that constrain future storytelling (magic systems, faction politics, historical facts)
- Unresolved plot threads with named antagonists, mysteries, or ticking clocks
- Major relationship status changes between recurring characters (alliances formed, betrayals, deaths)
- New recurring characters being introduced with their core identity (name, role, one defining trait)
- Active ongoing deceptions, dual identities, or hidden capabilities being maintained
- Irreversible character transformations (lost limbs, gained powers, broken oaths)

WHAT TO PRUNE (this is the default — apply liberally):
- Transient ambient details, play-by-play combat actions, single-scene emotional micro-beats
- Destroyed props, scene-setting descriptions, atmospheric NPC mannerisms
- Any entry whose subject is a one-off object, weather event, or unnamed bystander
- Intermediate states fully superseded by a later entry

OUTPUT: JSON array only, no other text. List EVERY entry. Default to "prune" for anything that isn't clearly essential:
[{ "id": "...", "verdict": "keep"|"prune"|"review", "reason": "short explanation" }]`;
}

export async function pruneAllEntries(
    provider: EndpointConfig,
    register: DivergenceRegister,
    onProgress?: (kept: number, review: number, pruned: number) => void
): Promise<DivergenceRegister> {
    if (register.entries.length === 0) return register;

    const prompt = buildPruneAllPrompt(register.entries);

    try {
        const outputTokens = Math.min(64000, Math.max(2000, register.entries.length * 60));
        const raw = await callLLM(provider, prompt, { priority: 'low', maxTokens: outputTokens });
        const cleaned = stripReasoning(raw);
        const jsonStr = extractJson(cleaned);

        let classifications: Array<{ id: string; verdict: 'keep' | 'prune' | 'review'; reason: string }> = [];
        try {
            classifications = JSON.parse(jsonStr) as typeof classifications;
            if (!Array.isArray(classifications)) classifications = [];
        } catch {
            const lines = cleaned.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                const m = line.match(/\b(div_[a-zA-Z0-9_-]+)\b.*?\b(keep|prune[ds]?|review)\b/i);
                if (m) {
                    const rawVerdict = m[2].toLowerCase();
                    const verdict: 'keep' | 'prune' | 'review' = rawVerdict.startsWith('prune') ? 'prune' : rawVerdict === 'review' ? 'review' : 'keep';
                    classifications.push({ id: m[1], verdict, reason: 'Parsed from free-text response' });
                }
            }
        }

        const classMap = new Map(classifications.map(c => [c.id, c]));

        const keptEntries: DivergenceEntry[] = [];
        const newPruned: PrunedEntry[] = [];

        for (const entry of register.entries) {
            const cls = classMap.get(entry.id);
            if (!cls || cls.verdict === 'keep') {
                keptEntries.push(entry);
            } else if (cls.verdict === 'review') {
                keptEntries.push({ ...entry, reviewFlag: true });
            } else {
                newPruned.push({
                    originalEntry: entry,
                    prunedAt: Date.now(),
                    chapterId: 'manual',
                    verdict: 'auto_pruned',
                    reason: cls?.reason ?? 'Pruned during manual review',
                });
            }
        }

        const keptCount = keptEntries.filter(e => !e.reviewFlag).length;
        const reviewCount = keptEntries.filter(e => e.reviewFlag).length;

        console.log(`[DivergencePruneAll] ${keptCount} kept, ${reviewCount} flagged for review, ${newPruned.length} pruned`);

        onProgress?.(keptCount, reviewCount, newPruned.length);

        toast.info(`Pruned ${newPruned.length} entries · ${keptCount} kept · ${reviewCount} flagged for review`);

        return {
            entries: keptEntries,
            prunedLog: [...(register.prunedLog ?? []), ...newPruned].slice(-MAX_PRUNED_LOG),
            lastUpdatedSceneId: register.lastUpdatedSceneId,
            lastUpdatedAt: Date.now(),
            version: register.version + 1,
        };
    } catch (err) {
        console.warn('[DivergencePruneAll] Prune all failed, register unchanged:', err);
        toast.error(`Divergence prune-all failed: ${(err as Error).message || 'Unknown error'}`);
        return register;
    }
}

export function confirmReviewEntry(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entries = register.entries.map(e =>
        e.id === entryId ? { ...e, reviewFlag: false } : e
    );
    return { ...register, entries, lastUpdatedAt: Date.now() };
}

export function deleteReviewedEntry(register: DivergenceRegister, entryId: string): DivergenceRegister {
    const entry = register.entries.find(e => e.id === entryId);
    if (!entry) return register;

    const entries = register.entries.filter(e => e.id !== entryId);
    const newPruned: PrunedEntry = {
        originalEntry: entry,
        prunedAt: Date.now(),
        chapterId: '',
        verdict: 'user_deleted_review',
        reason: 'User manually deleted after review',
    };
    const prunedLog = [...(register.prunedLog ?? []), newPruned].slice(-MAX_PRUNED_LOG);

    return { ...register, entries, prunedLog, lastUpdatedAt: Date.now() };
}

export function restorePrunedEntry(register: DivergenceRegister, prunedIndex: number): DivergenceRegister {
    const prunedLog = register.prunedLog ?? [];
    if (prunedIndex < 0 || prunedIndex >= prunedLog.length) return register;

    const restored = prunedLog[prunedIndex];
    const entry: DivergenceEntry = { ...restored.originalEntry, reviewFlag: false };

    const newLog = prunedLog.filter((_, i) => i !== prunedIndex);
    const entries = [...register.entries, entry];
    entries.sort((a, b) => safeSceneNum(a.sceneRef) - safeSceneNum(b.sceneRef));

    return { ...register, entries, prunedLog: newLog, lastUpdatedAt: Date.now() };
}
