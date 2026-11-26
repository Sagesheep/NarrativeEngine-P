/**
 * WO-C §9.3 (order "C2") — the Living-world adaptation pass.
 *
 * Infers PROVISIONAL motivations (`NPCEntry.wants`) for imported SillyTavern
 * cards from a small, bounded slice of each card. Nothing else. It never writes
 * `personalityHex`, `traits`, `relations`, `pcRelation` or `affinity` (WO-A2 §0
 * is an invariant here too), never sends a `character_book`, never performs a
 * web search, and runs only AFTER the import is already on disk (§9.3) so a
 * failure or a cancel can never lose an import.
 *
 * Pure of the store: every endpoint getter and the model call itself arrive as
 * dependencies (`AdaptationDeps`), so this module tests without mounting
 * anything and without a network.
 *
 * MODEL CALL (mirrors `services/character/aiGuidedGeneration.ts`): the
 * streaming `sendMessage`, never `llmCall`. `llmCall` hard-caps output tokens,
 * and on a thinking-enabled endpoint the cap is *spent* by the reasoning pass —
 * a reasoning model returns a truncated stub. The streaming path passes no cap
 * and leaves `thinkingEffort` undefined so the provider's own setting applies.
 */

import type { LLMProvider, NPCEntry, NPCWants } from '../../types';
import type {
    AdaptationTarget,
    AdaptedWants,
    AdaptationResult,
    AdaptationDeps,
    AdaptationRunOpts,
    AdaptationMessage,
    AdaptationModelCall,
    AdaptationEndpointInfo,
} from './adaptationTypes';
import { ADAPTATION_WANT_LIMITS } from './adaptationTypes';
import { isStructuredText, wppToTraitLines, cutAtSentence } from './stCardConvert';
import { countTokens } from '../infrastructure/tokenizer';
import { sendMessage, type OpenAIMessage } from '../llm/llmService';

// ─── Caps (§9.3 "bounded card text") ─────────────────────────────────────────

/** Per-field character caps for the extract. Deliberately smaller than the card. */
const PERSONALITY_CAP = 400;
const DESCRIPTION_CAP = 600;
const SCENARIO_CAP = 300;
const NOTES_CAP = 200;
/** Tags are unbounded on a card; a 300-tag dump would swamp the extract. */
const TAGS_CAP = 200;

/** §9.3 "bounded groups chosen by input-token size" — extract tokens per batch. */
export const DEFAULT_BATCH_TOKEN_BUDGET = 1800;
/** §9.3 "approximately 4-8 cards" — a hard ceiling for tiny cards that would otherwise pile up. */
export const MAX_BATCH_CARDS = 8;

/** Failure text shown next to a fallback NPC in the completion UI. */
const ERROR_CAP = 160;

const DEFAULT_TRACKING_LABEL = 'st-import-adaptation';

// ─── Endpoint resolution (§9.3 "the displayed configured model/provider") ────

/**
 * WO-A2 §2.2's chain: `utility ?? auxiliary ?? summarizer ?? story`. Cheap
 * models first; the story AI is the last resort. This deliberately differs from
 * `useSelectionActions.ts`'s `summarizer ?? utility ?? story` — do not
 * "harmonize" them.
 *
 * The getters are injected rather than read from the store so this module stays
 * store-free and testable.
 */
export function resolveAdaptationEndpoint(getters: {
    utility: () => LLMProvider | undefined;
    auxiliary: () => LLMProvider | undefined;
    summarizer: () => LLMProvider | undefined;
    story: () => LLMProvider | undefined;
}): LLMProvider | undefined {
    return getters.utility() ?? getters.auxiliary() ?? getters.summarizer() ?? getters.story();
}

/** What the Review step shows beside "Living-world adaptation". */
export function describeAdaptationEndpoint(p: LLMProvider): AdaptationEndpointInfo {
    return {
        label: (p.label ?? '').trim() || 'Unnamed endpoint',
        modelName: (p.modelName ?? '').trim() || 'unknown model',
    };
}

// ─── The model call ──────────────────────────────────────────────────────────

/**
 * Wraps the streaming `sendMessage` into the single `AdaptationModelCall`
 * dependency. Resolves with the cumulative content, rejects on transport error
 * and on abort — `runAdaptation` reads `deps.signal` to tell the two apart.
 *
 * No sampling override and no `thinkingEffort`: both inherit the provider.
 */
export function makeModelCaller(provider: LLMProvider, opts?: { trackingLabel?: string }): AdaptationModelCall {
    const trackingLabel = opts?.trackingLabel ?? DEFAULT_TRACKING_LABEL;

    return (messages: AdaptationMessage[], signal: AbortSignal) => new Promise<string>((resolve, reject) => {
        if (signal.aborted) { reject(new Error('aborted')); return; }

        const controller = new AbortController();
        let settled = false;

        const onAbort = () => {
            if (settled) return;
            settled = true;
            controller.abort();
            reject(new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });

        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            fn();
        };

        const payload: OpenAIMessage[] = messages.map(m => ({ role: m.role, content: m.content }));
        let content = '';

        const failed = (err: unknown) => settle(() => reject(err instanceof Error ? err : new Error(String(err))));

        try {
            const call = sendMessage(
                provider,
                payload,
                (full) => { content = full; },                   // onChunk (cumulative)
                (full) => settle(() => resolve(full || content)), // onDone
                (err) => settle(() => reject(new Error(err))),    // onError
                undefined,                                        // tools
                controller,                                       // abortController
                undefined,                                        // sampling — inherit
                undefined,                                        // thinkingEffort — inherit the provider
                trackingLabel,
            );
            if (call && typeof call.catch === 'function') call.catch(failed);
        } catch (err) {
            failed(err);
        }
    });
}

// ─── The extract (§9.3 "bounded card text", never the lorebook) ──────────────

export type CardExtract = { id: string; name: string; text: string; tokens: number };

/** Keep whole lines up to `max`; only a single over-long line is cut mid-line. */
function capLines(text: string, max: number): string {
    const t = (text || '').trim();
    if (t.length <= max) return t;
    const kept: string[] = [];
    let len = 0;
    for (const line of t.split('\n')) {
        const add = kept.length === 0 ? line.length : line.length + 1;
        if (len + add > max) break;
        kept.push(line);
        len += add;
    }
    if (kept.length > 0) return kept.join('\n').trim();
    return cutAtSentence(t.split('\n')[0], max);
}

/**
 * Prose is cut at a sentence boundary; W++/structured text becomes readable
 * trait lines first (the §3.1 guard — bracket garbage never reaches a prompt).
 */
function shapeField(text: string, cap: number): string {
    const t = (text || '').trim();
    if (!t) return '';
    if (isStructuredText(t)) return capLines(wppToTraitLines(t), cap);
    return cutAtSentence(t, cap);
}

function poolWantsLine(wants: NPCWants | undefined): string {
    if (!wants) return '';
    const short = (wants.short ?? []).map(w => (w || '').trim()).filter(Boolean);
    const medium = (wants.medium ?? []).map(w => (w || '').trim()).filter(Boolean);
    const long = (wants.long ?? '').trim();
    if (short.length === 0 && medium.length === 0 && !long) return '';
    const parts: string[] = [];
    if (short.length > 0) parts.push(`short — ${short.join(', ')}`);
    if (medium.length > 0) parts.push(`medium — ${medium.join(', ')}`);
    if (long) parts.push(`long — ${long}`);
    return `Placeholder motivations (replace): ${parts.join('; ')}`;
}

/**
 * §9.3 — one bounded extract per card.
 *
 * Reads ONLY `name`, `personality`, `description`, `scenario`, `tags` and a
 * prose `creator_notes`, plus the NPC's current pool wants so the model knows
 * what it is replacing. `character_book`, `system_prompt`,
 * `post_history_instructions`, `mes_example`, `first_mes` and
 * `alternate_greetings` are never read: "Do not send entire embedded lorebooks
 * merely to infer motivations", and an ST system prompt is quarantined text
 * (§3.3), not characterization.
 */
export function buildCardExtract(target: AdaptationTarget): CardExtract {
    const card = target.card;
    const name = (target.name || card.name || '').trim();

    const personality = shapeField(card.personality ?? '', PERSONALITY_CAP);
    const description = shapeField(card.description ?? '', DESCRIPTION_CAP);
    const scenario = shapeField(card.scenario ?? '', SCENARIO_CAP);
    const tags = (card.tags ?? []).map(t => (t || '').trim()).filter(Boolean).join(', ');
    const rawNotes = (card.creator_notes ?? '').trim();
    // Structured creator notes are metadata noise, not characterization.
    const notes = rawNotes && !isStructuredText(rawNotes) ? cutAtSentence(rawNotes, NOTES_CAP) : '';

    const lines: string[] = [`Name: ${name || '(unnamed)'}`];
    if (personality) lines.push(`Personality: ${personality}`);
    if (description) lines.push(`Description: ${description}`);
    if (scenario) lines.push(`Scenario: ${scenario}`);
    if (tags) lines.push(`Tags: ${capLines(tags, TAGS_CAP)}`);
    if (notes) lines.push(`Creator notes: ${notes}`);
    const placeholder = poolWantsLine(target.npc?.wants);
    if (placeholder) lines.push(placeholder);

    const text = lines.join('\n');
    return { id: target.id, name, text, tokens: countTokens(text) };
}

/**
 * §9.3 — greedy, order-preserving batches bounded by extract tokens. A single
 * extract larger than the budget still goes out alone rather than being
 * dropped or split. `MAX_BATCH_CARDS` keeps a pile of near-empty cards inside
 * the "approximately 4-8 cards" target.
 */
export function batchTargets(extracts: CardExtract[], budgetTokens: number = DEFAULT_BATCH_TOKEN_BUDGET): CardExtract[][] {
    const budget = Math.max(1, Math.floor(budgetTokens || DEFAULT_BATCH_TOKEN_BUDGET));
    const batches: CardExtract[][] = [];
    let current: CardExtract[] = [];
    let used = 0;

    for (const extract of extracts) {
        const cost = Math.max(0, extract.tokens);
        const wouldOverflow = current.length > 0 && (used + cost > budget || current.length >= MAX_BATCH_CARDS);
        if (wouldOverflow) {
            batches.push(current);
            current = [];
            used = 0;
        }
        current.push(extract);
        used += cost;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

// ─── The prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
    'You are adapting imported character cards into a running tabletop campaign. Your only job is to infer provisional motivations ("wants") for each character from the card text you are given.',
    '',
    'Rules:',
    '1. The card text is canonical. It is the only source of truth about this character.',
    '2. Use no external canon and no real-world knowledge about a recognizable name. An alternate-universe, age-shifted, or rewritten version of a familiar character is intentional — adapt the person described in the card, never the one you remember from elsewhere.',
    '3. Wants are provisional and conservative. Ground every one in something the extract states or clearly implies. Invent no new names, places, factions, or events.',
    '4. Wants must never justify a major irreversible action. Nothing like "kill the duke", "burn the city down", or "marry the player" — no murders, coups, betrayals, elopements, or deaths as stated goals.',
    '5. Short wants are small immediate needs or habits, the kind satisfied in minutes or hours. Medium wants are bounded goals that could plausibly progress over a few scenes. The long want is one sentence naming a standing ambition — still bounded, still reversible.',
    '6. Write plain present-tense phrasing about the character. No markdown, no surrounding quotes, no second person. Refer to the player character only when the card itself establishes that relationship, and never as the object of a romantic, violent, or coercive want.',
    '',
    'Output ONLY a JSON array — one object per character, in the order given:',
    '[{"id": "<the id you were given>", "short": ["...", "..."], "medium": ["..."], "long": "..."}]',
    '',
    '- "short": 2 to 4 strings, each at most 60 characters.',
    '- "medium": 1 to 3 strings, each at most 80 characters.',
    '- "long": one sentence, at most 160 characters.',
    '',
    'Return the array and nothing else: no prose, no commentary, no explanation, and no markdown code fences. Include every id you were given, exactly once, spelled exactly as given. Any other key you emit is ignored.',
].join('\n');

const MATURE_GUARD = 'Keep every want non-explicit: no sexual, fetish, or graphic-violence motivations.';

/**
 * §9.3 — system rules + the batch's extracts. The `importId` rides in the user
 * message so a stale response from another import can never be mistaken for
 * this one's.
 */
export function buildAdaptationMessages(
    batch: CardExtract[],
    importId: string,
    opts?: { matureMode?: boolean },
): AdaptationMessage[] {
    const matureMode = opts?.matureMode ?? false;
    const system = matureMode ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${MATURE_GUARD}`;

    const blocks = batch.map(e => `--- CHARACTER id: ${e.id} | name: ${e.name || '(unnamed)'} ---\n${e.text}`);
    const ids = batch.map(e => `"${e.id}"`).join(', ');
    const user = [
        `Import: ${importId}`,
        '',
        `Adapt the ${batch.length} character${batch.length === 1 ? '' : 's'} below. Any "Placeholder motivations" line shows mechanical pool defaults — replace them.`,
        '',
        blocks.join('\n\n'),
        '',
        `Return one JSON object per character above, using exactly these ids: ${ids}.`,
    ].join('\n');

    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

// ─── Parsing + clamping (§9.3 "isolated JSON results") ───────────────────────

type LooseRecord = Record<string, unknown>;

function stripFences(text: string): string {
    return (text || '').replace(/```[A-Za-z0-9_-]*\s*\n?/g, '').replace(/```/g, '');
}

function cleanItem(raw: string): string {
    let t = raw.replace(/\s+/g, ' ').trim();
    t = t.replace(/^[-*•]\s+/, '');
    if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
        t = t.slice(1, -1).trim();
    }
    return t;
}

/** Hard length clamp, preferring a word boundary. Never exceeds `max`. */
function truncateTo(text: string, max: number): string {
    if (text.length <= max) return text;
    const window = text.slice(0, max);
    const cut = window.lastIndexOf(' ');
    return (cut > max * 0.6 ? window.slice(0, cut) : window).trim();
}

/** Tolerates a bare string where an array was asked for. */
function toStringArray(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === 'string');
}

function clampList(value: unknown, maxItems: number, maxChars: number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of toStringArray(value)) {
        const item = truncateTo(cleanItem(raw), maxChars);
        if (!item) continue;
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        if (out.length >= maxItems) break;
    }
    return out;
}

function clampLong(value: unknown): string {
    const first = typeof value === 'string' ? value : toStringArray(value)[0] ?? '';
    return truncateTo(cleanItem(first), ADAPTATION_WANT_LIMITS.longChars);
}

/** Every arriving want passes through here — §9.3 "clamp everything". */
export function clampAdaptedWants(raw: { short?: unknown; medium?: unknown; long?: unknown }): AdaptedWants {
    return {
        short: clampList(raw.short, ADAPTATION_WANT_LIMITS.shortItems, ADAPTATION_WANT_LIMITS.shortChars),
        medium: clampList(raw.medium, ADAPTATION_WANT_LIMITS.mediumItems, ADAPTATION_WANT_LIMITS.mediumChars),
        long: clampLong(raw.long),
    };
}

function isRecord(value: unknown): value is LooseRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Last-ditch recovery: pull individual flat `{...}` objects out of broken JSON. */
function salvageObjects(text: string): LooseRecord[] {
    const out: LooseRecord[] = [];
    const matches = text.match(/\{[^{}]*\}/g) ?? [];
    for (const candidate of matches) {
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (isRecord(parsed)) out.push(parsed);
        } catch {
            // A single unrecoverable object never costs the rest of the batch.
        }
    }
    return out;
}

function extractRecords(text: string): LooseRecord[] {
    const body = stripFences(text);
    const first = body.indexOf('[');
    const last = body.lastIndexOf(']');
    if (first >= 0 && last > first) {
        try {
            const parsed: unknown = JSON.parse(body.slice(first, last + 1));
            if (Array.isArray(parsed)) {
                const records = parsed.filter(isRecord);
                if (records.length > 0) return records;
            }
        } catch {
            // Fall through to the salvage pass.
        }
    }
    // A single bare object is also acceptable.
    return salvageObjects(body);
}

function truncateError(message: string): string {
    const t = (message || '').replace(/\s+/g, ' ').trim() || 'unknown error';
    return t.length <= ERROR_CAP ? t : `${t.slice(0, ERROR_CAP - 1).trim()}…`;
}

/**
 * §9.3 — tolerant parse into one result per EXPECTED id, in expected order.
 *
 * Ids the batch did not ask for are dropped. Keys the model volunteers beyond
 * `short`/`medium`/`long` (`personalityHex`, `traits`, `relations`,
 * `pcRelation`, `affinity`, …) are never read: this pass writes wants and
 * nothing else, and `AdaptationResult` cannot even carry them.
 */
export function parseAdaptationResponse(text: string, expected: { id: string; name: string }[]): AdaptationResult[] {
    const records = extractRecords(text ?? '');
    const byId = new Map<string, LooseRecord>();
    for (const record of records) {
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!id || byId.has(id)) continue;   // first occurrence wins
        byId.set(id, record);
    }

    // A single-character batch whose one object forgot its id is still usable.
    if (expected.length === 1 && records.length === 1 && byId.size === 0) {
        byId.set(expected[0].id, records[0]);
    }

    const unparseable = records.length === 0;

    return expected.map(({ id, name }) => {
        const record = byId.get(id);
        if (!record) {
            return {
                id,
                name,
                status: 'failed' as const,
                error: unparseable ? 'model response was not usable JSON' : 'model returned no entry for this character',
            };
        }
        const wants = clampAdaptedWants({ short: record.short, medium: record.medium, long: record.long });
        if (wants.short.length === 0 && wants.medium.length === 0 && !wants.long) {
            return { id, name, status: 'failed' as const, error: 'model returned no usable wants' };
        }
        return { id, name, status: 'adapted' as const, wants };
    });
}

// ─── Apply ───────────────────────────────────────────────────────────────────

/**
 * Returns a NEW entry whose `wants` are the adapted ones and whose provenance
 * reads `'inferred'`. Every other field is carried across untouched — in
 * particular `personalityHex` and `traits`, which this pass never authors.
 *
 * An empty adapted tier keeps the mechanical pool entry for that tier: a
 * partial answer degrades to the offline fallback, never to nothing.
 */
export function applyAdaptedWants(npc: NPCEntry, wants: AdaptedWants): NPCEntry {
    const existing: NPCWants = npc.wants ?? { short: [], medium: [], long: '' };
    const clamped = clampAdaptedWants(wants);

    return {
        ...npc,
        wants: {
            short: clamped.short.length > 0 ? clamped.short : [...(existing.short ?? [])],
            medium: clamped.medium.length > 0 ? clamped.medium : [...(existing.medium ?? [])],
            long: clamped.long || (existing.long ?? ''),
        },
        wantsProvenance: 'inferred',
    };
}

// ─── The run ─────────────────────────────────────────────────────────────────

function cancelled(id: string, name: string): AdaptationResult {
    return { id, name, status: 'cancelled', error: 'cancelled' };
}

/**
 * §9.3 — extract, batch, then call the model once per batch, sequentially.
 *
 * Isolation is the whole point: a thrown call fails only the NPCs in THAT
 * batch and the run continues. An abort before a batch starts marks every
 * remaining NPC `cancelled`; an abort mid-call rejects, and that batch is
 * `cancelled` too. Exactly one result per target, in target order.
 *
 * Retrying is just calling this again with the failed targets — there is no
 * special retry API.
 */
export async function runAdaptation(
    targets: AdaptationTarget[],
    deps: AdaptationDeps,
    opts: AdaptationRunOpts,
): Promise<AdaptationResult[]> {
    if (targets.length === 0) return [];

    const extracts = targets.map(buildCardExtract);
    const batches = batchTargets(extracts, opts.batchTokenBudget ?? DEFAULT_BATCH_TOKEN_BUDGET);
    const signal = deps.signal ?? new AbortController().signal;
    // `AppSettings.matureMode`, read at the UI call site. Absent means off: the
    // prompt then carries the guard line, which is the conservative default.
    const matureMode = opts.matureMode ?? false;

    const collected = new Map<string, AdaptationResult>();
    const record = (result: AdaptationResult) => {
        if (!collected.has(result.id)) collected.set(result.id, result);
        deps.onResult?.(result);
    };

    const total = targets.length;
    let done = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const expected = batch.map(e => ({ id: e.id, name: e.name }));

        if (signal.aborted) {
            for (let i = batchIndex; i < batches.length; i++) {
                for (const e of batches[i]) record(cancelled(e.id, e.name));
            }
            break;
        }

        deps.onProgress?.({
            done,
            total,
            batchIndex,
            batchCount: batches.length,
            inFlight: batch.map(e => e.name),
        });

        let text: string | null = null;
        let failure = '';
        try {
            text = await deps.callModel(buildAdaptationMessages(batch, opts.importId, { matureMode }), signal);
        } catch (err) {
            failure = truncateError(err instanceof Error ? err.message : String(err));
        }

        if (text === null) {
            // Mid-call abort presents as a rejection; the signal tells us which it was.
            const wasCancelled = signal.aborted;
            for (const e of expected) {
                record(wasCancelled ? cancelled(e.id, e.name) : { id: e.id, name: e.name, status: 'failed', error: failure });
            }
        } else {
            for (const result of parseAdaptationResponse(text, expected)) record(result);
        }

        done += batch.length;
    }

    return targets.map(t => collected.get(t.id) ?? {
        id: t.id,
        name: t.name,
        status: 'failed' as const,
        error: 'no result returned for this character',
    });
}
