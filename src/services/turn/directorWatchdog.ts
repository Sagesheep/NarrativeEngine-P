// Director Watchdog — deterministic per-turn NPC-agency signals with zero LLM calls.
//
// Pure module: no store imports, no async, no LLM, no Date, no Math.random.
// Same inputs → same output. Wired into the turn by WO-03 (out of scope here).
//
// The watchdog scans the recent assistant message history for three failure modes
// the story AI silently slips into:
//   1. silent-npc        — an on-stage NPC has not been named in the last 3 GM replies.
//   2. one-directional   — an NPC with positive engagement toward the PC never initiates
//                            (the PC is doing all the talking-to; the NPC never reaches back).
//   3. interrupted-goal   — an active goal's keywords have not surfaced in the last 5 messages.
//
// Each signal carries a priority; `nudgeText` surfaces the highest-priority one to the GM
// as a single [STAGE NOTE] directive. Lower-priority signals still appear in `dossierText`
// for the GM's situational awareness.

import type { ChatMessage, NPCEntry } from '../../types';

// ── Public types (per WO-02 §1) ──────────────────────────────────────────────
export type WatchdogSignalKind = 'silent-npc' | 'one-directional' | 'interrupted-goal';

export interface WatchdogSignal {
    kind: WatchdogSignalKind;
    npcName: string;
    detail: string;
    priority: number;
}

export interface WatchdogDossier {
    signals: WatchdogSignal[];
    dossierText: string;
    nudgeText: string | null;
}

export interface WatchdogInput {
    messages: ChatMessage[];
    npcLedger: NPCEntry[];
    onStageNpcIds: string[];
    // WO-A rewrite 2 §2: PC lives at `context.playerCharacter`. The watchdog
    // uses it to derive PC name patterns for the one-directional heuristic.
    // Falls back to a legacy `isPC` row in `npcLedger` (post-migration empty).
    playerCharacter?: NPCEntry | null;
}

// ── Tunables (named constants per WO-02 §3/§4/§5) ─────────────────────────────
const SILENT_WINDOW = 3;        // last N assistant messages scanned for the NPC's name
const ONE_DIR_WINDOW = 5;       // last N assistant messages scanned for NPC initiation
const INTERRUPTED_WINDOW = 5;   // last N messages (any role) scanned for goal keywords

// pcRelation engagement threshold. The pcRelation scale is -3..+3 (see NPCEntry type doc);
// >= +1 (Friendly) is "meaningfully positive/engaged" — matches RELATION_CLOSE in
// reactionMenu.ts (the codebase's existing "close bond" gate).
const PC_RELATION_ENGAGED_MIN = 1;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Lowercased name + alias patterns for an NPC (matches npcPressureTracker.ts convention). */
function namePatterns(npc: NPCEntry): string[] {
    const aliases = (npc.aliases || '')
        .split(',')
        .map(a => a.trim().toLowerCase())
        .filter(Boolean);
    return [npc.name.toLowerCase(), ...aliases];
}

/** Word-boundary, case-insensitive test for any of the patterns in `text`. */
function mentionsAny(text: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    const lower = text.toLowerCase();
    return patterns.some(p => {
        if (!p) return false;
        const re = new RegExp(`\\b${escapeRegex(p)}\\b`, 'i');
        return re.test(lower);
    });
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Assistant messages, oldest-first preserved (we filter then keep order). */
function assistantMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.filter(m => m.role === 'assistant' && m.content);
}

/** Last N assistant messages, OLDEST-FIRST (so index 0 is the oldest in the window). */
function lastAssistantWindow(messages: ChatMessage[], n: number): ChatMessage[] {
    const asst = assistantMessages(messages);
    return asst.slice(-n);
}

/**
 * Initiation heuristic (WO-02 §4): the NPC name appears as a sentence subject
 * BEFORE the PC's name within the same assistant message. "Keep it simple and
 * documented" per spec — first-position check, not a full parse.
 *
 * We scan each assistant message in the last ONE_DIR_WINDOW. For each, we find
 * the first word-boundary occurrence of any NPC pattern and the first occurrence
 * of any PC pattern. If the NPC occurs AND (the PC does not occur OR the NPC
 * occurs strictly earlier), the NPC is judged to have initiated that message.
 */
function npcInitiates(
    msg: ChatMessage,
    npcPatterns: string[],
    pcPatterns: string[],
): boolean {
    if (npcPatterns.length === 0) return false;
    const lower = msg.content.toLowerCase();
    const npcIdx = firstIndexAny(lower, npcPatterns);
    if (npcIdx === -1) return false;
    const pcIdx = firstIndexAny(lower, pcPatterns);
    return pcIdx === -1 || npcIdx < pcIdx;
}

function firstIndexAny(lower: string, patterns: string[]): number {
    let best = -1;
    for (const p of patterns) {
        if (!p) continue;
        const re = new RegExp(`\\b${escapeRegex(p)}\\b`, 'i');
        const m = re.exec(lower);
        if (m && (best === -1 || m.index < best)) best = m.index;
    }
    return best;
}

/** Extract content strings from the last N messages of any role. */
function lastMessageTexts(messages: ChatMessage[], n: number): string[] {
    return messages.slice(-n).map(m => m.content ?? '');
}

/** Keyword tokens from a goal's `text` field (>=4 chars, lowercased, deduped). */
function goalKeywords(text: string): string[] {
    const tokens = (text || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter(t => t.length >= 4);
    return Array.from(new Set(tokens));
}

// ── Signal builders ─────────────────────────────────────────────────────────

/**
 * silent-npc (WO-02 §3): for each on-stage NPC, scan assistant messages newest-first
 * for the NPC's name. If the NPC is not mentioned in the last SILENT_WINDOW assistant
 * messages while on stage → signal (priority 3). Detail includes the streak length
 * (count of consecutive most-recent assistant messages in which the NPC was absent,
 * capped at the total assistant count available).
 */
function buildSilentNpcSignals(
    messages: ChatMessage[],
    onStageNpcs: NPCEntry[],
): WatchdogSignal[] {
    const asst = assistantMessages(messages);
    if (asst.length === 0 || onStageNpcs.length === 0) return [];
    // newest-first window of size SILENT_WINDOW
    const windowNewestFirst = asst.slice(-SILENT_WINDOW).reverse();
    const signals: WatchdogSignal[] = [];
    for (const npc of onStageNpcs) {
        const patterns = namePatterns(npc);
        if (patterns.length === 0) continue;
        // Count consecutive assistant messages (newest-first) without a mention.
        let streak = 0;
        for (const m of windowNewestFirst) {
            if (mentionsAny(m.content, patterns)) break;
            streak += 1;
        }
        if (streak >= SILENT_WINDOW) {
            // Cap reported streak at the actual number of assistant messages available
            // (a longer history is invisible to this pure function — WO-03 wiring will
            // pass the visible message window).
            const reported = Math.min(streak, asst.length);
            signals.push({
                kind: 'silent-npc',
                npcName: npc.name,
                detail: `silent for ${reported} turn${reported === 1 ? '' : 's'} while on stage.`,
                priority: 3,
            });
        }
    }
    return signals;
}

/**
 * one-directional (WO-02 §4): if the NPC→PC value is meaningfully positive/engaged
 * (pcRelation >= PC_RELATION_ENGAGED_MIN, with legacy affinity fallback via the
 * codebase's affinityToPcRelation mapping) and the last ONE_DIR_WINDOW assistant
 * messages contain no message where this NPC initiates (NPC name appears as
 * sentence subject before the PC's name) → signal (priority 2).
 *
 * Divergence from spec (see report): the type carries only the NPC→PC half of the
 * asymmetric relation pair (pcRelation / affinity). There is no PC→NPC meter on
 * NPCEntry, so the signal is built from the NPC→PC engagement plus the initiation
 * heuristic alone, per the spec's "keep it simple and documented" instruction.
 *
 * `pcPatterns` is the set of names the PC is known by in this turn. The caller is
 * expected to pass them in (WO-03 will pull them from the PC profile); we accept
 * an empty list and treat that as "PC never named" → any NPC that names itself
 * first counts as initiating.
 */
function buildOneDirectionalSignals(
    messages: ChatMessage[],
    onStageNpcs: NPCEntry[],
    pcPatterns: string[],
): WatchdogSignal[] {
    const window = lastAssistantWindow(messages, ONE_DIR_WINDOW);
    if (window.length === 0 || onStageNpcs.length === 0) return [];
    const signals: WatchdogSignal[] = [];
    for (const npc of onStageNpcs) {
        const pcRel = resolvePcRelation(npc);
        if (pcRel < PC_RELATION_ENGAGED_MIN) continue;
        const npcPatterns = namePatterns(npc);
        if (npcPatterns.length === 0) continue;
        const initiated = window.some(m => npcInitiates(m, npcPatterns, pcPatterns));
        if (!initiated) {
            signals.push({
                kind: 'one-directional',
                npcName: npc.name,
                detail: `relation to PC is ${pcRel >= 0 ? '+' : ''}${pcRel} but NPC has not initiated in the last ${window.length} assistant message${window.length === 1 ? '' : 's'}.`,
                priority: 2,
            });
        }
    }
    return signals;
}

/** Resolve the NPC→PC band using pcRelation, falling back to legacy affinity. */
function resolvePcRelation(npc: NPCEntry): number {
    if (typeof npc.pcRelation === 'number' && Number.isFinite(npc.pcRelation)) {
        return npc.pcRelation;
    }
    // Mirror reactionMenu.ts / relationMeter.ts fallback. Inline the boundaries so
    // this module stays pure (no import of agency/agencyBands — keeps the blast
    // radius small and the test hermetic).
    const a = typeof npc.affinity === 'number' && Number.isFinite(npc.affinity) ? npc.affinity : 50;
    if (a <= 15) return -3;
    if (a <= 30) return -2;
    if (a <= 45) return -1;
    if (a <= 55) return 0;
    if (a <= 70) return 1;
    if (a <= 85) return 2;
    return 3;
}

/**
 * interrupted-goal (WO-02 §5): any goalRecords entry whose state is 'active'
 * (the type's in-progress status — GoalState has no literal 'in-progress') and
 * whose text keywords don't appear in the last INTERRUPTED_WINDOW messages →
 * signal (priority 1).
 */
function buildInterruptedGoalSignals(
    messages: ChatMessage[],
    onStageNpcs: NPCEntry[],
): WatchdogSignal[] {
    if (onStageNpcs.length === 0) return [];
    const recentTexts = lastMessageTexts(messages, INTERRUPTED_WINDOW);
    if (recentTexts.length === 0) return [];
    const recentBlob = recentTexts.join('\n').toLowerCase();
    const signals: WatchdogSignal[] = [];
    for (const npc of onStageNpcs) {
        const goals = npc.goalRecords;
        if (!goals || goals.length === 0) continue;
        for (const goal of goals) {
            if (goal.state !== 'active') continue;
            const keywords = goalKeywords(goal.text);
            if (keywords.length === 0) continue;
            const hit = keywords.some(kw => {
                const re = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
                return re.test(recentBlob);
            });
            if (!hit) {
                signals.push({
                    kind: 'interrupted-goal',
                    npcName: npc.name,
                    detail: `active goal "${goal.text}" has not surfaced in the last ${recentTexts.length} message${recentTexts.length === 1 ? '' : 's'}.`,
                    priority: 1,
                });
            }
        }
    }
    return signals;
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Build a deterministic watchdog dossier from the turn's visible inputs.
 * Pure: no I/O, no Date, no Math.random. Same inputs → same output.
 *
 * PC name patterns are derived from `input.playerCharacter` (WO-A rewrite 2 §2:
 * the PC lives at `context.playerCharacter`), with a defensive fallback to a
 * legacy `isPC` row in `npcLedger` (post-migration this is empty). When no PC
 * entry is present, the one-directional heuristic treats the PC as never-named,
 * so any NPC that appears as the first subject in an assistant message counts
 * as initiating.
 */
export function buildWatchdogDossier(input: WatchdogInput): WatchdogDossier {
    const { messages, npcLedger, onStageNpcIds, playerCharacter } = input;
    const onStageSet = new Set(onStageNpcIds);
    const onStageNpcs = npcLedger.filter(n => onStageSet.has(n.id) && !n.archived);
    const pcEntry = playerCharacter ?? npcLedger.find(n => n.isPC) ?? null;
    const pcPatterns = pcEntry ? namePatterns(pcEntry) : [];

    const signals: WatchdogSignal[] = [
        ...buildSilentNpcSignals(messages, onStageNpcs),
        ...buildOneDirectionalSignals(messages, onStageNpcs, pcPatterns),
        ...buildInterruptedGoalSignals(messages, onStageNpcs),
    ];

    // Stable ordering: by priority ascending (1 = highest), then by kind, then by name.
    // Keeps deterministic output without depending on input order.
    signals.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
        return a.npcName < b.npcName ? -1 : a.npcName > b.npcName ? 1 : 0;
    });

    const dossierText = signals
        .map(s => `- ${s.npcName}: ${s.detail}`)
        .join('\n');

    const nudgeText = signals.length === 0
        ? null
        : formatNudge(signals[0]);

    return { signals, dossierText, nudgeText };
}

/** Format the highest-priority signal as a single GM directive. */
function formatNudge(s: WatchdogSignal): string {
    switch (s.kind) {
        case 'silent-npc': {
            // detail = "silent for N turns while on stage." → extract N.
            const m = /silent for (\d+) turn/.exec(s.detail);
            const n = m ? m[1] : '?';
            return `[STAGE NOTE: ${s.npcName} has been silent ${n} turn${n === '1' ? '' : 's'} — must act or speak this scene.]`;
        }
        case 'one-directional':
            return `[STAGE NOTE: ${s.npcName} has not initiated toward the PC recently — give ${s.npcName} a beat to reach out this scene.]`;
        case 'interrupted-goal':
            return `[STAGE NOTE: ${s.npcName}'s ${s.detail} — surface a step toward it this scene.]`;
    }
}