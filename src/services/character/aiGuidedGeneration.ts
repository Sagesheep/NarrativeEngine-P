import type { EndpointConfig, ProviderConfig, CharacterCreationDraft, CreationSlot, LoreChunk } from '../../types';
import { sendMessage, type OpenAIMessage } from '../llm/llmService';
import { parseInterviewLines, linesToSlotMap } from './parseInterviewLines';
import { buildGuidedCreationLoreExcerpt, listCreationHeaders, packSelectedChunks, creationExcerptBudget } from './loreExcerptBuilder';

/**
 * WO-A2 §2.4 + §2.7 — the LLM calls for AI-Guided creation.
 *
 * STREAMING (2026-07-23 rework): these calls route through the streaming
 * `sendMessage` path, NOT the blocking `llmCall`. Three reasons, all learned
 * the hard way from a hung DeepSeek reasoner:
 *   1. No `max_tokens` cap. `llmCall` hard-capped output at 800/1200; a
 *      reasoning model with high thinking effort blew that budget mid-thought
 *      and returned a truncated stub ("picks nonsense"). The streaming path
 *      passes no cap → inherits the provider's configured budget.
 *   2. Live thinking. A non-streamed reasoner holds one blocking socket and
 *      shows the user nothing until it fully finishes — a dead spinner that
 *      looks identical to a hang. Streaming surfaces `reasoning_content` deltas
 *      so the user watches it think.
 *   3. Rolling idle timeout. `sendMessage` resets its deadline on every chunk,
 *      so a legitimately long think isn't guillotined by a fixed wall-clock
 *      deadline, but a truly dead socket still aborts.
 *
 * Thinking effort is intentionally NOT pinned here — a reasoning model needs to
 * think to produce good, world-consistent questions. We inherit the provider's
 * setting (pass `undefined`).
 *
 * §0 invariant (load-bearing): the model supplies question *wording* and
 * converts prose answers into prose fields. It never sees, chooses, or writes a
 * field binding. The skeleton is fixed — line `N)` maps to slot `N` by
 * construction. Output is numbered plain text, NOT JSON with declared mappings.
 */

const STOCK_QUESTIONS: Record<CreationSlot, string> = {
    1: 'What is your character\'s name?',
    2: 'Where does your character come from? Describe their origin or background.',
    3: 'Who does your character owe allegiance to? A faction, a cause, a people?',
    4: 'What can your character do? Describe a signature capability or power.',
    5: 'How does your character carry themselves in the world?',
    6: 'How does your character speak? Describe their voice and verbal quirks.',
    7: 'What does your character want, in the long run?',
    8: 'What does your character carry with them at the start?',
    9: 'Describe your character\'s appearance.',
};

/** Slots the AI reskins (everything except the engine-owned name + visual form). */
const AI_SLOTS: CreationSlot[] = [2, 3, 4, 5, 6, 7, 8];

/** Live progress surfaced to the wizard so it can render the prompt + stream. */
export type GuidedProgress = {
    stage: 'lore-select' | 'questions' | 'convert' | 'roll';
    /** The exact prompt sent to the model (for the "Sent to AI" pane). */
    prompt: string;
    /** Cumulative reasoning/thinking text. */
    reasoning: string;
    /** Cumulative answer text. */
    content: string;
};

export type GenerationResult =
    | { ok: true; draft: CharacterCreationDraft; sentPrompt: string }
    | { ok: false; reason: 'no-lore' | 'call-failed' | 'unparseable'; retryable: boolean };

type StreamOpts = {
    signal?: AbortSignal;
    onProgress?: (p: GuidedProgress) => void;
    /** The model's context-window size — drives the 20%-floored excerpt budget. */
    maxContextTokens?: number;
};

/**
 * Wrap the streaming `sendMessage` into a promise that resolves with the final
 * text, surfacing reasoning + content deltas via `onProgress`. Self-contained:
 * renders nothing, touches no chat state — the wizard owns all UI.
 */
function streamGuidedCall(
    provider: EndpointConfig | ProviderConfig,
    prompt: string,
    opts: {
        temperature?: number;
        signal?: AbortSignal;
        trackingLabel: string;
        stage: GuidedProgress['stage'];
        onProgress?: (p: GuidedProgress) => void;
    },
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        if (opts.signal?.aborted) { reject(new Error('aborted')); return; }

        const controller = new AbortController();
        opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });

        const messages: OpenAIMessage[] = [{ role: 'user', content: prompt }];
        let content = '';
        let reasoning = '';

        // Fire once up front so the "Sent to AI" pane shows the prompt immediately.
        opts.onProgress?.({ stage: opts.stage, prompt, reasoning, content });

        const emit = () => opts.onProgress?.({ stage: opts.stage, prompt, reasoning, content });

        sendMessage(
            provider,
            messages,
            (full) => { content = full; emit(); },          // onChunk (cumulative content)
            (full) => { resolve(full); },                   // onDone
            (err) => { reject(new Error(err)); },           // onError
            undefined,                                      // tools
            controller,                                     // abortController
            opts.temperature !== undefined ? { temperature: opts.temperature } : undefined, // sampling
            undefined,                                      // thinkingEffort — inherit provider
            opts.trackingLabel,                             // trackingLabel
            (r) => { reasoning = r; emit(); },              // onReasoning (cumulative)
        );
    });
}

// ── Header pre-pass — AI picks the most relevant lore sections ───────────────

const HEADER_PICK_MAX = 10;

/**
 * Send the AI the LIST of lore section headers (cheap — headers only, not
 * content) and let it pick up to 10 most relevant for character creation. This
 * fixes the coverage gap where a depth-first category excerpt buries
 * faction/power_system behind a big world_overview.
 *
 * `character` chunks (individual NPC bios) are excluded from the menu. Falls
 * back to `{ chunks: [], usedAI: false }` on any failure — the caller then uses
 * the category-filter excerpt. Small lore (≤10 eligible chunks) skips the call
 * entirely and returns them all (nothing to prune).
 */
export async function selectRelevantLoreHeaders(
    provider: EndpointConfig | ProviderConfig,
    loreChunks: LoreChunk[],
    opts?: StreamOpts,
): Promise<{ chunks: LoreChunk[]; usedAI: boolean }> {
    const candidates = listCreationHeaders(loreChunks);
    if (candidates.length === 0) return { chunks: [], usedAI: false };
    if (candidates.length <= HEADER_PICK_MAX) return { chunks: candidates, usedAI: false };

    const menu = candidates.map((c, i) => `${i + 1}. ${c.header || 'Untitled'} [${c.category}]`).join('\n');
    const prompt = `Below are the section headers of a world's lore. Pick the ${HEADER_PICK_MAX} sections MOST useful for guiding a new player through creating their character — origin/background, factions & allegiances, power or magic systems, culture, economy, geography. Do NOT pick sections about specific individual named characters (those are NPC bios, not world-building).

[SECTIONS]
${menu}
[END SECTIONS]

Output ONLY the section numbers of your picks, comma-separated, most relevant first. At most ${HEADER_PICK_MAX} numbers. Example: 3, 1, 7, 12`;

    let raw: string;
    try {
        raw = await streamGuidedCall(provider, prompt, {
            temperature: 0.2,
            signal: opts?.signal,
            trackingLabel: 'Guided-Creation-LoreSelect',
            stage: 'lore-select',
            onProgress: opts?.onProgress,
        });
    } catch (err) {
        console.warn('[Guided Creation] Header-pick call failed — falling back to category filter:', err);
        return { chunks: [], usedAI: false };
    }

    const nums = (raw.match(/\d+/g) ?? [])
        .map(n => parseInt(n, 10))
        .filter(n => n >= 1 && n <= candidates.length);
    const seen = new Set<number>();
    const picked: LoreChunk[] = [];
    for (const n of nums) {
        if (seen.has(n)) continue;
        seen.add(n);
        picked.push(candidates[n - 1]);
        if (picked.length >= HEADER_PICK_MAX) break;
    }
    if (picked.length === 0) return { chunks: [], usedAI: false };
    return { chunks: picked, usedAI: true };
}

// ── §2.4 — question generation (single streamed call for slots 2–8) ──────────

function buildQuestionsPrompt(loreExcerpt: string): string {
    // Display the 7 questions numbered 1–7 (models number from 1 naturally). The
    // parser maps position → slot (line 1 → slot 2 … line 7 → slot 8), so the
    // display numbering is cosmetic and MUST be 1-based: absolute (2–8) numbering
    // collides with the parser's relative-first interpretation and drops slot 2.
    const stockLines = AI_SLOTS.map((s, i) => `${i + 1}) ${STOCK_QUESTIONS[s]}`).join('\n');
    return `You are helping a player create a roleplaying character for the world below. The player may be brand new to this world and not know its places, factions, classes, or customs — so each question must teach as it asks. Reskin each question to fit the world's tone and vocabulary, keeping the SAME meaning and the SAME number. Do not add or remove questions. Do not answer them.

[WORLD LORE]
${loreExcerpt}
[END LORE]

[STOCK QUESTIONS — reskin each one for this world]
${stockLines}
[END STOCK]

Where the lore names concrete options relevant to a question — settlements or regions (origin), factions or banners (allegiance), classes or powers (capability), speech styles or dialects (voice), and so on — fold 2 to 4 of them INTO that question as gentle examples, phrased as "for instance…" or "such as…". This orients a player who does not know the world. Hard rules for examples:
- Draw examples ONLY from the lore above. Never invent a place, faction, class, or term the lore does not contain.
- If the lore names no concrete options for a question, leave that question open-ended (no examples). Do not force it.
- Examples are hints, not a menu — never tell the player they must pick from the list; they may answer freely.
- Keep each question to ONE line and under ~500 characters total. Cap examples at 4.

Output exactly 7 reskinned questions as a numbered list (1 through 7), same order, each on its own single line. Plain text only. No preamble, no explanations, no sub-bullets.

1) ...
2) ...
...
7) ...`;
}

/**
 * Generate the AI-reskinned question wording for slots 2–8 in one streamed call.
 * Returns an updated draft with `questions` populated, plus the exact prompt
 * sent (for the editable "Sent to AI" pane). On failure returns a
 * `retryable` result so the caller's failure ladder can retry once.
 *
 * Zero lore chunks is deterministic (retrying cannot succeed) → returns
 * `{ ok: false, reason: 'no-lore', retryable: false }` before any call.
 */
export async function generateInterviewQuestions(
    provider: EndpointConfig | ProviderConfig,
    loreChunks: LoreChunk[],
    baseDraft: CharacterCreationDraft,
    opts?: StreamOpts,
): Promise<GenerationResult> {
    // No-lore guard: nothing world-building to build from (character-only lore
    // counts as none). Deterministic — retrying cannot succeed.
    if (listCreationHeaders(loreChunks).length === 0) {
        return { ok: false, reason: 'no-lore', retryable: false };
    }

    // Stage 0 — header pre-pass: let the AI pick the most relevant sections,
    // then pack them breadth-first. Falls back to the category-filter excerpt
    // if the pick fails or returns nothing (never dead-ends).
    let excerpt: string;
    const picked = await selectRelevantLoreHeaders(provider, loreChunks, opts);
    if (picked.chunks.length > 0) {
        excerpt = packSelectedChunks(picked.chunks, creationExcerptBudget(opts?.maxContextTokens)).excerpt;
    } else {
        excerpt = buildGuidedCreationLoreExcerpt(loreChunks, opts?.maxContextTokens).excerpt;
    }
    if (!excerpt) return { ok: false, reason: 'no-lore', retryable: false };

    return runQuestionPrompt(provider, buildQuestionsPrompt(excerpt), baseDraft, opts);
}

/**
 * Run an arbitrary question prompt (used by both the first generation and the
 * "edit prompt → re-run" path in the wizard). Streams, parses, folds into the
 * draft. Kept separate from `generateInterviewQuestions` so the editable
 * re-run can pass a user-modified prompt without rebuilding the lore excerpt.
 */
export async function runQuestionPrompt(
    provider: EndpointConfig | ProviderConfig,
    prompt: string,
    baseDraft: CharacterCreationDraft,
    opts?: StreamOpts,
): Promise<GenerationResult> {
    let raw: string;
    try {
        raw = await streamGuidedCall(provider, prompt, {
            temperature: 0.6,
            signal: opts?.signal,
            trackingLabel: 'Guided-Creation-Questions',
            stage: 'questions',
            onProgress: opts?.onProgress,
        });
    } catch (err) {
        console.warn('[Guided Creation] Question call failed:', err);
        return { ok: false, reason: 'call-failed', retryable: true };
    }

    const parsed = parseInterviewLines(raw, AI_SLOTS.length, AI_SLOTS[0]);
    if (!parsed.ok) {
        console.warn('[Guided Creation] Question parse failed:', parsed.error, parsed.detail);
        return { ok: false, reason: 'unparseable', retryable: true };
    }

    const questions = linesToSlotMap(parsed.lines, AI_SLOTS[0]);
    const draft: CharacterCreationDraft = {
        ...baseDraft,
        questions: {
            1: STOCK_QUESTIONS[1],
            9: STOCK_QUESTIONS[9],
            ...(baseDraft.questions ?? {}),
            ...questions,
        },
        answers: baseDraft.answers ?? {},
    };

    return { ok: true, draft, sentPrompt: prompt };
}

// ── AI decides — the player fills what they know, the AI chooses the rest from the lore ──

/** Every slot the player can answer or hand to the AI. Hex and traits are not slots (§0). */
export const ROLLABLE_SLOTS: CreationSlot[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * Engine-owned format hints. Slots 4 and 8 are split on commas at commit, so a
 * rolled answer has to arrive in that shape to land as abilities / inventory.
 */
const ROLL_HINTS: Partial<Record<CreationSlot, string>> = {
    1: 'Give only the name.',
    4: 'Give a comma-separated list of short ability names.',
    8: 'Give a comma-separated list of short item names.',
    9: 'One description covering species, age, build, hair, eyes, clothing and any marks.',
};

export function getSlotValue(draft: CharacterCreationDraft, slot: CreationSlot): string {
    if (slot === 1) return draft.name ?? '';
    if (slot === 9) return draft.appearance ?? '';
    return draft.answers?.[slot] ?? '';
}

function writeSlot(draft: CharacterCreationDraft, slot: CreationSlot, value: string): CharacterCreationDraft {
    if (slot === 1) return { ...draft, name: value };
    if (slot === 9) return { ...draft, appearance: value };
    return { ...draft, answers: { ...draft.answers, [slot]: value } };
}

/** A player edit. Once they touch a rolled answer it is theirs, and a roll can no longer replace it. */
export function setPlayerSlotValue(draft: CharacterCreationDraft, slot: CreationSlot, value: string): CharacterCreationDraft {
    return {
        ...writeSlot(draft, slot, value),
        aiRolledSlots: (draft.aiRolledSlots ?? []).filter(s => s !== slot),
    };
}

export function blankSlots(draft: CharacterCreationDraft): CreationSlot[] {
    return ROLLABLE_SLOTS.filter(slot => !getSlotValue(draft, slot).trim());
}

/** A slot can be rolled while it is blank or still holds an untouched AI answer. */
export function canRollSlot(draft: CharacterCreationDraft, slot: CreationSlot): boolean {
    return !getSlotValue(draft, slot).trim() || (draft.aiRolledSlots ?? []).includes(slot);
}

/**
 * Fold rolled answers into the current draft. The call takes a while and the
 * form stays editable, so a slot the player wrote in meanwhile is left alone.
 */
export function applyRolledAnswers(
    draft: CharacterCreationDraft,
    values: Partial<Record<CreationSlot, string>>,
): CharacterCreationDraft {
    let next = draft;
    const rolled = new Set(draft.aiRolledSlots ?? []);
    for (const slot of ROLLABLE_SLOTS) {
        const value = values[slot];
        if (!value || !canRollSlot(draft, slot)) continue;
        next = writeSlot(next, slot, value);
        rolled.add(slot);
    }
    return { ...next, aiRolledSlots: [...rolled] };
}

function buildRollPrompt(
    draft: CharacterCreationDraft,
    slots: CreationSlot[],
    loreExcerpt: string,
): string {
    const wording = (slot: CreationSlot) => draft.questions?.[slot] || STOCK_QUESTIONS[slot];
    const decided = ROLLABLE_SLOTS
        .filter(slot => !slots.includes(slot) && getSlotValue(draft, slot).trim())
        .map(slot => `- ${wording(slot)}\n  ${getSlotValue(draft, slot).trim()}`)
        .join('\n');
    const questionLines = slots
        .map((slot, i) => `${i + 1}) ${wording(slot)}${ROLL_HINTS[slot] ? ` ${ROLL_HINTS[slot]}` : ''}`)
        .join('\n');
    const previous = slots
        .map(slot => getSlotValue(draft, slot).trim())
        .filter(Boolean)
        .map(value => `- ${value}`)
        .join('\n');

    return `You are helping create a new player character for the world below. The player has settled some details and left the rest for you to decide. Use your own judgment and the lore to make each decision: choose what makes this character specific and interesting, and avoid the most obvious option.

[WORLD LORE]
${loreExcerpt}
[END LORE]

[THE PLAYER'S DETAILS — fixed. Everything you invent must fit these.]
${decided || '(none yet)'}
[END DETAILS]

${previous ? `
[ALREADY SUGGESTED — the player wants something different. Do not reuse these.]
${previous}
[END SUGGESTED]
` : ''}
[QUESTIONS TO ANSWER]
${questionLines}
[END QUESTIONS]

Rules:
- Every place, faction, class, or power you name must come from the lore. You may invent small personal details such as a family name or a keepsake.
- The character is a new person, not a named figure from the lore.
- Any examples inside a question are hints, not a limit.
- Answer in the character's facts, not as advice to the player. Keep each answer under 500 characters.

Output exactly ${slots.length} answers as a numbered list (1 through ${slots.length}), same order, each on its own single line. Plain text only. No preamble, no explanations, no sub-bullets.`;
}

/** Models sometimes bold or quote a line even when told not to. */
function cleanRolledAnswer(line: string): string {
    return line.replace(/\*\*/g, '').trim().replace(/^"(.*)"$/, '$1').trim();
}

export type RollResult =
    | { ok: true; values: Partial<Record<CreationSlot, string>> }
    | { ok: false; reason: 'no-lore' | 'call-failed' | 'unparseable' };

/**
 * Answer the given slots from the world's lore, around whatever the player has
 * already decided. Line N maps to the Nth requested slot by construction, so the
 * model still never sees or writes a field binding (§0). Hex and traits stay out.
 */
export async function rollCreationSlots(
    provider: EndpointConfig | ProviderConfig,
    draft: CharacterCreationDraft,
    slots: CreationSlot[],
    loreChunks: LoreChunk[],
    opts?: StreamOpts,
): Promise<RollResult> {
    const eligible = listCreationHeaders(loreChunks);
    if (eligible.length === 0) return { ok: false, reason: 'no-lore' };

    // Breadth-first across every section, locations included, because origin
    // answers need places. Costs no extra call, unlike the header pre-pass.
    const { excerpt } = packSelectedChunks(eligible, creationExcerptBudget(opts?.maxContextTokens));
    const prompt = buildRollPrompt(draft, slots, excerpt);

    let raw: string;
    try {
        raw = await streamGuidedCall(provider, prompt, {
            temperature: 0.9,
            signal: opts?.signal,
            trackingLabel: 'Guided-Creation-Roll',
            stage: 'roll',
            onProgress: opts?.onProgress,
        });
    } catch (err) {
        console.warn('[Guided Creation] Roll call failed:', err);
        return { ok: false, reason: 'call-failed' };
    }

    const parsed = parseInterviewLines(raw, slots.length, 1);
    if (!parsed.ok) {
        console.warn('[Guided Creation] Roll parse failed:', parsed.error, parsed.detail);
        return { ok: false, reason: 'unparseable' };
    }

    const values: Partial<Record<CreationSlot, string>> = {};
    slots.forEach((slot, i) => {
        const value = cleanRolledAnswer(parsed.lines[i]);
        if (value) values[slot] = value;
    });
    return { ok: true, values };
}

// ── §2.7 — Conversion + clarifying questions ────────────────────────────────

export type ConversionResult =
    | { ok: true; convertedAnswers: Partial<Record<CreationSlot, string>>; clarifyingQuestions: string[] }
    | { ok: false; reason: 'call-failed' | 'unparseable'; retryable: boolean };

/**
 * Send the batched free-text answers (slots 2–8). Do NOT send hex or traits
 * (§0 invariant). Returns polished prose field values plus at most 3 clarifying
 * questions on genuinely ambiguous answers. Streamed (no token cap).
 */
export async function convertInterviewAnswers(
    provider: EndpointConfig | ProviderConfig,
    draft: CharacterCreationDraft,
    loreChunks: import('../../types').LoreChunk[],
    opts?: StreamOpts,
): Promise<ConversionResult> {
    const answers = draft.answers ?? {};
    const slots: CreationSlot[] = [2, 3, 4, 5, 6, 7, 8];
    const answerLines = slots
        .map(s => `Slot ${s}: ${answers[s] ?? '(unanswered)'}`)
        .join('\n');

    const { excerpt } = buildGuidedCreationLoreExcerpt(loreChunks, opts?.maxContextTokens);

    const prompt = `You are converting a player's interview answers into clean prose for their character sheet. The world lore is below for context.

[WORLD LORE]
${excerpt || '(no lore available)'}
[END LORE]

[PLAYER ANSWERS]
${answerLines}
[END ANSWERS]

Output a JSON object with two fields:
{
  "converted": { "2": "...", "3": "...", "4": "...", "5": "...", "6": "...", "7": "...", "8": "..." },
  "clarifying": [ "at most 3 short questions on genuinely ambiguous answers", ... ]
}

Rules:
- "converted" maps each slot number (as a string key) to a clean, world-consistent prose version of the player's answer for that slot. Polish grammar and phrasing; do not invent facts the player did not provide.
- "clarifying" is at most 3 questions, ONLY for answers that are genuinely too vague to convert. Empty array if everything is clear enough.
- NEVER include "personalityHex", "traits", or any field other than the slot numbers above. The engine owns those.
- Output ONLY the JSON object. No markdown fences, no commentary.`;

    let raw: string;
    try {
        raw = await streamGuidedCall(provider, prompt, {
            temperature: 0.3,
            signal: opts?.signal,
            trackingLabel: 'Guided-Creation-Convert',
            stage: 'convert',
            onProgress: opts?.onProgress,
        });
    } catch (err) {
        console.warn('[Guided Creation] Conversion call failed:', err);
        return { ok: false, reason: 'call-failed', retryable: true };
    }

    try {
        const cleaned = extractJsonObject(raw);
        const parsed = JSON.parse(cleaned);
        const converted = (parsed?.converted ?? {}) as Record<string, string>;
        const clarifyingRaw = (parsed?.clarifying ?? []) as unknown;
        const clarifyingQuestions = Array.isArray(clarifyingRaw)
            ? clarifyingRaw.map((q: unknown) => String(q)).filter(Boolean).slice(0, 3)
            : [];

        const convertedAnswers: Partial<Record<CreationSlot, string>> = {};
        for (const slot of slots) {
            const v = converted[String(slot)];
            if (typeof v === 'string' && v.trim()) {
                convertedAnswers[slot] = clampProse(v.trim(), 900);
            }
        }

        const clampedClarifying = clarifyingQuestions.map(q => clampProse(q, 240)).slice(0, 3);
        return { ok: true, convertedAnswers, clarifyingQuestions: clampedClarifying };
    } catch (err) {
        console.warn('[Guided Creation] Conversion parse failed:', err);
        return { ok: false, reason: 'unparseable', retryable: true };
    }
}

function clampProse(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max).trim();
}

function extractJsonObject(raw: string): string {
    const fenceStripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const start = fenceStripped.indexOf('{');
    const end = fenceStripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return fenceStripped;
    return fenceStripped.slice(start, end + 1);
}
