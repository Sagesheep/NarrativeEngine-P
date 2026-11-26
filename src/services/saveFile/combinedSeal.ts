import type { ProviderConfig, EndpointConfig, DivergenceEntry, SceneEvent, SceneEventType } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { extractJson } from '../infrastructure/jsonExtract';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { DIVERGENCE_CATEGORIES, CATEGORY_DEFINITIONS, coerceCategory, isFactActive, isValidStateKey } from '../campaign-state/divergenceRegister';
import { uid } from '../../utils/uid';
import { parseChapterSummaryOutput } from './chapterSummary';
import type { ChapterSummaryOutput } from './chapterSummary';
import { renderPrompt } from '../prompts/promptRegistry';

// ─── Combined Seal Call (summary + divergences in ONE LLM call) ───

// Scene text sent in ONE seal call. A chapter longer than this is sealed in several
// calls (see planSealBatches) rather than cut down: cutting it dropped the middle
// scenes, so their facts, events and NPC memories were never extracted.
export const COMBINED_SEAL_TOKEN_BUDGET = 12000;

type SealScene = { sceneId: string; content: string };

/** The start of `content` that fits in `maxTokens`, measured with the real tokenizer. */
function trimToTokens(content: string, maxTokens: number): string {
    const total = countTokens(content);
    if (total <= maxTokens) return content;
    let chars = Math.floor(content.length * (maxTokens / total));
    let slice = content.slice(0, chars);
    while (chars > 0 && countTokens(slice) > maxTokens) {
        chars = Math.floor(chars * 0.9);
        slice = content.slice(0, chars);
    }
    return slice;
}

/**
 * Splits a chapter's scenes, in order, into groups that each fit `budget` tokens.
 * Every scene is kept. Only a single scene longer than the whole budget is cut,
 * and then only its end.
 */
export function planSealBatches(scenes: SealScene[], budget: number = COMBINED_SEAL_TOKEN_BUDGET): SealScene[][] {
    const batches: SealScene[][] = [];
    let current: SealScene[] = [];
    let currentTokens = 0;
    for (const scene of scenes) {
        let content = scene.content;
        let tokens = countTokens(content);
        if (tokens > budget) {
            content = trimToTokens(content, budget - 10) + '\n[...truncated]';
            tokens = countTokens(content);
        }
        if (current.length > 0 && currentTokens + tokens > budget) {
            batches.push(current);
            current = [];
            currentTokens = 0;
        }
        current.push(content === scene.content ? scene : { sceneId: scene.sceneId, content });
        currentTokens += tokens;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

export type CombinedSealResult = {
    summary: ChapterSummaryOutput | null;
    divergences: DivergenceEntry[];
    divergenceParseError?: boolean;
    witnessCorrections?: Record<string, string[]>;
    sceneEventMap?: Record<string, SceneEvent[]>;
    sceneEventsParseError?: boolean;
};

function buildCombinedSealPrompt(
    scenes: { sceneId: string; content: string }[],
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    indexEntries?: { sceneId: string; witnesses?: string[] }[],
    activeStateFacts: DivergenceEntry[] = [],
    part?: { index: number; total: number },
): string {
    // `scenes` already fits the budget: planSealBatches sized it.
    const sceneContent = scenes.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');

    const npcList = npcLedger.map(n =>
        `- ${n.name} (id: ${n.id}${n.aliases ? ', also known as: ' + n.aliases : ''})`
    ).join('\n');
    const activeStateFactsText = activeStateFacts
        .filter(f => isFactActive(f) && isValidStateKey(f.stateKey))
        .slice(-40)
        .map(f => `[ID: ${f.id}] [STATE: ${f.stateKey}] ${f.text}`)
        .join('\n');
    const stateCandidatesSection = activeStateFactsText
        ? `\nCURRENT STATE FACTS (only these IDs may be superseded):\n${activeStateFactsText}\n`
        : '';


    const divergenceSlots = DIVERGENCE_CATEGORIES.filter(c => c !== 'misc').map(c =>

        `### ${c.toUpperCase()}\nDefinition: ${CATEGORY_DEFINITIONS[c]}\nOutput: JSON array for this slot, or [] if empty.`
    ).join('\n\n');

    let witnessAuditSection = '';
    if (indexEntries && indexEntries.length > 0) {
        const entriesWithWitness = indexEntries.filter(e => e.witnesses && e.witnesses.length > 0);
        if (entriesWithWitness.length > 0) {
            const rows = entriesWithWitness.map(e =>
                `Scene ${e.sceneId}: ${(e.witnesses ?? []).join(', ') || '(none recorded)'}`
            ).join('\n');
            witnessAuditSection = `

AUDIT — PER-SCENE NPC WITNESSES (pre-capture):
The following per-scene witness data was captured during play. Review it for accuracy.
If you find that a scene's witnesses are incorrect (NPCs listed who were NOT present, or NPCs present who are NOT listed),
provide corrections in the "witness_corrections" field.

${rows}`;
        }
    }

    const outputKeys = witnessAuditSection
        ? '"summary", "divergences", "sceneEvents", and optionally "witness_corrections"'
        : '"summary", "divergences", and "sceneEvents"';

    return renderPrompt('memory.seal', { title: chapterTitle || 'Untitled', partNote: part ? `
PART ${part.index} OF ${part.total}: this chapter is too long for one pass, so you see only some of its scenes. Summarize, and extract facts and events from, these scenes only.` : '', sceneIds: sceneIds.join(', '), npcLedger: npcList || '(no NPCs in ledger)', stateFacts: stateCandidatesSection, scenes: sceneContent, witnessAudit: witnessAuditSection, outputKeys, witnessCorrections: witnessAuditSection ? `
WITNESS CORRECTIONS:
If you found errors in the per-scene witness data above, include a "witness_corrections" key at the top level of the JSON:
"witness_corrections": { "014": ["Aldric", "Borric"], "022": ["Morrigan"] }
This maps scene IDs to the CORRECT list of NPC NAMES who were physically present in that scene. Only include scenes where you disagree with the pre-captured data.` : '', categorySlots: divergenceSlots, miscDefinition: CATEGORY_DEFINITIONS.misc });
}

function extractWitnessCorrections(parsed: object): Record<string, string[]> | undefined {
    const p = parsed as Record<string, unknown>;
    const rawCorrections =
        p['witness_corrections'] ??
        ((p['divergences'] as Record<string, unknown> | undefined)?.['witness_corrections']);
    if (rawCorrections && typeof rawCorrections === 'object' && !Array.isArray(rawCorrections)) {
        const corrections: Record<string, string[]> = {};
        for (const [sceneId, value] of Object.entries(rawCorrections as Record<string, unknown>)) {
            if (Array.isArray(value) && value.every((v: unknown) => typeof v === 'string')) {
                corrections[sceneId] = value as string[];
            }
        }
        if (Object.keys(corrections).length > 0) {
            console.log(`[CombinedSeal] Extracted witness corrections for ${Object.keys(corrections).length} scenes`);
            return corrections;
        }
    }
    return undefined;
}

export function parseCombinedSealOutput(
    raw: string,
    chapterId: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    /** Witness names per scene, as captured during play. A fact the model names no
     *  knowers for falls back to its scene's witnesses (corrected by this output's
     *  witness_corrections, when it has them). */
    sceneWitnesses: Record<string, string[]> = {},
): CombinedSealResult {
    const cleaned = extractJson(raw);
    const sceneSet = new Set(sceneIds);
    const fallbackScene = sceneIds[0] ?? '000';
    const npcNameMap = new Map<string, string>();
    for (const npc of npcLedger) {
        npcNameMap.set(npc.name.toLowerCase(), npc.id);
        if (npc.aliases) {
            for (const alias of npc.aliases.split(',')) {
                npcNameMap.set(alias.trim().toLowerCase(), npc.id);
            }
        }
    }

    let parsed: { summary?: unknown; divergences?: unknown };
    let divergenceParseError = false;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        console.warn('[CombinedSeal] JSON parse failed, attempting summary-only fallback');
        const summaryOnly = parseChapterSummaryOutput(raw);
        return { summary: summaryOnly, divergences: [], divergenceParseError: true };
    }

    let summary: ChapterSummaryOutput | null = null;
    if (parsed.summary && typeof parsed.summary === 'object') {
        summary = parseChapterSummaryOutput(JSON.stringify(parsed.summary));
    } else {
        summary = parseChapterSummaryOutput(raw);
    }

    const witnessCorrections = extractWitnessCorrections(parsed);
    const witnessIdsFor = (sceneRef: string): string[] => {
        const ids: string[] = [];
        for (const name of witnessCorrections?.[sceneRef] ?? sceneWitnesses[sceneRef] ?? []) {
            const id = npcNameMap.get(name.trim().toLowerCase());
            if (id && !ids.includes(id)) ids.push(id);
        }
        return ids;
    };

    const entries: DivergenceEntry[] = [];
    if (parsed.divergences && typeof parsed.divergences === 'object') {
        const divObj = parsed.divergences as Record<string, unknown[]>;

        for (const category of DIVERGENCE_CATEGORIES) {
            const slotArr = divObj[category];
            if (!Array.isArray(slotArr)) continue;

            for (const item of slotArr) {
                if (!item || typeof item !== 'object') continue;
                const rawItem = item as Record<string, unknown>;
                const text = typeof rawItem.text === 'string' ? rawItem.text.trim() : '';
                if (!text) continue;

                const sceneRef = typeof rawItem.sceneRef === 'string' && sceneSet.has(rawItem.sceneRef)
                    ? rawItem.sceneRef
                    : fallbackScene;

                const rawNpcIds: string[] = Array.isArray(rawItem.npcIds) ? rawItem.npcIds.filter((id): id is string => typeof id === 'string') : [];
                const resolvedNpcIds: string[] = [];
                const unrecognized: string[] = Array.isArray(rawItem.unrecognizedNpcNames)
                    ? rawItem.unrecognizedNpcNames.filter((n): n is string => typeof n === 'string')
                    : [];

                for (const id of rawNpcIds) {
                    const found = npcLedger.some(n => n.id === id);
                    if (found) {
                        resolvedNpcIds.push(id);
                    } else {
                        unrecognized.push(id);
                    }
                }

                const stillUnrecognized: string[] = [];
                for (const name of unrecognized) {
                    const matched = npcNameMap.get(name.toLowerCase());
                    if (matched && !resolvedNpcIds.includes(matched)) {
                        resolvedNpcIds.push(matched);
                    } else {
                        stillUnrecognized.push(name);
                    }
                }

                const hasReviewFlag = stillUnrecognized.length > 0;

                // Who knows it. Locations and rules/lore are broadcast (undefined). Every
                // other fact comes from a played scene, so the player character knows it,
                // plus the NPCs the model names — or, when it names none, the scene's
                // witnesses. An unsure answer never makes a fact public: that put private
                // facts and twists in the canon block every NPC reads.
                let knownBy: string[] | undefined = undefined;
                if (category !== 'rules_lore' && category !== 'locations') {
                    const resolvedKnown: string[] = [];
                    for (const kb of Array.isArray(rawItem.knownBy) ? rawItem.knownBy : []) {
                        if (typeof kb !== 'string') continue;
                        if (npcLedger.some(n => n.id === kb)) {
                            resolvedKnown.push(kb);
                        } else {
                            const nameMatch = npcNameMap.get(kb.toLowerCase());
                            if (nameMatch) {
                                if (!resolvedKnown.includes(nameMatch)) resolvedKnown.push(nameMatch);
                            }
                        }
                    }
                    knownBy = ['player', ...(resolvedKnown.length > 0 ? resolvedKnown : witnessIdsFor(sceneRef))];
                }

                const rawStateKey = rawItem.stateKey;
                const stateKey = isValidStateKey(rawStateKey) ? rawStateKey : undefined;
                const supersedesFactId = stateKey && typeof rawItem.supersedesFactId === 'string'
                    ? rawItem.supersedesFactId
                    : undefined;
                entries.push({
                    id: `div_${uid()}`,
                    chapterId,
                    category: coerceCategory(category),
                    text,
                    sceneRef,
                    npcIds: resolvedNpcIds,
                    knownBy,
                    pinned: false,
                    stateKey,
                    supersedesFactId,
                    source: 'auto',
                    reviewFlag: hasReviewFlag || undefined,
                    unrecognizedNpcNames: stillUnrecognized.length > 0 ? stillUnrecognized : undefined,
                });
            }
        }
    } else {
        divergenceParseError = true;
    }

    let sceneEventMap: Record<string, SceneEvent[]> | undefined;
    let sceneEventsParseError: boolean | undefined;
    try {
        const rawSceneEvents = (parsed as Record<string, unknown>).sceneEvents;
        if (rawSceneEvents !== undefined) {
            if (typeof rawSceneEvents !== 'object' || rawSceneEvents === null || Array.isArray(rawSceneEvents)) {
                throw new Error('sceneEvents is not an object');
            }
            const VALID_EVENT_TYPES = new Set<string>([
                'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
                'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
            ]);
            const map: Record<string, SceneEvent[]> = {};
            for (const [sceneId, eventsRaw] of Object.entries(rawSceneEvents as Record<string, unknown>)) {
                if (!Array.isArray(eventsRaw)) continue;
                const validEvents: SceneEvent[] = [];
                for (const ev of eventsRaw) {
                    if (!ev || typeof ev !== 'object') continue;
                    const raw = ev as Record<string, unknown>;
                    if (typeof raw.text !== 'string' || !raw.text.trim()) continue;
                    if (typeof raw.importance !== 'number') continue;
                    const eventType: SceneEventType = VALID_EVENT_TYPES.has(raw.eventType as string)
                        ? (raw.eventType as SceneEventType)
                        : 'other';
                    const importance = Math.min(10, Math.max(1, Math.round(raw.importance as number)));
                    const event: SceneEvent = { eventType, importance, text: (raw.text as string).trim() };
                    if (Array.isArray(raw.characters) && raw.characters.length > 0) event.characters = raw.characters.filter((v: unknown): v is string => typeof v === 'string');
                    if (Array.isArray(raw.locations) && raw.locations.length > 0) event.locations = raw.locations.filter((v: unknown): v is string => typeof v === 'string');
                    if (Array.isArray(raw.items) && raw.items.length > 0) event.items = raw.items.filter((v: unknown): v is string => typeof v === 'string');
                    if (Array.isArray(raw.concepts) && raw.concepts.length > 0) event.concepts = raw.concepts.filter((v: unknown): v is string => typeof v === 'string');
                    if (typeof raw.cause === 'string' && raw.cause.trim()) event.cause = raw.cause.trim();
                    if (typeof raw.result === 'string' && raw.result.trim()) event.result = raw.result.trim();
                    validEvents.push(event);
                }
                map[sceneId] = validEvents;
            }
            sceneEventMap = map;
        }
    } catch (e) {
        console.warn('[CombinedSeal] sceneEvents block present but unparseable — ignoring', e);
        sceneEventsParseError = true;
    }

    return { summary, divergences: entries, divergenceParseError: divergenceParseError || undefined, witnessCorrections, sceneEventMap, sceneEventsParseError };
}

export type SealModelCall = (request: {
    prompt: string;
    maxTokens: number;
    priority: 'low';
    trackingLabel: string;
    timeoutMs: number;
}) => Promise<string>;

export async function sealChapterCombined(
    provider: ProviderConfig | EndpointConfig | undefined,
    scenes: { sceneId: string; content: string }[],
    chapterId: string,
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    maxRetries = 2,
    scanBudget = 0,
    indexEntries?: { sceneId: string; witnesses?: string[] }[],
    activeStateFacts: DivergenceEntry[] = [],
    modelCall?: SealModelCall,
    timeoutMs: number = AI_CALL_TIMEOUT_MS,
): Promise<CombinedSealResult> {
    const maxTokens = scanBudget > 0 ? scanBudget : 2000;
    const callModel: SealCall = (prompt, tokens, trackingLabel) => modelCall
        ? modelCall({ prompt, priority: 'low', maxTokens: tokens, trackingLabel, timeoutMs })
        : llmCall(provider!, prompt, { priority: 'low', maxTokens: tokens, trackingLabel, timeoutMs });

    const batches = planSealBatches(scenes);
    if (batches.length <= 1) {
        return sealOnePass(callModel, maxTokens, batches[0] ?? scenes, chapterId, chapterTitle, sceneIds, npcLedger, maxRetries, indexEntries, activeStateFacts);
    }

    // Long chapter: seal it part by part so every scene is read. Parts run in order,
    // and each sees the state facts the earlier parts set, so a later part can
    // replace them (e.g. an item changing hands twice in one chapter).
    console.log(`[CombinedSeal] Chapter ${chapterId} is too long for one pass — sealing in ${batches.length} parts`);
    const parts: CombinedSealResult[] = [];
    let stateFacts = [...activeStateFacts];
    let firstError: unknown;
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchIds = batch.map(s => s.sceneId);
        const idSet = new Set(batchIds);
        const batchIndex = indexEntries?.filter(e => idSet.has(e.sceneId));
        try {
            const part = await sealOnePass(
                callModel, maxTokens, batch, chapterId, chapterTitle, batchIds, npcLedger, maxRetries,
                batchIndex && batchIndex.length > 0 ? batchIndex : undefined, stateFacts,
                { index: i + 1, total: batches.length },
            );
            parts.push(part);
            const replaced = new Set(part.divergences.map(d => d.supersedesFactId).filter(Boolean));
            stateFacts = [
                ...stateFacts.filter(f => !replaced.has(f.id)),
                ...part.divergences.filter(d => isValidStateKey(d.stateKey)),
            ];
        } catch (err) {
            // One part failing (a timeout, say) should not throw away the others.
            console.warn(`[CombinedSeal] Part ${i + 1}/${batches.length} failed:`, err);
            firstError ??= err;
            parts.push({ summary: null, divergences: [], divergenceParseError: true });
        }
    }
    if (firstError !== undefined && parts.every(p => !p.summary && p.divergences.length === 0)) {
        throw firstError;
    }

    const failedParts = parts.filter(p => p.divergenceParseError).length;
    if (failedParts > 0) {
        console.warn(`[CombinedSeal] Facts missing from ${failedParts} of ${parts.length} parts`);
    }

    const witnessCorrections: Record<string, string[]> = {};
    const sceneEventMap: Record<string, SceneEvent[]> = {};
    for (const p of parts) {
        Object.assign(witnessCorrections, p.witnessCorrections ?? {});
        Object.assign(sceneEventMap, p.sceneEventMap ?? {});
    }
    const partSummaries = parts.map(p => p.summary).filter((s): s is ChapterSummaryOutput => s !== null);

    return {
        summary: await mergePartSummaries(callModel, partSummaries, chapterTitle),
        divergences: parts.flatMap(p => p.divergences),
        divergenceParseError: failedParts > 0 || undefined,
        witnessCorrections: Object.keys(witnessCorrections).length > 0 ? witnessCorrections : undefined,
        sceneEventMap: parts.some(p => p.sceneEventMap) ? sceneEventMap : undefined,
        sceneEventsParseError: parts.some(p => p.sceneEventsParseError) || undefined,
    };
}

type SealCall = (prompt: string, maxTokens: number, trackingLabel: string) => Promise<string>;

async function sealOnePass(
    callModel: SealCall,
    maxTokens: number,
    scenes: SealScene[],
    chapterId: string,
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    maxRetries: number,
    indexEntries: { sceneId: string; witnesses?: string[] }[] | undefined,
    activeStateFacts: DivergenceEntry[],
    part?: { index: number; total: number },
): Promise<CombinedSealResult> {
    // A try whose summary is good but whose facts block failed to parse. Retries go
    // after the facts; if none succeeds, this summary is still kept rather than lost
    // (the caller warns that only the facts failed).
    let summaryOnly: CombinedSealResult | null = null;
    const sceneWitnesses: Record<string, string[]> = {};
    for (const e of indexEntries ?? []) {
        if (e.witnesses && e.witnesses.length > 0) sceneWitnesses[e.sceneId] = e.witnesses;
    }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = buildCombinedSealPrompt(scenes, chapterTitle, sceneIds, npcLedger, indexEntries, activeStateFacts, part);
        const label = attempt === 0 ? '' : ' (retry)';

        console.log(`[CombinedSeal] Generating summary + divergences${part ? ` (part ${part.index}/${part.total})` : ''}${label}...`, {
            sceneCount: scenes.length,
            sceneIds: sceneIds.length,
            promptTokens: countTokens(prompt),
        });

        const output = await callModel(prompt, maxTokens, 'chapter-seal');
        const result = parseCombinedSealOutput(output, chapterId, sceneIds, npcLedger, sceneWitnesses);

        if (result.summary && !result.divergenceParseError) {
            return result;
        }
        if (result.summary && result.divergenceParseError) {
            console.warn(`[CombinedSeal] Attempt ${attempt + 1}: summary OK but divergence parse failed — retrying divergences`);
            summaryOnly = result;
            continue;
        }
        console.warn(`[CombinedSeal] Attempt ${attempt + 1} produced no usable output`);
    }

    return summaryOnly ?? { summary: null, divergences: [], divergenceParseError: true };
}

/**
 * One chapter summary from the summaries of its parts: a model call that rewrites
 * them as one, or, when that fails, the parts joined together.
 */
async function mergePartSummaries(
    callModel: SealCall,
    parts: ChapterSummaryOutput[],
    chapterTitle: string,
): Promise<ChapterSummaryOutput | null> {
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];

    const prompt = renderPrompt('memory.seal-merge', {
        title: chapterTitle || 'Untitled',
        partCount: parts.length,
        parts: parts.map((p, i) => `--- PART ${i + 1} ---\n${JSON.stringify(p)}`).join('\n\n'),
    });

    try {
        const merged = parseChapterSummaryOutput(await callModel(prompt, 1500, 'chapter-seal-merge'));
        if (merged && merged.summary) return merged;
        console.warn('[CombinedSeal] Summary merge produced no usable output — joining part summaries');
    } catch (err) {
        console.warn('[CombinedSeal] Summary merge failed — joining part summaries:', err);
    }
    return joinPartSummaries(parts);
}

/** The part summaries as one, without a model: the fallback when the merge call fails. */
export function joinPartSummaries(parts: ChapterSummaryOutput[]): ChapterSummaryOutput {
    const union = (lists: string[][]) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const item of lists.flat()) {
            const key = item.trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(item.trim());
        }
        return out;
    };
    const first = parts[0];
    const tones = new Set(parts.map(p => p.tone).filter(Boolean));
    const synopses = parts.map(p => p.synopsis).filter((s): s is string => Boolean(s));
    return {
        title: first.title,
        literalTitle: first.literalTitle,
        abstractTitle: first.abstractTitle,
        synopsis: synopses.length > 0 ? synopses.join(' ') : undefined,
        summary: parts.map(p => p.summary).filter(Boolean).join('\n\n'),
        keywords: union(parts.map(p => p.keywords)),
        npcs: union(parts.map(p => p.npcs)),
        majorEvents: union(parts.map(p => p.majorEvents)),
        // Threads still open at the end of the chapter are the last part's.
        unresolvedThreads: [...parts[parts.length - 1].unresolvedThreads],
        tone: tones.size === 1 ? [...tones][0] : 'mixed',
        themes: union(parts.map(p => p.themes)),
    };
}

