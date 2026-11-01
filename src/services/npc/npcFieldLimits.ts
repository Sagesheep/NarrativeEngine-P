import { computeBudgets } from '../payload/budgets';

/**
 * How much of each NPC text field the story AI sees per turn.
 *
 * The NPC block already has a token budget (the `npc` claim in budgetClaims.ts,
 * 5% of the context left after rules). These caps used to be fixed character
 * counts, which left most of that budget unused on a large context. Now they
 * scale with it:
 *
 *   per-NPC chars = npc budget ÷ NPCs sharing it × CHARS_PER_TOKEN × TEXT_SHARE
 *   scale         = per-NPC chars ÷ FLOOR_TOTAL, clamped to [1, CEILING]
 *   each cap      = its floor × scale
 *
 * The floors are the old fixed caps, so a small context behaves exactly as
 * before; the ceiling stops one lonely NPC from filling the slice with prose
 * that is re-sent (uncached) every turn.
 */
export type NpcTextField =
    | 'appearance' | 'personality' | 'voice' | 'example'
    | 'goal' | 'pursuing' | 'now' | 'boundary' | 'trigger';

export type NpcFieldLimits = Record<NpcTextField, number>;

/** The old fixed caps (characters). Also the relative weight of each field. */
export const NPC_FIELD_FLOORS: NpcFieldLimits = {
    appearance: 80,
    personality: 60,
    voice: 60,
    example: 80,
    goal: 80,
    pursuing: 60,
    now: 40,
    boundary: 40,
    trigger: 50,
};

/** Largest multiple of the floors a field can reach. */
export const NPC_FIELD_CEILING = 4;

const CHARS_PER_TOKEN = 4;
/** Share of an NPC's allowance for these capped fields; the rest is the name line,
 *  hex words, kit, reaction menu and knowledge limits, which are not capped here. */
const TEXT_SHARE = 0.5;
/** A typical NPC line: each field once, plus a second boundary. */
const FLOOR_TOTAL = Object.values(NPC_FIELD_FLOORS).reduce((a, b) => a + b, 0) + NPC_FIELD_FLOORS.boundary;

function scaled(scale: number): NpcFieldLimits {
    const out = {} as NpcFieldLimits;
    for (const key of Object.keys(NPC_FIELD_FLOORS) as NpcTextField[]) {
        out[key] = Math.round(NPC_FIELD_FLOORS[key] * scale);
    }
    return out;
}

/** Caps for one NPC when `npcCount` NPCs share an NPC budget of `npcBudgetTokens`. */
export function npcFieldLimits(npcBudgetTokens: number, npcCount: number): NpcFieldLimits {
    if (!Number.isFinite(npcBudgetTokens) || npcBudgetTokens <= 0) return { ...NPC_FIELD_FLOORS };
    const perNpcChars = (npcBudgetTokens / Math.max(1, npcCount)) * CHARS_PER_TOKEN * TEXT_SHARE;
    const scale = Math.min(NPC_FIELD_CEILING, Math.max(1, perNpcChars / FLOOR_TOTAL));
    return scaled(scale);
}

/** The NPC budget for a context limit, computed the way the payload builder does. */
export function npcBudgetFor(contextLimit: number, rulesBudgetPct?: number): number {
    return computeBudgets(Math.max(1, contextLimit || 0), rulesBudgetPct, false).budgetMap.get('npc');
}

/** The range one field can take at this context limit: alone in a scene vs. a crowded one. */
export function npcFieldRange(field: NpcTextField, contextLimit: number, rulesBudgetPct?: number): { min: number; max: number } {
    const budget = npcBudgetFor(contextLimit, rulesBudgetPct);
    return {
        min: NPC_FIELD_FLOORS[field],
        max: npcFieldLimits(budget, 1)[field],
    };
}

/**
 * Shortens `text` to at most `max` characters, preferring to end on a sentence,
 * then on a word. Adds "…" only when it had to cut mid-sentence.
 */
export function clipText(text: string, max: number): string {
    if (!text || text.length <= max) return text;
    const head = text.slice(0, max);
    const minKeep = Math.floor(max * 0.6);
    const sentenceEnd = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (sentenceEnd >= minKeep) return head.slice(0, sentenceEnd + 1);
    const space = head.lastIndexOf(' ');
    const cut = space >= minKeep ? head.slice(0, space) : head;
    return cut.replace(/[\s,;:—-]+$/, '') + '…';
}

/** `clipText` for one segment of a ` | `-joined NPC line: whitespace collapsed first. */
export function clipLine(text: string | undefined, max: number): string {
    return clipText((text ?? '').replace(/\s+/g, ' ').trim(), max);
}
