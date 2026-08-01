// Director Brief (WO-04) — one blocking LLM call on pro/max that audits the last
// turn and issues a short Writer Brief to the GM for the next turn.
//
// Graceful on timeout/cancel/parse-failure/any error: returns null and the turn
// continues without a Brief (the watchdog nudge still fires per WO-03 §3, since
// `buildPayload` only suppresses the nudge when a Brief string is actually passed).
//
// Computed once per user input: a module-level cache keyed `(campaignId, userMessage)`.
// A swipe/regenerate with the same user input reuses the cached Brief. The cache is
// cleared on campaign switch (invariant 7). Per WO-04 §4: even if verification shows
// swipes reuse `cachedPayload` and never re-enter this path, we keep the cache anyway
// (cheap insurance — see `pendingCommit.ts:capturePendingTurnSnapshot`).
//
// Provider resolution (WO-04 §2): auxiliary endpoint if the preset resolves one,
// else story endpoint. Mirrors the getter-fallback pattern in
// `turnOrchestrator.ts:197` (`getActiveAuxiliaryEndpoint() ?? provider`) and
// `pendingCommit.ts:249-252` (`getFreshAuxiliaryProvider`). The available getters
// on the store are: `getActiveStoryEndpoint`, `getActiveUtilityEndpoint`,
// `getActiveAuxiliaryEndpoint` (see `store/slices/settingsSlice.ts:180-213`).

import type { ChatMessage, NPCEntry, TimelineEvent, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall, UtilityTimeoutError } from '../../utils/llmCall';
import { countTokens } from '../infrastructure/tokenizer';

// AI_CALL_TIMEOUT_MS is the codebase's standard 120 s utility-call budget; the
// Director reuses it (DIRECTOR_BRIEF_TIMEOUT_MS below aliases 120_000). Not
// imported as a value — kept as a comment so the equivalence is discoverable.

// ── Tunables ────────────────────────────────────────────────────────────────

// 120 s per spec — same budget as AI_CALL_TIMEOUT_MS for other tracked utility
// calls (importance rating, profile scan). The user can EXTEND via the strip if
// their local model is slow.
const DIRECTOR_BRIEF_TIMEOUT_MS = 180_000;
const TRACKING_LABEL = 'director-brief';

// npcSummary token cap (spec §6: ~120 tokens). countTokens is the codebase's
// js-tiktoken counter — used here only for the cap, not for the prompt budget.
const NPC_SUMMARY_TOKEN_CAP = 120;
const RECENT_EVENTS_COUNT = 5;

// ── Once-per-input cache ────────────────────────────────────────────────────
// Module-level, keyed `(campaignId, userMessage)`. A swipe/regenerate with the
// same user input reuses the cached Brief — the Director's audit of the prior
// turn + this user input does not change between swipes. Cleared on campaign
// switch (invariant 7) — `clearDirectorBriefCache` is called from
// `setActiveCampaign` (wired in WO-04 alongside this module).
//
// We also clear lazily inside `runDirectorBrief` when the campaignId changes:
// the cache holds at most one entry per campaign switch, so the memory footprint
// is bounded. The explicit clear-on-switch is defensive (covers the case where
// `runDirectorBrief` is not called for the new campaign before the next switch).

interface CacheEntry {
    campaignId: string;
    userMessage: string;
    brief: string | null;
}

let cache: CacheEntry | null = null;

/** Clear the once-per-input Director Brief cache.
 *  Called on campaign switch (invariant 7) and exposed for tests. */
export function clearDirectorBriefCache(): void {
    cache = null;
}

/** Test-only: inspect the cache entry. Returns undefined when no entry is cached. */
export function peekDirectorBriefCache(): CacheEntry | null {
    return cache;
}

// ── NPC summary + recent events (spec §6) ───────────────────────────────────

/**
 * Build a compact NPC summary (name, role/relation one-liner, current goal) from
 * the ledger, capped at ~120 tokens. On-stage NPCs are surfaced first (the
 * Director's triage is most relevant for NPCs the player will see this turn);
 * the rest of the ledger fills the remaining budget.
 *
 * The "role/relation one-liner" is assembled from the existing NPCEntry text
 * fields (`disposition`, `faction`, `storyRelevance`) plus the pcRelation band.
 * We don't synthesize prose — the Director LLM gets the raw nouns and writes its
 * own directives.
 */
export function buildNpcSummary(
    npcLedger: NPCEntry[],
    onStageNpcIds: string[] | undefined,
    tokenCap: number = NPC_SUMMARY_TOKEN_CAP,
): string {
    if (npcLedger.length === 0) return '(no NPCs in ledger)';
    const onStageSet = new Set(onStageNpcIds ?? []);
    const onStage = npcLedger.filter(n => onStageSet.has(n.id) && !n.archived);
    const offStage = npcLedger.filter(n => !onStageSet.has(n.id) && !n.archived);
    const ordered = [...onStage, ...offStage];

    const lines: string[] = [];
    let used = 0;
    for (const npc of ordered) {
        const line = formatNpcLine(npc);
        // Per-line token estimate. countTokens is accurate but we cap the whole
        // summary, so a cheap heuristic on the joined string would also work —
        // using the real counter keeps the cap honest.
        const lineTokens = countTokens(line);
        if (used + lineTokens > tokenCap) break;
        lines.push(line);
        used += lineTokens;
    }
    return lines.length === 0 ? '(NPC ledger present but no on-stage NPCs fit the budget)' : lines.join('\n');
}

/** Format one NPC as a single compact line for the Director prompt. */
function formatNpcLine(npc: NPCEntry): string {
    const parts: string[] = [npc.name];
    if (npc.disposition) parts.push(npc.disposition);
    if (npc.faction) parts.push(`faction: ${npc.faction}`);
    if (npc.storyRelevance) parts.push(npc.storyRelevance);
    const rel = resolvePcRelationBand(npc);
    if (rel) parts.push(`PC relation: ${rel}`);
    const goal = pickActiveGoalText(npc);
    if (goal) parts.push(`goal: ${goal}`);
    return `- ${parts.join('; ')}`;
}

/** Map pcRelation (-3..+3) to a one-word band for the Director; fall back to affinity. */
function resolvePcRelationBand(npc: NPCEntry): string | null {
    const r = typeof npc.pcRelation === 'number' && Number.isFinite(npc.pcRelation)
        ? npc.pcRelation
        : affinityToBand(npc.affinity);
    if (r === null) return null;
    if (r <= -3) return 'hostile';
    if (r <= -2) return 'cool';
    if (r <= -1) return 'wary';
    if (r === 0) return 'neutral';
    if (r === 1) return 'friendly';
    if (r === 2) return 'close';
    return 'devoted';
}

function affinityToBand(affinity: number | undefined): number | null {
    if (typeof affinity !== 'number' || !Number.isFinite(affinity)) return null;
    if (affinity <= 15) return -3;
    if (affinity <= 30) return -2;
    if (affinity <= 45) return -1;
    if (affinity <= 55) return 0;
    if (affinity <= 70) return 1;
    if (affinity <= 85) return 2;
    return 3;
}

/** Pick the highest-priority active goal text for the NPC (med before long; first before rest). */
function pickActiveGoalText(npc: NPCEntry): string | null {
    const goals = npc.goalRecords;
    if (!goals || goals.length === 0) return null;
    const active = goals.filter(g => g.state === 'active');
    if (active.length === 0) return null;
    const med = active.find(g => g.horizon === 'med');
    return (med ?? active[0]).text;
}

/**
 * Build a compact "recent events" block from the last ~5 timeline events.
 * The Director uses these for friction/callbacks and twist-check (steps 4 & 6
 * of the prompt). Returns `'(no recent timeline events)'` when the timeline is
 * empty — the Director prompt still runs, just with an empty events slot.
 */
export function buildRecentEvents(
    timeline: TimelineEvent[] | undefined,
    count: number = RECENT_EVENTS_COUNT,
): string {
    if (!timeline || timeline.length === 0) return '(no recent timeline events)';
    const recent = timeline.slice(-count);
    return recent
        .map(e => `- [${e.sceneId}] ${e.subject} ${e.predicate} ${e.object}: ${e.summary}`)
        .join('\n');
}

// ── Prompt assembly (FABLE-AUTHORED, verbatim) ──────────────────────────────

const DIRECTOR_PROMPT_TEMPLATE = `You are the Continuity Director of an ongoing role-played campaign. You do not write prose or manufacture drama. You audit the last turn and issue a short brief only when the GM needs a hard-world correction or a compatible NPC-agency repair for the next turn.

VERIFIED FACTS (do not re-derive; act on them):
<watchdog_dossier>
{dossierText}
</watchdog_dossier>
<previous_gm_turn>
{lastAssistant}
</previous_gm_turn>
<player_input>
{userMessage}
</player_input>
<active_npcs>
{npcSummary}
</active_npcs>
<recent_events>
{recentEvents}
</recent_events>

Use the supplied context as your complete evidence. Do not invent canon, unseen actions, private knowledge, motives, injuries, or social harm. Do not turn a clever, lawful, or tactically sound player action into a moral failing merely to create friction.

Consider, in order:
1. World-law and continuity - does the last GM turn or the player's intended action contradict an established rule, capability, location, prior event, knowledge boundary, or physical consequence? Flag only a contradiction demonstrated by the supplied context. A valid but risky action is not a violation; narrate its real limits or consequences rather than denying it outright.
2. Fair adjudication - did the prior GM response make an NPC naive, omniscient, or able to counter without the knowledge, time, or capability established here? Correct that specific error. In deception or tactical scenes, a target may notice, test, hedge, or counter only from observable cues and their established ability; a successful feint may earn a real opening.
3. Watchdog triage - use the dossier as an agency obligation, not a licence to force conflict. Repair a silent NPC, one-directional relationship, or stalled goal only when the repair fits the scene and does not contradict steps 1-2. Defer it when no truthful opening exists.
4. Restraint - do not schedule disagreement, decentering, callbacks, staleness changes, twists, or emotional escalation. The Writer handles character reactions and scene momentum. If there is no evidenced correction or compatible agency repair, proceed naturally.

OUTPUT exactly this, nothing else:
WRITER BRIEF
- [MANDATORY] <directive>   (0-2 lines)
- [SUGGESTION] <directive>  (0-3 lines)
Use [MANDATORY] only for a demonstrated world-law, continuity, knowledge, or fair-adjudication correction. Use [SUGGESTION] only for one compatible watchdog repair. Each directive is one imperative line naming specific characters. No analysis, no preamble. If nothing is needed, output "WRITER BRIEF" followed by "- [SUGGESTION] Proceed naturally."`;

/** Render the verbatim Director prompt with the slot values inlined. */
export function renderDirectorPrompt(input: {
    dossierText: string;
    lastAssistant: string;
    userMessage: string;
    npcSummary: string;
    recentEvents: string;
}): string {
    return DIRECTOR_PROMPT_TEMPLATE
        .replace('{dossierText}', input.dossierText)
        .replace('{lastAssistant}', input.lastAssistant)
        .replace('{userMessage}', input.userMessage)
        .replace('{npcSummary}', input.npcSummary)
        .replace('{recentEvents}', input.recentEvents);
}

// ── Output parsing ──────────────────────────────────────────────────────────

/**
 * Parse the Director's `WRITER BRIEF` output. Tolerant: strips <think> tags,
 * trims, and accepts any text that contains the `WRITER BRIEF` header. Returns
 * null on parse failure (the caller returns null to the turn, which falls back
 * to the watchdog nudge per `buildPayload`'s supersession gate).
 */
export function parseDirectorBrief(raw: string): string | null {
    if (!raw) return null;
    const cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
    if (!cleaned) return null;
    // The spec mandates the output starts with `WRITER BRIEF`. We accept it
    // anywhere in the cleaned text — some local models prepend a stray newline
    // or a "Here is..." preamble that the <think> strip didn't catch. The
    // important invariant is that the BRIEF block reaches the GM verbatim.
    const idx = cleaned.search(/WRITER BRIEF/i);
    if (idx === -1) return null;
    return cleaned.slice(idx).trim();
}

// ── Tokenizer ───────────────────────────────────────────────────────────────
// countTokens is the codebase's js-tiktoken counter (cl100k_base). Used only
// for the npcSummary cap — the Director prompt itself is not budgeted (the
// dossier + last turn + user input are already bounded by the turn's payload
// budget upstream).

// ── Provider resolution ─────────────────────────────────────────────────────

/**
 * Resolve the provider for the Director call (WO-04 §2): auxiliary endpoint if
 * the preset resolves one, else the story endpoint. Mirrors
 * `turnOrchestrator.ts:197` and `pendingCommit.ts:249-252`.
 *
 * WO-04b §2: the auxiliary resolver is called even when `storyProvider` is
 * undefined — a preset with only an auxiliary endpoint (no story endpoint)
 * still runs the Director. If the resolver itself throws, `runDirectorBrief`
 * catches it (this function does not catch — it is a pure resolver; the caller
 * owns the failure-total boundary).
 */
export function resolveDirectorProvider(
    storyProvider: EndpointConfig | ProviderConfig | undefined,
    getAuxiliary?: () => EndpointConfig | undefined,
): EndpointConfig | ProviderConfig | undefined {
    // Call the auxiliary resolver unconditionally. A preset with only an
    // auxiliary endpoint (no story endpoint) still resolves a Director provider.
    const aux = getAuxiliary?.();
    if (aux?.modelName) return aux;
    return storyProvider;
}

// ── Public entry point ──────────────────────────────────────────────────────

export interface DirectorBriefInput {
    /** Story endpoint (the orchestrator's resolved provider). Required. */
    provider: EndpointConfig | ProviderConfig | undefined;
    /** Watchdog dossier text from `buildWatchdogDossier(...).dossierText`. */
    dossierText: string;
    /** The last assistant message content (the GM turn being audited). */
    lastAssistant: string;
    /** The user's input for the upcoming turn. */
    userMessage: string;
    /** NPC ledger from `state.npcLedger`. */
    npcLedger: NPCEntry[];
    /** On-stage NPC ids from `state.onStageNpcIds`. */
    onStageNpcIds?: string[];
    /** Timeline events from `state.timeline`. */
    timeline?: TimelineEvent[];
    /** Campaign id for the once-per-input cache key. */
    campaignId: string | null;
    /** Auxiliary-endpoint resolver (mirrors `getFreshAuxiliaryProvider`). */
    getAuxiliaryProvider?: () => EndpointConfig | undefined;
    /** Optional abort signal from the turn's AbortController. */
    signal?: AbortSignal;
    /** Facade-brokered model call used by the production turn path. */
    modelCall?: (prompt: string, options: {
        signal?: AbortSignal;
        priority: 'low';
        trackingLabel: string;
        timeoutMs: number;
    }) => Promise<string>;
}

/**
 * Run the Director: one blocking LLM call that produces a Writer Brief for the
 * GM. Returns `null` on timeout/abort/parse-failure/any error — the turn
 * continues without a Brief in those cases (the watchdog nudge still fires).
 *
 * WO-04b §1 / WO-04c §1: the graceful-failure boundary covers provider
 * resolution, NPC summary construction, recent-event construction, prompt
 * rendering, the LLM call, AND parsing. Any exception from any of those
 * stages returns `null` and never escapes the service — the Director must
 * never fail the turn, including programmer-error paths in parsing. Preserves
 * the existing no-warning behavior for an explicitly aborted outer signal;
 * other errors may log once.
 *
 * Once-per-input: a second call with the same `(campaignId, userMessage)` returns
 * the cached result without re-invoking the LLM. The cache is cleared on
 * campaign switch (invariant 7) — call `clearDirectorBriefCache()` from the
 * campaign-switch path, or rely on the lazy clear when the campaignId changes.
 *
 * WO-04b §5 / WO-04c §3 cache contract: successful parses AND ordinary
 * parse-failure `null` results are cached; timeout, abort, no-provider, thrown
 * preflight failures, AND thrown parser exceptions are NOT cached (a swipe
 * retry on the same input may succeed once the throw is resolved).
 */
export async function runDirectorBrief(input: DirectorBriefInput): Promise<string | null> {
    // Cache check (once-per-input). Lazily clear when the campaignId changes.
    // Pure reads — cannot throw, so they sit outside the failure-total boundary.
    if (cache && cache.campaignId === input.campaignId && cache.userMessage === input.userMessage) {
        return cache.brief;
    }
    if (cache && cache.campaignId !== input.campaignId) {
        cache = null;
    }

    // Failure-total boundary (WO-04b §1, WO-04c): every stage that can throw —
    // provider resolution (including a throwing getAuxiliaryProvider), NPC
    // summary construction, recent-event construction, prompt rendering, the
    // LLM call, AND parsing — lives inside this try/catch. Any exception
    // returns null and never escapes the service. The Director must never
    // fail the turn, including programmer-error paths in parsing.
    try {
        const provider = resolveDirectorProvider(input.provider, input.getAuxiliaryProvider);
        if (!provider && !input.modelCall) {
            // No provider resolved — fall back gracefully (no Brief, turn continues).
            // Not cached: a later call in the same turn (e.g. after the user picks a
            // preset) should retry.
            return null;
        }

        const npcSummary = buildNpcSummary(input.npcLedger, input.onStageNpcIds);
        const recentEvents = buildRecentEvents(input.timeline);
        const prompt = renderDirectorPrompt({
            dossierText: input.dossierText,
            lastAssistant: input.lastAssistant,
            userMessage: input.userMessage,
            npcSummary,
            recentEvents,
        });

        const raw = input.modelCall
            ? await input.modelCall(prompt, {
                signal: input.signal,
                priority: 'low',
                trackingLabel: TRACKING_LABEL,
                timeoutMs: DIRECTOR_BRIEF_TIMEOUT_MS,
            })
            : await llmCall(provider!, prompt, {
                signal: input.signal,
                priority: 'low',
                // WO-04b §3: no thinkingEffort option — let llmCall inherit the
                // chosen endpoint's configured `thinkingEffort` (llmCall.ts:95).
                trackingLabel: TRACKING_LABEL,
                timeoutMs: DIRECTOR_BRIEF_TIMEOUT_MS,
            });

        // Parsing rides inside the same try/catch (WO-04c §1): a thrown parser
        // exception enters the catch below, logs once (unless the outer signal
        // was explicitly aborted), returns null, and leaves the cache empty.
        const brief = parseDirectorBrief(raw);
        // WO-04b §5 / WO-04c §3: cache success AND ordinary parse-failure (the
        // `brief === null` case where the LLM returned a string with no
        // `WRITER BRIEF` header). A thrown parser exception bypasses this
        // cache write via the catch — programmer-error throws are not cached
        // (a retry on the same input would hit the same throw, but the spec
        // explicitly excludes thrown parser exceptions from the cache).
        cache = {
            campaignId: input.campaignId ?? '',
            userMessage: input.userMessage,
            brief,
        };
        return brief;
    } catch (err) {
        // Timeout (UtilityTimeoutError), abort, throwing getAuxiliaryProvider,
        // throwing preflight (npcSummary / recentEvents / render), any error
        // from llmCall itself, OR a thrown parser exception (WO-04c §2): log
        // and return null. Never throw into the turn.
        if (err instanceof UtilityTimeoutError) {
            console.warn(`[DirectorBrief] timeout: ${err.message}`);
        } else if (input.signal?.aborted) {
            // User abort — no warning, this is expected.
        } else {
            console.warn('[DirectorBrief] failed:', err);
        }
        // WO-04b §5 / WO-04c §2: do NOT cache on timeout/abort/preflight-throw/
        // parser-throw. A swipe retry might succeed (user EXTEND, faster model,
        // fixed preset, fixed parser bug).
        return null;
    }
}

// ── Helpers re-exported for the call site ────────────────────────────────────

/** Extract the last assistant message content from the message window. */
export function lastAssistantContent(messages: ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && m.content) return m.content;
    }
    return '';
}

// Re-export the timeout constant for tests / orchestrator status display.
export { DIRECTOR_BRIEF_TIMEOUT_MS };