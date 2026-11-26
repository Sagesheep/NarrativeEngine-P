// Arc Engine — WO-03 spawn (arcSpawn.ts).
// This is the rewritten Trouble generator. The fork site was
// src/services/engine/troublemaker.ts::generateTroubleOptions. The Trouble engine's
// "CRITICAL LOCATION RULE" (a stranger walks up to the player at their current
// location) is DELETED and INVERTED: an arc seed is systemic + indirect — a
// standing condition in the world (economy/politics/factions/society) that worsens
// over time and only reaches the player through ambient/rumor surface tiers until
// its top rungs finally land in a scene.
//
// This is the ONLY +1 LLM call in the Arc Engine, and it fires seam-only (gated by
// arcWorldState ≠ 'live' AND active arcs < MAX_ACTIVE_ARCS AND type off cooldown —
// the gate lives in WO-05's turnPostProcess wiring). spawnArc itself does NOT gate;
// it authors ONE arc against the single anchor it is handed.
//
// Output: a fully-formed, validated ArcRecord (currentRung 0, tickDC ARC_TICK_DC.initial,
// stance 'unaware', status 'active'), or null if generation/validation failed.
//
// Validation per contract §4:
//   - ladder.length must be LADDER_MIN..LADDER_MAX → reject if outside.
//   - type must be a valid ArcType AND not in suppressedTypes → reject if violated.
//   - each surface coerced to a valid ArcSurface (default 'ambient' if garbage).
//   - early rungs skew ambient/rumor, last 1–2 direct — SOFT (the prompt instructs it;
//     we do NOT reject on a skew violation, only coerce bad surface tokens).
//   - reuse troublemaker's JSON-extract + fallback parse skeleton.

import type {
    ArcRecord,
    ArcStage,
    ArcSurface,
    ArcType,
    EndpointConfig,
    ProviderConfig,
    NPCEntry,
    NPCPressure,
} from '../../types';
import { llmCall } from '../../utils/llmCall';
import { uid } from '../../utils/uid';
import {
    LADDER_MIN,
    LADDER_MAX,
    ARC_TICK_DC,
    TYPE_COOLDOWN_SEAMS,
} from './arcConstants';

// Desktop has no shared infrastructure/utilityPrompts module; these prompt-section
// constants are inlined from mobile's services/infrastructure/utilityPrompts (small + only
// used here + in sceneStakesTag). A future refactor can lift them to a shared module.
const TTRPG_PERSONA_GM_ASSISTANT = 'You are a background GM assistant running silently.';
const ANCHOR_BEFORE_INPUT = 'Now produce the JSON described above for the INPUT below.';
const INPUT_DELIMITER = '----- INPUT -----';
function joinPromptSections(...sections: Array<string | null | undefined>): string {
    return sections.filter(Boolean).join('\n\n');
}

export type SpawnArcAnchor =
    | { kind: 'agent'; name: string; want: string }
    | { kind: 'thread'; text: string };

export interface SpawnArcInput {
    provider: EndpointConfig | ProviderConfig;
    anchor: SpawnArcAnchor;
    worldContext: string;        // brief: recent scene summary / relevant lore snippet
    suppressedTypes: ArcType[];  // types on cooldown — exclude
    bornScene: string;
}

const VALID_ARC_TYPES: ReadonlySet<ArcType> = new Set<ArcType>([
    'economic', 'political', 'factional', 'social',
    'supernatural', 'criminal', 'environmental',
]);

const VALID_ARC_SURFACES: ReadonlySet<ArcSurface> = new Set<ArcSurface>([
    'ambient', 'rumor', 'direct',
]);

function coerceSurface(raw: unknown): ArcSurface {
    if (typeof raw === 'string' && VALID_ARC_SURFACES.has(raw as ArcSurface)) {
        return raw as ArcSurface;
    }
    return 'ambient';
}

function coerceType(raw: unknown, suppressed: Set<ArcType>): ArcType | null {
    if (typeof raw !== 'string') return null;
    if (!VALID_ARC_TYPES.has(raw as ArcType)) return null;
    if (suppressed.has(raw as ArcType)) return null;
    return raw as ArcType;
}

interface SpawnJson {
    title?: unknown;
    type?: unknown;
    seed?: unknown;
    ladder?: unknown;
}

interface ParsedLadderItem {
    label?: unknown;
    surface?: unknown;
}

function asString(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

// Reuse the troublemaker JSON-extract + fallback skeleton. The spawn schema is a
// JSON OBJECT (not an array), so we extract the first {...} block; if that fails
// we fall back to a regex object scan.
function extractSpawnJson(raw: string): SpawnJson | null {
    const cleaned = raw
        .replace(/<think[\s\S]*?<\/think>/gi, '')
        .replace(/```(?:json)?\s*([\s\S]*?)```/i, (_, body: string) => body);

    const start = cleaned.indexOf('{');
    if (start === -1) return null;
    const end = cleaned.lastIndexOf('}');
    if (end === -1 || end <= start) return null;

    try {
        return JSON.parse(cleaned.slice(start, end + 1)) as SpawnJson;
    } catch {
        return null;
    }
}

function validateLadder(rawLadder: unknown): ArcStage[] | null {
    if (!Array.isArray(rawLadder)) return null;
    if (rawLadder.length < LADDER_MIN || rawLadder.length > LADDER_MAX) return null;

    const stages: ArcStage[] = [];
    for (const item of rawLadder as ParsedLadderItem[]) {
        if (!item || typeof item !== 'object') return null;
        const label = asString(item.label);
        if (label.length === 0) return null;
        stages.push({
            label,
            surface: coerceSurface(item.surface),
        });
    }
    return stages;
}

// Soft skew nudge (NOT a reject): if the LLM gave us a ladder where the last 1–2
// rungs are not 'direct', we don't reject — the prompt already asks for it and the
// contract §4 says this is soft. We leave the authored ladder intact. (A future
// refinement may promote the top rung to 'direct' if it's stuck at 'rumor'.)

function buildSpawnPrompt(input: SpawnArcInput): string {
    const anchorBlock = input.anchor.kind === 'agent'
        ? `[GROUNDING ANCHOR — one NPC the player already knows]
Name: ${input.anchor.name}
What they want: ${input.anchor.want}
The seed must grow out of THIS character's situation — their want, their faction, their relationships — not out of the whole world at once.`
        : `[GROUNDING ANCHOR — one open story thread]
${input.anchor.text}
The seed must grow out of THIS unresolved thread — what it implies, what it pressures, what it will worsen — not out of the whole world at once.`;

    const suppressedLine = input.suppressedTypes.length > 0
        ? input.suppressedTypes.join(', ')
        : '(none)';

    return joinPromptSections(
        TTRPG_PERSONA_GM_ASSISTANT,

        `TASK: Author ONE story ARC — a standing condition in the world that worsens over time and will eventually demand the player's attention. Not an encounter. Not a one-scene event. A systemic pressure (economic, political, factional, social, supernatural, criminal, or environmental) that climbs a ladder from a quiet first rumble to a crisis. The arc is GROUNDED in the single anchor below — its seed grows out of that one NPC's want OR that one open thread, not out of the whole world at once.

Output schema — ONE JSON object, no prose, no markdown fences:
{
  "title": "short debug title (not shown to the player as-is)",
  "type":  "economic" | "political" | "factional" | "social" | "supernatural" | "criminal" | "environmental",
  "seed":  "the ONE grounding sentence the ladder grew from (tied to the anchor)",
  "ladder": [
    { "label": "rung 0 — quiet, distant",          "surface": "ambient" },
    { "label": "rung 1",                            "surface": "ambient" | "rumor" },
    ... 5 to 12 rungs total ...
    { "label": "the final crisis rung",            "surface": "direct" }
  ]
}`,

        `RULES — binding:
- SYSTEMIC + INDIRECT, NOT A STRANGER WALKING UP. The seed is a STANDING CONDITION in the world — a harvest failure, a regent's decree, a faction consolidating, a cult spreading, a syndicate cornering a market, a plague rumored in a distant port. It does NOT open with someone approaching the player at their current location. The opening hook is something the player hears about, notices in a price, or learns through rumor — never something that arrives at them.
- WORSENS OVER TIME. Each rung is the same condition one step further along. Rung 0 is distant and quiet; the final rung is the crisis landing in the player's lap. The ladder is the arc — it must feel like ONE thread tightening, not a sequence of unrelated events.
- GROUNDED IN THE ANCHOR ONLY. The seed grows from the single anchor (one NPC's want OR one open thread) below. Do NOT pull in the whole world. The anchor is the root; the ladder is what its consequences become.
- EARLY RUNGS ARE QUIET. The first 1–2 rungs should be 'ambient' (a price shift, a background detail, a distant report). Middle rungs 'rumor' (a merchant mentions it, a traveler brings word). Only the last 1–2 rungs are 'direct' (it arrives in the player's scene — a riot, a lockdown, a death they witness). The crisis is EARNED by the quiet rungs beneath it.
- TROUBLE, NOT A GIFT. The arc is a threat, pressure, complication, ticking-clock, or escalation. Never a free opportunity or a reward.
- AVOID SUPPRESSED TYPES. The type you pick MUST NOT be one of: ${suppressedLine}. Pick a different flavor.
- 5–12 RUNGS, NO MORE, NO LESS.
- NO PROSE AROUND THE JSON. No markdown fences. No explanation. Just the object.`,

        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,

        anchorBlock,
        `[WORLD CONTEXT — brief, for grounding only]\n${input.worldContext || '(none)'}`,
    );
}

/**
 * Author ONE arc: a systemic, indirect, laddered condition grounded against the
 * single anchor. +1 LLM (the only deliberate cost in the Arc Engine; seam-only via
 * the WO-05 gate). Returns a fully-formed, validated ArcRecord, or null on
 * generation/validation failure (caller skips spawning this seam).
 */
export async function spawnArc(input: SpawnArcInput): Promise<ArcRecord | null> {
    const prompt = buildSpawnPrompt(input);

    let raw: string;
    try {
        raw = await llmCall(input.provider, prompt, { maxTokens: 2000, thinkingEffort: 'low' });
    } catch (err) {
        console.warn('[ArcSpawn] LLM call failed:', err);
        return null;
    }

    const parsed = extractSpawnJson(raw);
    if (!parsed) {
        console.warn('[ArcSpawn] no JSON object found in response');
        return null;
    }

    const suppressed = new Set(input.suppressedTypes);
    const type = coerceType(parsed.type, suppressed);
    if (!type) {
        console.warn('[ArcSpawn] rejected: type missing, invalid, or suppressed');
        return null;
    }

    const title = asString(parsed.title);
    const seed = asString(parsed.seed);
    if (title.length === 0 || seed.length === 0) {
        console.warn('[ArcSpawn] rejected: empty title or seed');
        return null;
    }

    const ladder = validateLadder(parsed.ladder);
    if (!ladder) {
        console.warn(`[ArcSpawn] rejected: ladder length outside ${LADDER_MIN}..${LADDER_MAX} or malformed`);
        return null;
    }

    return {
        id: uid(),
        type,
        title,
        seed,
        ladder,
        currentRung: 0,
        tickDC: ARC_TICK_DC.initial,
        stance: 'unaware',
        status: 'active',
        bornScene: input.bornScene,
        lastTickScene: input.bornScene,
    };
}

/**
 * Pick the spawn inputs for a MANUAL arc injection (the Arc Injector button).
 *
 * Unlike the removed seam gate, this does NOT gate on arcWorldState or an active-arc
 * cap — the player pressing the button IS the signal that they want a new arc
 * ("nothing more reliable than the user"). It only:
 *   - feeds the type cooldown as suppressedTypes (steers toward variety; never blocks),
 *   - picks ONE anchor: freshest open thread → most-pressured NPC's want → a fallback
 *     snippet (so a press always has something to ground on once any story exists).
 *
 * Returns the spawn input minus `provider`, or null only if there is genuinely nothing
 * to anchor against (brand-new campaign, no threads / NPCs / fallback text). Pure, +0.
 */
export function pickArcSpawnInput(params: {
    arcs: ArcRecord[];
    openThreads: { text: string }[];
    pressure: Record<string, NPCPressure>;
    npcLedger: NPCEntry[];
    worldContext: string;
    bornScene: string;
    nowScene: number;
    fallbackAnchorText?: string;
}): Omit<SpawnArcInput, 'provider'> | null {
    const { arcs, openThreads, pressure, npcLedger, worldContext, bornScene, nowScene, fallbackAnchorText } = params;

    // Type cooldown → suppressedTypes only (variety steer). Never blocks the press.
    const suppressedTypes = new Set<ArcType>();
    for (const a of arcs) {
        const born = parseInt(a.bornScene, 10);
        if (Number.isFinite(born) && nowScene - born < TYPE_COOLDOWN_SEAMS) {
            suppressedTypes.add(a.type);
        }
    }

    // Anchor: freshest open thread → most-pressured NPC → fallback snippet.
    let anchor: SpawnArcAnchor | null = null;
    if (openThreads.length > 0) {
        anchor = { kind: 'thread', text: openThreads[openThreads.length - 1].text };
    } else {
        let best: NPCEntry | null = null;
        let bestScore = 0;
        for (const npc of npcLedger) {
            const p = pressure[npc.id];
            if (!p) continue;
            const score = (p.ignored ?? 0) + (p.engaged ?? 0);
            if (score > bestScore) { bestScore = score; best = npc; }
        }
        if (best) {
            const want = best.wants?.long?.[0] ?? best.wants?.medium?.[0] ?? best.storyRelevance ?? 'unknown';
            anchor = { kind: 'agent', name: best.name, want };
        } else if (fallbackAnchorText && fallbackAnchorText.trim()) {
            anchor = { kind: 'thread', text: fallbackAnchorText.trim().slice(0, 400) };
        }
    }
    if (!anchor) return null;

    return { anchor, worldContext, suppressedTypes: Array.from(suppressedTypes), bornScene };
}