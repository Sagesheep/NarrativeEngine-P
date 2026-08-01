import type { ProviderConfig, EndpointConfig, DivergenceEntry, SceneEvent, SceneEventType } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { extractJson } from '../infrastructure/jsonExtract';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { DIVERGENCE_CATEGORIES, CATEGORY_DEFINITIONS, coerceCategory, isFactActive, isValidStateKey } from '../campaign-state/divergenceRegister';
import { uid } from '../../utils/uid';
import { truncateScenesToBudget } from './shared';
import { parseChapterSummaryOutput } from './chapterSummary';
import type { ChapterSummaryOutput } from './chapterSummary';

// ─── Combined Seal Call (summary + divergences in ONE LLM call) ───

const COMBINED_SEAL_TOKEN_BUDGET = 12000;

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
): string {
    const truncated = truncateScenesToBudget(scenes, COMBINED_SEAL_TOKEN_BUDGET);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');

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

    return `You are a TTRPG campaign archivist. Perform THREE tasks in a single response:

TASK 1 — Generate a structured chapter summary.
TASK 2 — Extract established facts that would BREAK A FUTURE SCENE if the AI contradicted them.
TASK 3 — Extract structured scene events for each scene.

CHAPTER: "${chapterTitle || 'Untitled'}"
SCENE IDs IN THIS CHAPTER: ${sceneIds.join(', ')}

NPC LEDGER (resolve names to IDs):
${npcList || '(no NPCs in ledger)'}

${stateCandidatesSection}
SCENE CONTENT:
${sceneContent}
${witnessAuditSection}

OUTPUT FORMAT — a single JSON object with the keys ${outputKeys}.

The "summary" value must be this JSON shape:
{
    "title": "Short evocative chapter title",
    "literalTitle": "Concrete factual title, e.g. The Battle at Locust Town",
    "abstractTitle": "Thematic title, e.g. Old Wounds",
    "synopsis": "1-2 sentences, ultra-high-level, past tense, covering only this chapter",
    "summary": "3-5 sentence narrative summary of what happened",
    "keywords": ["keyword1", "keyword2"],
    "npcs": ["NPC Name 1", "NPC Name 2"],
    "majorEvents": ["Event description 1", "Event description 2"],
    "unresolvedThreads": ["Thread 1", "Thread 2"],
    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",
    "themes": ["theme1", "theme2"]
}

The "divergences" value must be an object with one key per category slot. Each value is an array of fact objects, or [] if empty. Example:
{
    "locations": [
        { "text": "Eastern gate destroyed by siege", "sceneRef": "014", "npcIds": [], "knownBy": [], "unrecognizedNpcNames": [] }
    ],
    "npc_events": [
        { "text": "Grak allied with the player", "sceneRef": "018", "npcIds": ["npc_42"], "knownBy": ["npc_42"], "unrecognizedNpcNames": [] }
    ],
    "promises_debts": [],
    "world_state": [],
    "party_facts": [],
    "rules_lore": [],
    "misc": []
}

The "sceneEvents" value must be an object mapping scene IDs to arrays of structured event objects, or {} if no scenes had meaningful events. Example:
{
    "014": [
        {
            "eventType": "item_acquired",
            "importance": 7,
            "text": "Tav bought a leather chestpiece for 80gp",
            "characters": ["Tav", "Astarion"],
            "locations": ["Baldur's Gate"],
            "items": ["leather chestpiece", "80gp"],
            "concepts": ["trade"],
            "cause": "Tav needed better armor before the next dungeon",
            "result": "Tav now wears the leather chestpiece"
        }
    ],
    "015": []
}

SCENE EVENT RULES:
- eventType MUST be one of: combat, discovery, item_acquired, item_lost, relationship_shift, travel, promise, betrayal, death, revelation, quest_milestone, other
- importance is 1-10
- text is one short sentence describing what happened
- characters/locations/items/concepts are optional arrays of canonical names (use NPC names from the ledger above when possible)
- cause/result are short plain-text causal beats (one short clause each, optional)
- Cap at MAXIMUM 3 events per scene. Skip scenes with nothing meaningful (use [] or omit the scene key).
- Only include scenes from this chapter's scene IDs.

${witnessAuditSection ? `
WITNESS CORRECTIONS:
If you found errors in the per-scene witness data above, include a "witness_corrections" key at the top level of the JSON:
"witness_corrections": { "014": ["Aldric", "Borric"], "022": ["Morrigan"] }
This maps scene IDs to the CORRECT list of NPC NAMES who were physically present in that scene. Only include scenes where you disagree with the pre-captured data.` : ''}

Category definitions:

${divergenceSlots}

### MISC
Definition: ${CATEGORY_DEFINITIONS.misc}
Output: JSON array for this slot, or [] if empty.

DIVERGENCE EXTRACTION RULES:
- Each fact is ONE SHORT SENTENCE, max 15 words. No compound sentences, no explanations.
- sceneRef must be one of: ${sceneIds.join(', ')}
- npcIds: list the NPC ledger IDs mentioned. If a name appears that is NOT in the ledger, put it in unrecognizedNpcNames instead.
- knownBy: list the NPC ledger IDs of witnesses who SAW or PARTICIPATED in this event. Only include NPCs who were present when the fact happened. Omit this field for rules_lore and locations (those are broadcast knowledge). If unsure, omit knownBy.
- Focus on: permanent changes, new information, relationship shifts, acquisitions, losses, oaths, regime changes.
- Skip transient details, emotional narration, momentary states, and anything the archive would already surface.
- For a fact with exactly one current value, you MAY add 'stateKey' using only:
  'item:<slug>:holder', 'npc:<id>:location', 'npc:<id>:status',
  'npc:<id>:allegiance', 'place:<slug>:controller', or 'debt:<slug>:status'.
- Events and observations MUST omit stateKey.
- To replace a listed CURRENT STATE FACT, set 'supersedesFactId' to its ID and use
  the exact same stateKey. Never supersede a fact not listed above.
- If uncertain, omit both fields and emit an additive fact.
- If a slot is empty, output [] for that slot.

SUMMARY RULES:
1. Keywords should be distinctive nouns/places/factions — not generic words
2. NPCs should include all significant named characters who appeared or were discussed
3. Major events are plot-critical beats only (not every combat round)
4. Unresolved threads are open plot hooks, promises, or mysteries
5. Title should be 2-5 words, evocative
6. Summary should read like a campaign journal entry, not a list`;
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
    npcLedger: { id: string; name: string; aliases: string }[]
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

                let knownBy: string[] | undefined = undefined;
                if (Array.isArray(rawItem.knownBy)) {
                    const resolvedKnown: string[] = [];
                    for (const kb of rawItem.knownBy) {
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
                    if (resolvedKnown.length > 0) knownBy = resolvedKnown;
                }

                if (category === 'rules_lore' || category === 'locations') {
                    knownBy = undefined;
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

    const witnessCorrections = extractWitnessCorrections(parsed);

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
): Promise<CombinedSealResult> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = buildCombinedSealPrompt(scenes, chapterTitle, sceneIds, npcLedger, indexEntries, activeStateFacts);
        const label = attempt === 0 ? '' : ' (retry)';

        console.log(`[CombinedSeal] Generating summary + divergences${label}...`, {
            sceneCount: scenes.length,
            sceneIds: sceneIds.length,
            promptTokens: countTokens(prompt),
        });

        const output = modelCall
            ? await modelCall({ prompt, priority: 'low', maxTokens: scanBudget > 0 ? scanBudget : 2000, trackingLabel: 'chapter-seal', timeoutMs: AI_CALL_TIMEOUT_MS })
            : await llmCall(provider!, prompt, { priority: 'low', maxTokens: scanBudget > 0 ? scanBudget : 2000, trackingLabel: 'chapter-seal', timeoutMs: AI_CALL_TIMEOUT_MS });
        const result = parseCombinedSealOutput(output, chapterId, sceneIds, npcLedger);

        if (result.summary && !result.divergenceParseError) {
            return result;
        }
        if (result.summary && result.divergenceParseError) {
            console.warn(`[CombinedSeal] Attempt ${attempt + 1}: summary OK but divergence parse failed — retrying divergences`);
            continue;
        }
        console.warn(`[CombinedSeal] Attempt ${attempt + 1} produced no usable output`);
    }

    return { summary: null, divergences: [], divergenceParseError: true };
}
