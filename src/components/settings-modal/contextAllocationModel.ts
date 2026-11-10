/**
 * Screen model for the Context Allocation section: what each row shows, the
 * balance bar, and how far a slider may go. Pure, so it is tested without React.
 *
 * Everything is measured against the Max Context Limit. The rows, the fixed
 * reserves and Current Scene always add up to exactly 100%: a slider stops at
 * the space that is still free, and Current Scene is whatever the others leave.
 */
import type { AppSettings } from '../../types';
import {
    automaticBudgets, customPct, customTokens, pctToTokens, resolveAllocation, retrievalBudget, SAFETY_MARGIN_TOKENS,
    type AllocationRowId,
} from '../../services/payload/contextAllocation';
import { DEFAULT_SCENE_RECALL_BUDGET } from '../../services/archive-memory/recallBudget';

export type RowInfo = {
    id: AllocationRowId;
    label: string;
    receives: string;
    lose: string;
    advanced?: boolean;
};

export const ROWS: readonly RowInfo[] = [
    {
        id: 'currentScene',
        label: 'Current Scene',
        receives: 'The latest conversation and the Scene Note, so the writer continues from the exact moment play stopped. It also gets every token the other rows leave unused.',
        lose: 'Setting a minimum guarantees recent messages room. With none, the writer may forget what just happened when other parts are large.',
    },
    {
        id: 'npcs',
        label: 'Active NPCs',
        receives: 'Who each present character is, how they speak, what they want and how they may react, plus off-screen NPC movement.',
        lose: 'Characters flatten: mentioned NPCs lose detail first, then on-stage NPCs fall back to their core line (name, mood, current goal).',
    },
    {
        id: 'recall',
        label: 'Archive Recall',
        receives: 'Relevant moments from older scenes: a full excerpt of the best match and brief reminders of others. Scenes your canon facts point to compete here too.',
        lose: 'Fewer callbacks to the past; the best scene arrives as a shorter excerpt, then only as one-line reminders.',
    },
    {
        id: 'facts',
        label: 'Canon Facts',
        receives: 'Established facts, decisions and consequences — public ones, and those known only to the characters present.',
        lose: 'Pinned and newest facts are kept; older ones are left out, and the writer may contradict settled canon.',
    },
    {
        id: 'lore',
        label: 'Lore',
        receives: 'Relevant world information: places, factions, customs, setting details.',
        lose: 'Less setting colour; the writer may invent details your lore already defines.',
    },
    {
        id: 'rules',
        label: 'Rules',
        receives: 'Rule sections picked for this turn from your indexed rulebook. Your standing instructions are separate and always sent.',
        lose: 'Rules for unusual actions may be left out of the turn.',
    },
    {
        id: 'state',
        label: 'Current State',
        receives: 'Your character, inventory, profile and scene notebook. Location, travel and map position are always sent and do not count here.',
        lose: 'The notebook goes first, then inventory, then profile detail.',
    },
    {
        id: 'olderHistory',
        label: 'Older History',
        receives: 'Condensed summaries of earlier chapters, so the writer remembers them without every old message.',
        lose: 'Earlier chapters fade to one-line synopses, then drop out. Automatic: up to half of the conversation space.',
        advanced: true,
    },
    {
        id: 'reply',
        label: 'Reply Reserve',
        receives: 'Room kept free for the model\'s answer, for providers whose limit counts prompt and reply together.',
        lose: 'Automatic is 0%, as before. Raise it if long replies get cut off near the limit.',
        advanced: true,
    },
];

/** Automatic rows that share one pool today. */
const POOLED: readonly AllocationRowId[] = ['facts', 'recall', 'lore'];

export type RowView = {
    id: AllocationRowId;
    custom: boolean;
    /** Percent of the Max Context Limit shown on the slider. */
    pct: number;
    tokens: number;
    /** For Automatic rows: a plain description of today's rule. */
    autoNote?: string;
    /** Highest percent this row may take right now. */
    maxPct: number;
};

export type AllocationView = {
    limit: number;
    fixedTokens: number;
    rows: RowView[];
    /** Shared automatic pool for Facts / Recall / Lore, when any of them is Automatic. */
    poolTokens: number;
    currentSceneTokens: number;
    segments: { id: AllocationRowId | 'fixed' | 'pool'; tokens: number }[];
};

const fmt = (n: number) => n.toLocaleString();

export function buildAllocationView(settings: AppSettings, injectionTokens: number): AllocationView {
    const limit = settings.contextLimit > 0 ? settings.contextLimit : 8192;
    const injections = Math.max(0, Math.min(limit, injectionTokens));
    const auto = automaticBudgets(settings, limit - injections, false);
    const fixedTokens = Math.min(limit, injections + SAFETY_MARGIN_TOKENS);
    const pooledAuto = POOLED.filter(id => customPct(settings, id) === undefined);
    // Same resolution the engine runs each turn (with this turn's measured parts left
    // out), so the bar shows exactly how rows are squeezed when they cannot all fit.
    const rules = Math.min(customTokens(settings, 'rules') ?? auto.rules, Math.max(0, limit - fixedTokens));
    const a = resolveAllocation({ settings, limit: limit - injections, hasDeepContext: false, fixedTokens: rules, latestExchangeTokens: 0 });
    const poolTokens = a.pool;
    const rowTokens: Record<AllocationRowId, number> = {
        currentScene: a.currentSceneMin,
        rules,
        npcs: a.npcs ?? a.npcFloor,
        state: a.state,
        facts: a.facts ?? 0,
        recall: a.recall ?? 0,
        lore: a.lore ?? 0,
        olderHistory: a.olderHistoryCap ?? 0, // Automatic Older History comes out of Current Scene
        reply: a.reply,
    };
    const others = ALL_IDS.filter(id => id !== 'currentScene');
    const csMin = rowTokens.currentScene;
    const committed = fixedTokens + poolTokens + others.reduce((sum, id) => sum + rowTokens[id], 0);
    const currentSceneTokens = Math.max(0, limit - committed);

    const poolWith = (id: AllocationRowId) => pooledAuto.filter(p => p !== id).map(p => ROW_LABEL[p]);
    const rows: RowView[] = ALL_IDS.map(id => {
        const custom = customPct(settings, id) !== undefined;
        let autoNote: string | undefined;
        let shownTokens = rowTokens[id];
        if (!custom) {
            if (id === 'currentScene') { shownTokens = currentSceneTokens; autoNote = `Gets what is left: ${fmt(currentSceneTokens)} tokens. Keeps at least the latest exchange.`; }
            else if (id === 'olderHistory') autoNote = 'Up to half of the conversation space.';
            else if (id === 'reply') autoNote = 'None reserved.';
            else if (POOLED.includes(id)) {
                const ask = id === 'recall' ? retrievalBudget(settings, 'recall') : id === 'lore' ? retrievalBudget(settings, 'lore') : poolTokens;
                shownTokens = Math.min(ask, poolTokens);
                const mates = poolWith(id);
                autoNote = `Shares ${fmt(poolTokens)} tokens${mates.length ? ` with ${mates.join(' and ')}` : ''}; uses up to ${fmt(Math.min(ask, poolTokens))}.`;
            }
        }
        // Free space for this row: the limit minus everything else that is committed,
        // including Current Scene's custom minimum (Current Scene itself may take all of it).
        const ownCommitted = id === 'currentScene' ? 0 : rowTokens[id];
        const freeFor = limit - (committed - ownCommitted) - (id === 'currentScene' ? 0 : csMin);
        const maxPct = Math.max(0, Math.min(100, (freeFor / limit) * 100));
        const pct = custom ? customPct(settings, id)! : (shownTokens / limit) * 100;
        return { id, custom, pct, tokens: custom ? rowTokens[id] : shownTokens, autoNote, maxPct };
    });

    const segments: AllocationView['segments'] = [
        { id: 'fixed', tokens: fixedTokens },
        ...others.map(id => ({ id, tokens: rowTokens[id] })),
        { id: 'pool', tokens: poolTokens },
        { id: 'currentScene', tokens: currentSceneTokens },
    ].filter(s => s.tokens > 0) as AllocationView['segments'];

    return { limit, fixedTokens, rows, poolTokens, currentSceneTokens, segments };
}

const ALL_IDS = ROWS.map(r => r.id);
const ROW_LABEL = Object.fromEntries(ROWS.map(r => [r.id, r.label])) as Record<AllocationRowId, string>;

/** Settings patch that sets a row to a custom percentage, clamped to what is free. */
export function setRowPct(settings: AppSettings, view: AllocationView, id: AllocationRowId, pct: number): Partial<AppSettings> {
    const row = view.rows.find(r => r.id === id)!;
    const clamped = Math.round(Math.max(0, Math.min(row.maxPct, pct)) * 10) / 10;
    // Rules keeps its long-standing setting; 10% is today's default and reads as Automatic.
    if (id === 'rules') return { rulesBudgetPct: clamped / 100 };
    return { contextAllocation: { ...(settings.contextAllocation ?? {}), [id]: clamped } };
}

/** Settings patch that returns a row to Automatic. */
export function resetRow(settings: AppSettings, id: AllocationRowId): Partial<AppSettings> {
    if (id === 'rules') return { rulesBudgetPct: 0.10 };
    const next = { ...(settings.contextAllocation ?? {}) };
    delete next[id as keyof typeof next];
    const patch: Partial<AppSettings> = { contextAllocation: Object.keys(next).length > 0 ? next : undefined };
    // Archive Recall's Automatic size was the old Scene Recall Space setting; reset restores its default.
    if (id === 'recall') patch.sceneRecallBudget = DEFAULT_SCENE_RECALL_BUDGET;
    return patch;
}

export function resetAll(): Partial<AppSettings> {
    return { contextAllocation: undefined, rulesBudgetPct: 0.10, sceneRecallBudget: DEFAULT_SCENE_RECALL_BUDGET };
}

export { pctToTokens };
