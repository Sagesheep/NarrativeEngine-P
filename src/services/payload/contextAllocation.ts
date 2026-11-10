/**
 * Context Allocation — how much of the Max Context Limit each part of the story
 * prompt may use.
 *
 * Every row is either **Automatic** (today's rule, unchanged) or **Custom** (a
 * percentage of `settings.contextLimit` the player chose). A custom row is a
 * reserved cap: the space is held for that part and its content is trimmed to
 * fit, never sent above it. Space a row does not use goes to Current Scene (the
 * recent conversation), which is always the remainder.
 *
 * Automatic rows keep the numbers the engine has always used:
 *   - Rules        `rulesBudgetPct` of the limit (default 10%)
 *   - Active NPCs  5% of (limit − rules), plus spill-over from the shared pool
 *   - Facts, Archive Recall, Lore share the world pool: 40% (60% with a deep
 *     archive scan) of (limit − rules), minus the NPC share
 *   - Current State 10% of (limit − rules)
 *   - Older History up to half of the conversation space
 *   - Reply reserve 0
 *
 * Rules is stored in the pre-existing `rulesBudgetPct` (a fraction), so the
 * Rules screen and this one never disagree. Every other custom row lives in
 * `settings.contextAllocation` as a whole-limit percentage.
 *
 * Pure module: no store, no I/O. The settings screen and `buildPayload` call
 * the same functions, so what the screen shows is what the prompt gets.
 */
import type { AppSettings } from '../../types';
import { computeBudgets } from './budgets';
import { effectiveSceneRecallBudget } from '../archive-memory/recallBudget';
import { computeLoreBudget, normalizeLoreDepth } from '../lore/loreBudget';

export const ALLOCATION_ROW_IDS = [
    'currentScene', 'npcs', 'recall', 'facts', 'lore', 'rules', 'state', 'olderHistory', 'reply',
] as const;
export type AllocationRowId = typeof ALLOCATION_ROW_IDS[number];

/** Rows stored in `settings.contextAllocation` (Rules lives in `rulesBudgetPct`). */
export type StoredAllocationRowId = Exclude<AllocationRowId, 'rules'>;
export type ContextAllocationSetting = Partial<Record<StoredAllocationRowId, number>>;

export const DEFAULT_RULES_BUDGET_PCT = 0.10;
/** Today's safety margin between the assembled prompt and the limit (history.ts). */
export const SAFETY_MARGIN_TOKENS = 200;
/** Automatic Current Scene minimum never claims more than this share of the limit. */
export const AUTO_CURRENT_SCENE_MAX_SHARE = 0.25;

const STORED_IDS: readonly StoredAllocationRowId[] = ALLOCATION_ROW_IDS.filter(
    (id): id is StoredAllocationRowId => id !== 'rules',
);

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

/** Keep only finite 0–100 percentages for known rows. Empty → undefined (all Automatic). */
export function normalizeContextAllocation(raw: unknown): ContextAllocationSetting | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const out: ContextAllocationSetting = {};
    for (const id of STORED_IDS) {
        const v = (raw as Record<string, unknown>)[id];
        if (typeof v === 'number' && Number.isFinite(v)) out[id] = Math.round(clampPct(v) * 100) / 100;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

type AllocationSettings = Pick<AppSettings, 'contextLimit' | 'rulesBudgetPct' | 'contextAllocation' | 'sceneRecallBudget' | 'loreDepth'>;

/** The custom percentage for a row, or undefined when the row is Automatic. */
export function customPct(settings: AllocationSettings, row: AllocationRowId): number | undefined {
    if (row === 'rules') {
        const pct = settings.rulesBudgetPct;
        if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
        return Math.abs(pct - DEFAULT_RULES_BUDGET_PCT) < 1e-9 ? undefined : clampPct(pct * 100);
    }
    const v = settings.contextAllocation?.[row];
    return typeof v === 'number' && Number.isFinite(v) ? clampPct(v) : undefined;
}

export function pctToTokens(pct: number, contextLimit: number): number {
    return Math.max(0, Math.floor((contextLimit * clampPct(pct)) / 100));
}

const limitOf = (settings: AllocationSettings) =>
    Number.isFinite(settings.contextLimit) && settings.contextLimit > 0 ? settings.contextLimit : 8192;

/** A custom row's tokens, or undefined when Automatic. */
export function customTokens(settings: AllocationSettings, row: AllocationRowId): number | undefined {
    const pct = customPct(settings, row);
    return pct === undefined ? undefined : pctToTokens(pct, limitOf(settings));
}

/**
 * What a part may *fetch* this turn. Retrieval and assembly use the same number,
 * so raising a row gets more content, not just a bigger block that is dropped.
 */
export function retrievalBudget(settings: AllocationSettings, row: 'recall' | 'lore' | 'rules'): number {
    const custom = customTokens(settings, row);
    if (custom !== undefined) return custom;
    const limit = limitOf(settings);
    if (row === 'recall') return effectiveSceneRecallBudget(settings.sceneRecallBudget, limit);
    if (row === 'lore') return computeLoreBudget(limit, normalizeLoreDepth(settings.loreDepth));
    return Math.floor(limit * (settings.rulesBudgetPct ?? DEFAULT_RULES_BUDGET_PCT));
}

/** Today's automatic numbers at a given limit (after prompt injections). */
export function automaticBudgets(settings: AllocationSettings, limit: number, hasDeepContext: boolean) {
    const { rulesBudget, budgetMap } = computeBudgets(limit, settings.rulesBudgetPct, hasDeepContext);
    return {
        rules: rulesBudget,
        npcFloor: budgetMap.get('npc'),
        worldPool: budgetMap.get('world'),
        state: budgetMap.get('volatile'),
        stable: budgetMap.get('stable'),
    };
}

export type ResolvedAllocation = {
    /** Limit after prompt injections (what assembly fits into). */
    readonly limit: number;
    readonly reply: number;
    /** Tokens the recent conversation is guaranteed before automatic rows. */
    readonly currentSceneMin: number;
    /** Custom Older History cap; undefined = today's rule (half the conversation space). */
    readonly olderHistoryCap?: number;
    /** Current State cap (custom, or today's 10% of limit − rules). */
    readonly state: number;
    /** NPC floor for automatic NPCs; also scales per-NPC field caps. */
    readonly npcFloor: number;
    /** Custom caps. Undefined = the row draws from the shared automatic pool. */
    readonly npcs?: number;
    readonly facts?: number;
    readonly recall?: number;
    readonly lore?: number;
    /** Shared pool for automatic Facts / Recall / Lore and NPC spill-over. */
    readonly pool: number;
    /** Rows that got less than asked because the total would pass the limit. */
    readonly squeezed: readonly AllocationRowId[];
};

/**
 * Resolve every row's allowance for one turn.
 *
 * `fixedTokens` is everything that is not a row and cannot be trimmed here:
 * standing instructions, retrieved rules, pinned memories, the Scene Note, the
 * final-message parts (GM reminder, Director Brief, stance …) and the player's
 * input. Order of claims: reply reserve → Current Scene minimum → custom rows →
 * automatic rows (State, NPC floor, shared pool). Custom rows are scaled down
 * together only when they cannot all fit; the settings screen prevents that.
 */
export function resolveAllocation(input: {
    settings: AllocationSettings;
    /** Limit after prompt injections. */
    limit: number;
    hasDeepContext: boolean;
    fixedTokens: number;
    /** Tokens of the latest user + assistant exchange (automatic Current Scene minimum). */
    latestExchangeTokens: number;
}): ResolvedAllocation {
    const { settings, limit, hasDeepContext, fixedTokens, latestExchangeTokens } = input;
    const auto = automaticBudgets(settings, limit, hasDeepContext);
    const squeezed: AllocationRowId[] = [];

    let avail = Math.max(0, limit - fixedTokens - SAFETY_MARGIN_TOKENS);
    const replyWanted = customTokens(settings, 'reply') ?? 0;
    const reply = Math.min(replyWanted, avail);
    if (reply < replyWanted) squeezed.push('reply');
    avail -= reply;

    const csCustom = customTokens(settings, 'currentScene');
    const csWanted = csCustom ?? Math.min(Math.max(0, latestExchangeTokens), Math.floor(limit * AUTO_CURRENT_SCENE_MAX_SHARE));
    const currentSceneMin = Math.min(csWanted, avail);
    if (currentSceneMin < csWanted) squeezed.push('currentScene');
    avail -= currentSceneMin;

    const customRows = ['npcs', 'facts', 'recall', 'lore', 'state', 'olderHistory'] as const;
    const wanted: Partial<Record<typeof customRows[number], number>> = {};
    let customSum = 0;
    for (const row of customRows) {
        const t = customTokens(settings, row);
        if (t !== undefined) { wanted[row] = t; customSum += t; }
    }
    const scale = customSum > avail && customSum > 0 ? avail / customSum : 1;
    const granted: Partial<Record<typeof customRows[number], number>> = {};
    for (const row of customRows) {
        const w = wanted[row];
        if (w === undefined) continue;
        granted[row] = Math.floor(w * scale);
        if (granted[row]! < w) squeezed.push(row);
    }
    avail -= Object.values(granted).reduce((a, b) => a + (b ?? 0), 0);
    avail = Math.max(0, avail);

    // Automatic rows, in today's priority: Current State, NPC floor, shared pool.
    const take = (want: number, row: AllocationRowId) => {
        const got = Math.max(0, Math.min(want, avail));
        if (got < want) squeezed.push(row);
        avail -= got;
        return got;
    };
    const state = granted.state ?? take(auto.state, 'state');
    const npcFloor = granted.npcs !== undefined ? granted.npcs : take(auto.npcFloor, 'npcs');
    const poolNeeded = granted.npcs === undefined || granted.facts === undefined || granted.recall === undefined || granted.lore === undefined;
    const pool = poolNeeded ? take(auto.worldPool, granted.facts === undefined ? 'facts' : granted.recall === undefined ? 'recall' : 'lore') : 0;

    return {
        limit,
        reply,
        currentSceneMin,
        olderHistoryCap: granted.olderHistory,
        state,
        npcFloor,
        npcs: granted.npcs,
        facts: granted.facts,
        recall: granted.recall,
        lore: granted.lore,
        pool,
        squeezed: [...new Set(squeezed)],
    };
}
