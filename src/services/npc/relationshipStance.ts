import type {
    AiTier,
    EndpointConfig,
    NPCEntry,
    PlayerCharacter,
    ProviderConfig,
    RelationshipMemoryFault,
    RelationshipMemoryMood,
    RelationshipMemoryRecord,
    RelationshipStance,
    RelationshipStanceRecord,
    RelationshipStanceSlots,
} from '../../types';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import {
    clashes,
    injectionScore,
    selectTiers,
    type RelationshipMemoryReadingContext,
} from './relationshipMemoryReading';
import { compactRelationshipMemoryEdge } from './relationshipMemoryCompaction';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';

/** The exact WO-3.5 prompt. Only the named input substitutions are made.
 *  WO-3.5: de-gendered (every NPC is no longer assumed "she" and every target "him"),
 *  and the verbatim rule moved — the model now returns scene ids and the engine
 *  renders the canonical line, so exactness is guaranteed by construction. */
export const RELATIONSHIP_STANCE_PROMPT = `You are working out what one person is feeling and wanting at this exact moment
of an ongoing story. You are NOT writing the scene — someone else writes the
scene. Your only job is to decide what is TRUE inside {name} and hand it over.

[WHO THEY ARE]
{name} — {statuses}
{name} will not, under any circumstance: {non-negotiables}

[EVERY MOMENT {name} REMEMBERS OF {target}]
{full history — one line each, weight already stamped. Do not re-rank it.}

[CONTRADICTIONS FOUND IN THAT HISTORY]
{clash pairs}

[HOW {name} HAS ACTUALLY BEHAVED TOWARD {target}]
{the recorded outcomes, aggregated}

[THE ROOM, RIGHT NOW]
{current scene context}

Work in this order:

1. Read the room. What kind of moment is this, and what did {target} just
   CHOOSE to do? The room decides which memories are live — nothing else.

2. Pick ONE contradiction that this room activates. Not the strongest, not the
   most recent — the one this specific moment presses on. Name the ones you
   rejected, one clause each. If the room presses on none of them, say so; a
   quiet scene is allowed to be quiet.

3. What does {name} want from THIS moment — not from {target} in general, not
   from their life. From the next five minutes. Specific enough that it implies
   behaviour.

4. What are they concealing. What will they refuse. What do they believe about
   {target} that may simply be wrong.

5. Their manner comes from how they have ACTUALLY behaved toward {target} above
   — not from a personality label. Then: how far does this room push them past
   that baseline, measured against the worst and best moments in their own
   history? Say WHERE THEY LAND. Do not decide whether they "break character" —
   that is not a question with an answer. Far enough simply is the break.

RULES — these are what make the output usable:

- NEVER CONCLUDE. "They are conflicted: resentful but still attached" is a
  failure. It compresses everything back into one feeling and destroys the
  reason you were asked. Hold both halves open. Let them stay uncomfortable.
- Cite the contradicting memories by their scene number ONLY — "#123". Do not
  retype them, do not paraphrase them, do not explain them. The exact wording
  is added back for you.
- {name} is not omniscient about {target}. Anything they believe about
  {target}'s motives is a belief, marked as one, and allowed to be wrong.
- They never name their own contradiction aloud. It shows in what they do.

Return JSON only:
{"wants_now":"", "hiding":"", "wont":"", "in_tension":["#123","#298"],
 "believes":"", "manner":"", "strain":"", "considered":[""],
 "read_room_as":""}`;

export const CHEAP_TIER_RECORD_LIMIT = 5;

/** WO-2's tier budget, kept here because WO-3 owns the scene-stable read. */
export const RELATIONSHIP_STANCE_DEEP_BUDGET: Record<AiTier, number> = {
    lite: 0,
    pro: 2,
    max: 3,
};

export type RelationshipStanceModelCall = (request: ModelRequest) => Promise<ModelResponse>;

export type RelationshipStanceInput = {
    campaignId?: string | null;
    enabled?: boolean;
    aiTier?: AiTier;
    npcs: readonly NPCEntry[];
    onStageNpcIds: readonly string[];
    relationshipMemoriesNpcToMc: readonly RelationshipMemoryRecord[];
    playerCharacter?: PlayerCharacter | null;
    sceneId: string;
    sceneKey: string;
    sceneMood: RelationshipMemoryMood;
    sceneContext: string;
    modelCall?: RelationshipStanceModelCall;
    provider?: EndpointConfig | ProviderConfig;
    signal?: AbortSignal;
    /** WO-3.5 Fix D: invoked for every silent stance failure so it can be surfaced in the
     *  tuning panel instead of vanishing into console.warn. Non-blocking; never retried. */
    onFault?: (fault: RelationshipMemoryFault) => void;
};

type RawStance = {
    wants_now?: unknown;
    hiding?: unknown;
    wont?: unknown;
    in_tension?: unknown;
    believes?: unknown;
    manner?: unknown;
    strain?: unknown;
    considered?: unknown;
    read_room_as?: unknown;
};

const stanceCache = new Map<string, Promise<RelationshipStance[]>>();

export function clearRelationshipStanceCache(): void {
    stanceCache.clear();
}

function sceneNumber(sceneId: string): number {
    const parsed = Number.parseInt(sceneId, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatScore(score: number): string {
    return Number.isFinite(score) ? score.toFixed(2) : '∞';
}

/** The line is shared by prompt assembly and panel rendering so clash records remain verbatim.
 *  When `event` is present (new records), render `#NNN event — outcome [mood, impact; weight]`.
 *  When `event` is absent (legacy records), render outcome-only — no dangling separator. */
export function formatRelationshipStanceRecord(
    record: RelationshipMemoryRecord,
    score: number,
): string {
    const citation = record.source === 'era' ? (record.eraId ?? record.sceneId) : record.sceneId;
    const core = record.event
        ? `${record.event} — ${record.outcome}`
        : record.outcome;
    return `#${citation} ${core} [${record.mood}, ${record.impact}; weight ${formatScore(score)}]`;
}

function formatWeightedRecord(
    record: RelationshipMemoryRecord,
    score: number,
): RelationshipStanceRecord {
    return {
        ...record,
        injectionScore: score,
        line: formatRelationshipStanceRecord(record, score),
    };
}

function statusText(npc: NPCEntry): string {
    return [
        npc.status,
        npc.condition ? `condition: ${npc.condition}` : '',
        npc.disposition ? `disposition: ${npc.disposition}` : '',
        npc.shiftNote ? `shift: ${npc.shiftNote}` : '',
    ].filter(Boolean).join('; ') || 'no status recorded';
}

function nonNegotiablesText(npc: NPCEntry): string {
    return npc.hardBoundaries?.filter(Boolean).join('; ') || 'none recorded';
}

function recordsForNpc(
    input: RelationshipStanceInput,
    npcId: string,
): RelationshipMemoryRecord[] {
    const edge = input.relationshipMemoriesNpcToMc.filter(record =>
        record.subject === npcId && record.target === 'MC'
    );
    return compactRelationshipMemoryEdge(edge).records;
}

function readingContext(input: RelationshipStanceInput): RelationshipMemoryReadingContext {
    return {
        currentScene: input.sceneId,
        sceneMood: input.sceneMood,
        presentParticipants: [
            ...input.onStageNpcIds,
            input.playerCharacter?.name ?? 'MC',
        ],
    };
}

function weightedRecords(
    records: readonly RelationshipMemoryRecord[],
    context: RelationshipMemoryReadingContext,
): RelationshipStanceRecord[] {
    return records.map(record => formatWeightedRecord(record, injectionScore(record, context)));
}

function clashLines(
    records: readonly RelationshipMemoryRecord[],
    context: RelationshipMemoryReadingContext,
): string[] {
    const scoreByRecord = new Map(
        records.map(record => [record, injectionScore(record, context)] as const)
    );
    return clashes(records, context).flatMap(([left, right]) => [
        formatRelationshipStanceRecord(left, scoreByRecord.get(left) ?? 0),
        formatRelationshipStanceRecord(right, scoreByRecord.get(right) ?? 0),
    ]);
}

export function buildRelationshipStancePrompt(
    npc: NPCEntry,
    target: string,
    records: readonly RelationshipMemoryRecord[],
    context: RelationshipMemoryReadingContext,
    sceneContext: string,
): {
    prompt: string;
    fullHistory: RelationshipStanceRecord[];
    topRecords: RelationshipStanceRecord[];
    clashLines: string[];
} {
    const all = weightedRecords(records, context);
    const topRecords = all
        .map((record, index) => ({ record, index }))
        .sort((a, b) => b.record.injectionScore - a.record.injectionScore || a.index - b.index)
        .slice(0, CHEAP_TIER_RECORD_LIMIT)
        .map(item => item.record);
    const history = all.map(record => record.line).join('\n');
    const clashesText = clashLines(records, context).join('\n');
    const outcomes = records.map(record => `- ${record.outcome}`).join('\n') || '- no recorded outcomes';
    // `replaceAll`, not `replace`: the de-gendered WO-3.5 prompt names {name} 7 times and
    // {target} 8, and a string-pattern `replace` fills only the first — which shipped a prompt
    // whose identity header read literally "{name} — imprisoned". Function replacements are
    // used so `$&`/`$1` appearing in scene text or a character name cannot be interpreted as a
    // substitution pattern. The residue assertion in the tests guards both.
    const prompt = RELATIONSHIP_STANCE_PROMPT
        .replaceAll('{name}', () => npc.name)
        .replaceAll('{statuses}', () => statusText(npc))
        .replaceAll('{non-negotiables}', () => nonNegotiablesText(npc))
        .replaceAll('{target}', () => target)
        .replaceAll('{full history — one line each, weight already stamped. Do not re-rank it.}', () => history || '- no recorded memories')
        .replaceAll('{clash pairs}', () => clashesText || 'none found')
        .replaceAll('{the recorded outcomes, aggregated}', () => outcomes)
        .replaceAll('{current scene context}', () => sceneContext);
    return {
        prompt,
        fullHistory: all,
        topRecords,
        clashLines: clashesText ? clashesText.split('\n') : [],
    };
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/** Normalise a model-returned citation. Accept numeric scene ids and synthetic era ids. */
function normaliseCitationId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/^#/, '').trim();
    if (/^era:/i.test(trimmed)) return trimmed;
    if (!/^\d+$/.test(trimmed)) return null;
    const numeric = Number.parseInt(trimmed, 10);
    return Number.isFinite(numeric) && numeric > 0 ? String(numeric) : null;
}

type StanceResolution = {
    stance: RelationshipStanceSlots | null;
    faults: RelationshipMemoryFault[];
};

function parseStance(
    raw: string,
    edgeRecords: readonly RelationshipMemoryRecord[],
    context: RelationshipMemoryReadingContext,
    sceneId: string,
): StanceResolution {
    const faults: RelationshipMemoryFault[] = [];
    const parsed = extractJsonRobust<RawStance>(raw, {});
    if (!parsed.parseOk) {
        return { stance: null, faults: [{ sceneId, message: 'stance dropped — malformed response' }] };
    }
    const value = asRecord(parsed.value);
    if (!value) {
        return { stance: null, faults: [{ sceneId, message: 'stance dropped — malformed response' }] };
    }

    const requiredStrings = [
        'wants_now', 'hiding', 'wont', 'believes', 'manner', 'strain', 'read_room_as',
    ];
    if (requiredStrings.some(key => typeof value[key] !== 'string')) {
        return { stance: null, faults: [{ sceneId, message: 'stance dropped — malformed response' }] };
    }
    // `in_tension` may be absent or empty — a quiet scene is valid. If present and not an
    // array of strings, that is malformed. `considered` is diagnostic, free text.
    if (value.in_tension !== undefined && (!Array.isArray(value.in_tension) || !value.in_tension.every(item => typeof item === 'string'))) {
        return { stance: null, faults: [{ sceneId, message: 'stance dropped — malformed response' }] };
    }
    if (!Array.isArray(value.considered) || !value.considered.every(item => typeof item === 'string')) {
        return { stance: null, faults: [{ sceneId, message: 'stance dropped — malformed response' }] };
    }

    // Resolve citations: the model returns scene ids; the engine renders the canonical line.
    const requested = Array.isArray(value.in_tension) ? (value.in_tension as string[]) : [];
    const recordByScene = new Map(edgeRecords.map(record => [
        record.source === 'era'
            ? (record.eraId ?? record.sceneId)
            : String(Number.parseInt(record.sceneId, 10)),
        record,
    ] as const));
    const resolvedLines: string[] = [];
    for (const citation of requested.slice(0, 2)) {
        const id = normaliseCitationId(citation);
        if (!id) {
            faults.push({ sceneId, message: `tension citation ${citation} not found on this edge` });
            continue;
        }
        const record = recordByScene.get(id);
        if (!record) {
            faults.push({ sceneId, message: `tension citation #${id} not found on this edge` });
            continue;
        }
        resolvedLines.push(formatRelationshipStanceRecord(record, injectionScore(record, context)));
    }

    return {
        stance: {
            wantsNow: value.wants_now as string,
            hiding: value.hiding as string,
            wont: value.wont as string,
            inTension: resolvedLines,
            believes: value.believes as string,
            manner: value.manner as string,
            strain: value.strain as string,
            considered: (value.considered as string[]).slice(0, 8),
            readRoomAs: value.read_room_as as string,
        },
        faults,
    };
}

function cacheKey(input: RelationshipStanceInput): string {
    return `${input.campaignId ?? 'no-campaign'}|${input.sceneKey}`;
}

function buildSceneStances(input: RelationshipStanceInput): Promise<RelationshipStance[]> {
    const activeIds = Array.from(new Set(input.onStageNpcIds));
    const activeNpcs = activeIds
        .map(id => input.npcs.find(npc => npc.id === id))
        .filter((npc): npc is NPCEntry => Boolean(npc && !npc.archived && !npc.isPC));
    const edges = activeNpcs.map(npc => recordsForNpc(input, npc.id));
    const tier = input.aiTier ?? 'pro';
    const deepBudget = RELATIONSHIP_STANCE_DEEP_BUDGET[tier];
    const selections = selectTiers(edges, deepBudget);
    const context = readingContext(input);
    const target = input.playerCharacter?.name || 'the player character';

    return Promise.all(activeNpcs.map(async (npc, index) => {
        const records = edges[index] ?? [];
        const selection = selections[index];
        const built = buildRelationshipStancePrompt(npc, target, records, context, input.sceneContext);
        const base: RelationshipStance = {
            npcId: npc.id,
            npcName: npc.name,
            targetName: target,
            sceneId: input.sceneId,
            sceneKey: input.sceneKey,
            statuses: statusText(npc),
            nonNegotiables: nonNegotiablesText(npc),
            tier: selection?.tier ?? 'cheap',
            tierScore: selection?.score ?? 0,
            clashCount: selection?.clashCount ?? 0,
            pinCount: selection?.pinCount ?? 0,
            forcedDeep: selection?.forcedDeep ?? false,
            topRecords: built.topRecords,
        };

        if (base.tier !== 'deep' || (!input.modelCall && !input.provider)) return base;

        const emitFault = (fault: RelationshipMemoryFault) => {
            console.warn(`[RelationshipStance] ${fault.message} for ${npc.name}`);
            input.onFault?.(fault);
        };

        try {
            const content = input.modelCall
                ? (await input.modelCall({
                    prompt: built.prompt,
                    signal: input.signal,
                    maxTokens: 800,
                    temperature: 0.1,
                    priority: 'low',
                    trackingLabel: 'npc-stance',
                    timeoutMs: AI_CALL_TIMEOUT_MS,
                })).content
                : await llmCall(input.provider!, built.prompt, {
                    signal: input.signal,
                    maxTokens: 800,
                    temperature: 0.1,
                    priority: 'low',
                    trackingLabel: 'npc-stance',
                    timeoutMs: AI_CALL_TIMEOUT_MS,
                });
            const { stance, faults } = parseStance(content, records, context, input.sceneId);
            for (const fault of faults) emitFault(fault);
            if (!stance) return base;
            return { ...base, stance };
        } catch (error) {
            console.warn(`[RelationshipStance] Stance failed for ${npc.name}:`, error);
            input.onFault?.({ sceneId: input.sceneId, message: 'stance dropped — call failed' });
            return base;
        }
    }));
}

/**
 * Computes all present NPC readings concurrently and caches the whole scene. A cached promise
 * prevents a second call while the first set is still in flight; failed NPCs remain absent from
 * the cached result for the rest of the scene, so failure isolation never becomes a retry loop.
 */
export function computeRelationshipStances(input: RelationshipStanceInput): Promise<RelationshipStance[]> {
    if (input.enabled === false || input.npcs.length === 0 || input.onStageNpcIds.length === 0) {
        return Promise.resolve([]);
    }
    const key = cacheKey(input);
    const existing = stanceCache.get(key);
    if (existing) return existing;
    const promise = buildSceneStances(input).catch(error => {
        console.warn('[RelationshipStance] Scene stance pass failed:', error);
        return [];
    });
    stanceCache.set(key, promise);
    return promise;
}

/**
 * Render the scene-stable stance below the prompt cache boundary. Cheap tiers deliberately carry
 * only the compact status/boundary/memory view; deep tiers add the model's actionable slots.
 * Memory lines are already canonicalised by `formatRelationshipStanceRecord` and must pass through
 * unchanged so the writer and the tuning panel cite the same text.
 */
export function renderRelationshipStanceBlock(stances: readonly RelationshipStance[]): string {
    if (stances.length === 0) return '';

    const rendered = stances.map((stance) => {
        const lines = [
            `STANCE — ${stance.npcName} · scene ${stance.sceneId} · ${stance.tier}`,
            `status: ${stance.statuses}`,
            `won't: ${stance.nonNegotiables}`,
            stance.topRecords.length > 0
                ? `memories:\n  ${stance.topRecords.map(record => record.line).join('\n  ')}`
                : 'memories: none recorded',
        ];
        if (stance.stance) {
            lines.push(
                `wants now: ${stance.stance.wantsNow}`,
                `hiding: ${stance.stance.hiding}`,
                `won't: ${stance.stance.wont}`,
                `in tension:\n  ${stance.stance.inTension.join('\n  ') || 'none'}`,
                `believes (may be wrong): ${stance.stance.believes}`,
                `manner: ${stance.stance.manner}`,
                `strain: ${stance.stance.strain}`,
                `read room as: ${stance.stance.readRoomAs}`,
            );
        }
        return lines.join('\n');
    });

    return `[NPC STANCES]\n${rendered.join('\n\n')}\n[END NPC STANCES]`;
}

/** Convenience adapter used by the turn gather stage. */
export function buildRelationshipStanceSceneContext(args: {
    finalInput: string;
    sceneNote?: string;
    currentPlace?: string;
    currentFeature?: string | null;
    recentMessages?: readonly { role: string; content: string }[];
}): string {
    const recent = (args.recentMessages ?? []).slice(-6)
        .map(message => `[${message.role.toUpperCase()}] ${message.content}`)
        .join('\n');
    return [
        `CURRENT CHOICE:\n${args.finalInput}`,
        args.currentPlace ? `CURRENT PLACE: ${args.currentPlace}${args.currentFeature ? ` (${args.currentFeature})` : ''}` : '',
        args.sceneNote ? `SCENE NOTE:\n${args.sceneNote}` : '',
        recent ? `RECENT EXCHANGE:\n${recent}` : '',
    ].filter(Boolean).join('\n\n');
}

export function sceneKeyForRelationshipStance(args: {
    onStageNpcIds: readonly string[];
    sceneNote?: string;
    currentPlaceId?: string | null;
    currentFeature?: string | null;
}): string {
    return JSON.stringify({
        onStageNpcIds: [...new Set(args.onStageNpcIds)].sort(),
        sceneNote: args.sceneNote ?? '',
        currentPlaceId: args.currentPlaceId ?? null,
        currentFeature: args.currentFeature ?? null,
    });
}

/** The scene number used for panel labels when no server-assigned scene exists yet. */
export function currentRelationshipSceneId(archiveSceneIds: readonly string[]): string {
    const latest = archiveSceneIds.reduce(
        (best, id) => sceneNumber(id) > sceneNumber(best) ? id : best,
        '000',
    );
    return String(sceneNumber(latest) + 1).padStart(3, '0');
}
