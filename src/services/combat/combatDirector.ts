import { applyOrders, currentActorId, directorBrief, hasActedThisTurn, isDirected, ORDER_LIMITS, speechOf } from '@narrative/engine';
import type { BriefDirected, BriefUnit, DirectorBrief, DirectorOrder } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { llmCall } from '../../utils/llmCall';
import { normalizeCombatConfig } from '../../types';
import type {
    CombatSession, CombatState, DirectorCallRecord, DirectorCallResult, DirectorTelemetry, EndpointConfig, NPCEntry, ProviderConfig,
} from '../../types';
import { commitSession, setCombatRoundHook } from './combatController';
import type { CombatRoundHook } from './combatController';
import { beatLines, ledgerVoice, mannerOf, onCombatNarrationAbort } from './combatNarration';

export const DIRECTOR_WAIT_MS = 6000;
export const DIRECTOR_CALL_TIMEOUT_MS = 45000;
export const DIRECTOR_TEMPERATURE = 0.4;
export const DIRECTOR_TRACKING_LABEL = 'combat-director';
export const DIRECTOR_RECENT_LINES = 24;
export const DIRECTOR_RECORDS_KEPT = 12;
export const DIRECTOR_REPLY_MAX_ORDERS = 24;

export const DIRECTOR_ROLE = 'You command the officers in a fight that a game engine runs. For each officer listed under Officers, choose one order from the menu, and, if the officer can speak, one short spoken line in its own voice (at most 20 words). The engine checks every order and carries it out: you never move a unit, never pick a square, never add or remove anyone, and you decide no hit, wound or result.';

export const ORDER_MENU: readonly string[] = [
    '- focus (target): hunt that enemy: attack it, or close on it.',
    '- protect (target): stay near that ally and screen it.',
    '- hold: do not advance; fight from where you stand.',
    '- fall_back: break contact; move away from threats toward allies or cover; attack only if free.',
    '- press: ignore your own safety; close in and hit hardest.',
    '- signature: use your signature move this turn (only when it is listed as ready).',
    '- switch_tactic (tactic): change how you fight for the rest of the fight.',
];

export const DIRECTOR_RULES: readonly string[] = [
    '- Enemy officers play to win, within their personality. They never go easy on the player or the player\'s party, and never hold back to make the fight fair.',
    '- Allied officers play their own character and their own judgement, not what the player would wish.',
    '- No order may be chosen because it would make a better story for the player. Choose what this character would do to win, or to survive, this fight.',
    '- Use only the ids, targets and tactics listed as legal for that officer. An officer may also be given no order; it then fights on its tactic.',
    '- Lines are spoken aloud, in the officer\'s voice, about this moment of the fight. No numbers, no game terms.',
];

export const DIRECTOR_REPLY_FORMAT = 'Reply with JSON only, in this shape: {"orders":[{"id":"u3","order":"focus","target":"u1","line":"Cut her down!"},{"id":"u5","order":"switch_tactic","tactic":"guard"}]}. target only for focus and protect, tactic only for switch_tactic, line may be left out. At most one entry per officer.';

type Provider = EndpointConfig | ProviderConfig;

export type DirectorCallOutput = { text: string; promptTokens?: number; replyTokens?: number };

export type DirectorDeps = {
    call: (provider: Provider, prompt: string, signal: AbortSignal) => Promise<DirectorCallOutput>;
    now: () => number;
};

function num(raw: unknown): number | undefined {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

export function readUsage(data: unknown): { promptTokens?: number; replyTokens?: number } {
    const d = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const usage = d.usage && typeof d.usage === 'object' ? d.usage as Record<string, unknown> : null;
    const meta = d.usageMetadata && typeof d.usageMetadata === 'object' ? d.usageMetadata as Record<string, unknown> : null;
    const promptTokens = num(usage?.prompt_tokens) ?? num(usage?.input_tokens) ?? num(meta?.promptTokenCount) ?? num(d.prompt_eval_count);
    const replyTokens = num(usage?.completion_tokens) ?? num(usage?.output_tokens) ?? num(meta?.candidatesTokenCount) ?? num(d.eval_count);
    return { ...(promptTokens !== undefined ? { promptTokens } : {}), ...(replyTokens !== undefined ? { replyTokens } : {}) };
}

async function defaultCall(provider: Provider, prompt: string, signal: AbortSignal): Promise<DirectorCallOutput> {
    let usage: { promptTokens?: number; replyTokens?: number } = {};
    const text = await llmCall(provider, prompt, {
        signal,
        trackingLabel: DIRECTOR_TRACKING_LABEL,
        timeoutMs: DIRECTOR_CALL_TIMEOUT_MS,
        temperature: DIRECTOR_TEMPERATURE,
        onResponse: data => { usage = readUsage(data); },
    });
    return { text, ...usage };
}

export const defaultDirectorDeps: DirectorDeps = { call: defaultCall, now: () => Date.now() };

function str(raw: unknown, max = 200): string | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw !== 'string') return undefined;
    const v = raw.replace(/\s+/g, ' ').trim();
    return v ? v.slice(0, max) : undefined;
}

export function parseDirectorReply(raw: unknown): DirectorOrder[] | null {
    let obj: unknown = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch {
            const { value, parseOk } = extractJsonRobust<unknown>(raw, null);
            obj = parseOk ? value : null;
        }
    }
    const rec = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj as Record<string, unknown> : null;
    const list = Array.isArray(obj) ? obj : Array.isArray(rec?.orders) ? rec.orders as unknown[] : null;
    if (!list) return null;
    const orders: DirectorOrder[] = [];
    for (const item of list.slice(0, DIRECTOR_REPLY_MAX_ORDERS)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const r = item as Record<string, unknown>;
        const unitId = str(r.id ?? r.unitId ?? r.unit ?? r.officer ?? r.name, 80);
        const kind = str(r.order ?? r.kind, 40);
        if (!unitId || !kind) continue;
        const targetId = str(r.target ?? r.targetId, 80);
        const tactic = str(r.tactic, 40);
        const line = str(r.line ?? r.says, ORDER_LIMITS.lineMax * 2);
        orders.push({ unitId, kind, ...(targetId ? { targetId } : {}), ...(tactic ? { tactic } : {}), ...(line ? { line } : {}) });
    }
    return orders;
}

function unitLabel(units: ReadonlyMap<string, BriefUnit>, id: string): string {
    const u = units.get(id);
    return u ? `${id} ${u.name}` : id;
}

function voiceOf(state: CombatState, id: string, ledger: readonly NPCEntry[]): string {
    const c = state.combatants[id];
    if (!c) return '';
    const speech = speechOf(c);
    if (speech === 'sounds') return `animal, makes only sounds and speaks no words (leave line out); manner: ${mannerOf(state, c)}`;
    if (speech === 'silent') return `does not speak (leave line out); manner: ${mannerOf(state, c)}`;
    const npc = c.npcId ? ledger.find(n => n.id === c.npcId) : undefined;
    return ledgerVoice(npc) || `manner: ${mannerOf(state, c)}`;
}

function legalWords(d: BriefDirected, units: ReadonlyMap<string, BriefUnit>): string {
    return d.kinds.map(kind => {
        if (kind === 'focus') return `focus (targets: ${d.focus.map(id => unitLabel(units, id)).join(', ')})`;
        if (kind === 'protect') return `protect (targets: ${d.protect.map(id => unitLabel(units, id)).join(', ')})`;
        if (kind === 'switch_tactic') return `switch_tactic (tactics: ${d.tactics.join(', ')})`;
        if (kind === 'signature' && d.signature) return `signature (${d.signature.name}, ${d.signature.ready ? 'ready' : 'not ready this turn'})`;
        return kind;
    }).join('; ');
}

export function officerLines(brief: DirectorBrief, state: CombatState, ledger: readonly NPCEntry[]): string[] {
    const units = new Map(brief.units.map(u => [u.id, u]));
    return brief.directed.map(d => {
        const u = units.get(d.id);
        const head = u ? `${u.name} (${u.side}, ${u.tier}, tactic ${d.tactic}, ${u.hp.replace('_', ' ')})` : d.id;
        const reach = d.foes.filter(f => f.canHit).map(f => unitLabel(units, f.id));
        return [
            `- id "${d.id}": ${head}.`,
            `  Voice: ${voiceOf(state, d.id, ledger)}.`,
            `  Legal: ${legalWords(d, units)}.`,
            `  Can strike this turn: ${reach.length > 0 ? reach.join(', ') : 'no one'}.`,
        ].join('\n');
    });
}

export function lastRoundLines(session: CombatSession): string[] {
    const state = session.state;
    const previous = session.log.filter(e => e.round === state.round - 1 && e.type !== 'rejected');
    if (previous.length === 0) return [];
    const range = { fromSeq: previous[0].seq, toSeq: previous[previous.length - 1].seq };
    return beatLines(state, session.log, range).slice(-DIRECTOR_RECENT_LINES).map(l => `- ${l}`);
}

export function buildDirectorPrompt(session: CombatSession, ledger: readonly NPCEntry[] = []): string | null {
    const state = session.state;
    const brief = directorBrief(state);
    if (brief.directed.length === 0) return null;
    const recent = lastRoundLines(session);
    return [
        `[COMBAT DIRECTOR — round ${brief.round}]`,
        DIRECTOR_ROLE,
        'Orders:',
        ...ORDER_MENU,
        'Rules:',
        ...DIRECTOR_RULES,
        'Officers:',
        ...officerLines(brief, state, ledger),
        ...(recent.length > 0 ? ['Last round:', ...recent] : ['Last round: none; the fight has just begun.']),
        'Situation, from the engine (JSON; hp is a band, at is a square, adjacent lists pairs within one square):',
        JSON.stringify(brief),
        DIRECTOR_REPLY_FORMAT,
    ].join('\n');
}

export function hasStandingOfficer(state: CombatState): boolean {
    return Object.values(state.combatants).some(c => c.status === 'up' && isDirected(c));
}

type Pending = {
    campaignId: string;
    sessionId: string;
    round: number;
    baseSeq: number;
    controller: AbortController;
    startedAt: number;
    deadline: number;
    settled: boolean;
    cancelled: string | null;
    waitedOut: boolean;
    done: Promise<void>;
    finish: () => void;
};

let deps: DirectorDeps = defaultDirectorDeps;
let pending: Pending | null = null;
let handled: { sessionId: string; round: number } | null = null;
let installed = false;
let unsubscribe: (() => void) | null = null;
let unhook: (() => void) | null = null;
let lastRecord: DirectorCallRecord | null = null;

function emptyTelemetry(sessionId: string): DirectorTelemetry {
    return {
        sessionId, calls: 0, failed: 0, latencyMsTotal: 0, latencyMsMax: 0, promptTokens: 0, replyTokens: 0,
        accepted: 0, rejected: 0, lateReplies: 0, waits: 0, waitedMs: 0, last: [],
    };
}

function updateTelemetry(campaignId: string, sessionId: string, patch: (prev: DirectorTelemetry) => DirectorTelemetry): void {
    const store = useAppStore.getState();
    if (store.activeCampaignId !== campaignId) return;
    const prev = store.context.combatTelemetry ?? { dangerousCommits: 0, dangerousWithoutProposal: 0 };
    const base = prev.director && prev.director.sessionId === sessionId ? prev.director : emptyTelemetry(sessionId);
    store.updateContext({ combatTelemetry: { ...prev, director: patch(base) } });
}

function record(p: Pending, rec: DirectorCallRecord): void {
    lastRecord = rec;
    console.info(`[combat] director round ${rec.round}: ${rec.result}, ${rec.latencyMs} ms, ${rec.accepted} accepted, ${rec.rejected} rejected${rec.promptTokens !== undefined ? `, ${rec.promptTokens} prompt tokens` : ''}${rec.replyTokens !== undefined ? `, ${rec.replyTokens} reply tokens` : ''}${rec.late ? ', late' : ''}`);
    updateTelemetry(p.campaignId, p.sessionId, t => ({
        ...t,
        calls: t.calls + 1,
        failed: t.failed + (rec.result === 'ok' ? 0 : 1),
        latencyMsTotal: t.latencyMsTotal + rec.latencyMs,
        latencyMsMax: Math.max(t.latencyMsMax, rec.latencyMs),
        promptTokens: t.promptTokens + (rec.promptTokens ?? 0),
        replyTokens: t.replyTokens + (rec.replyTokens ?? 0),
        accepted: t.accepted + rec.accepted,
        rejected: t.rejected + rec.rejected,
        lateReplies: t.lateReplies + (rec.late ? 1 : 0),
        last: [...t.last, rec].slice(-DIRECTOR_RECORDS_KEPT),
    }));
}

function settle(p: Pending): void {
    if (p.settled) return;
    p.settled = true;
    p.finish();
}

function liveFor(p: Pending): CombatSession | null {
    const store = useAppStore.getState();
    const live = store.combatSession;
    if (store.activeCampaignId !== p.campaignId || !live || live.state.id !== p.sessionId) return null;
    if (live.state.round !== p.round || live.state.outcome || live.parley) return null;
    return live;
}

function applyReply(p: Pending, orders: readonly DirectorOrder[]): { result: DirectorCallResult; accepted: number; rejected: number } {
    const live = liveFor(p);
    if (!live) return { result: 'stale', accepted: 0, rejected: 0 };
    const applied = applyOrders(live.state, orders, { onlyUnacted: true });
    for (const r of applied.rejected) console.info(`[combat] director order rejected (${r.reason}): ${r.text}`);
    if (applied.events.length > 0) commitSession({ ...live, state: applied.state, log: [...live.log, ...applied.events] });
    return { result: 'ok', accepted: applied.events.length, rejected: applied.rejected.length };
}

async function run(p: Pending, provider: Provider, prompt: string): Promise<void> {
    let result: DirectorCallResult = 'failed';
    let accepted = 0;
    let rejected = 0;
    let tokens: { promptTokens?: number; replyTokens?: number } = {};
    try {
        const out = await deps.call(provider, prompt, p.controller.signal);
        tokens = { ...(out.promptTokens !== undefined ? { promptTokens: out.promptTokens } : {}), ...(out.replyTokens !== undefined ? { replyTokens: out.replyTokens } : {}) };
        if (p.cancelled) {
            result = p.cancelled === 'stale' ? 'stale' : 'cancelled';
        } else {
            const orders = parseDirectorReply(out.text);
            if (!orders) {
                result = 'unparsable';
                console.warn('[combat] director reply could not be read; no orders this round');
            } else {
                const applied = applyReply(p, orders);
                result = applied.result;
                accepted = applied.accepted;
                rejected = applied.rejected;
            }
        }
    } catch (e) {
        result = p.cancelled ? (p.cancelled === 'stale' ? 'stale' : 'cancelled') : 'failed';
        if (!p.cancelled) console.warn('[combat] director call failed; no orders this round:', e);
    } finally {
        if (pending === p) pending = null;
        const late = p.waitedOut || deps.now() > p.deadline;
        if (result === 'cancelled' || result === 'stale') console.warn(`[combat] director call ${result} (${p.cancelled ?? 'the round moved on'}); no orders this round`);
        settle(p);
        record(p, { round: p.round, result, latencyMs: Math.max(0, deps.now() - p.startedAt), ...tokens, accepted, rejected, late: late && result === 'ok' });
    }
}

export function cancelDirector(reason: string): void {
    const p = pending;
    if (!p) return;
    pending = null;
    p.cancelled = reason;
    p.controller.abort();
    settle(p);
}

function markHandled(state: CombatState): boolean {
    if (handled && handled.sessionId === state.id && handled.round >= state.round) return false;
    handled = { sessionId: state.id, round: state.round };
    return true;
}

function providerFor(): Provider | null {
    const store = useAppStore.getState();
    return store.getActiveStoryEndpoint?.() ?? store.getActiveUtilityEndpoint?.() ?? null;
}

export function directorEnabled(): boolean {
    return normalizeCombatConfig(useAppStore.getState().context.combatConfig).combatDirector === 'on';
}

export function onDirectorCommit(session: CombatSession): void {
    const state = session.state;
    if (state.outcome) {
        cancelDirector('ended');
        return;
    }
    if (!markHandled(state)) return;
    if (pending) cancelDirector('stale');
    if (!directorEnabled() || !hasStandingOfficer(state)) return;
    const store = useAppStore.getState();
    const campaignId = store.activeCampaignId;
    const provider = providerFor();
    if (!campaignId || !provider) return;
    const prompt = buildDirectorPrompt(session, store.npcLedger ?? []);
    if (!prompt) return;
    const startedAt = deps.now();
    let finish: () => void = () => undefined;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const p: Pending = {
        campaignId, sessionId: state.id, round: state.round, baseSeq: state.eventSeq, controller: new AbortController(),
        startedAt, deadline: startedAt + DIRECTOR_WAIT_MS, settled: false, cancelled: null, waitedOut: false, done, finish,
    };
    pending = p;
    void run(p, provider, prompt);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function directorHold(state: CombatState): Promise<void> | null {
    const p = pending;
    if (!p || p.settled || p.waitedOut || p.sessionId !== state.id || p.round !== state.round || state.outcome) return null;
    const id = currentActorId(state);
    const actor = id ? state.combatants[id] : undefined;
    if (!id || !actor || actor.status !== 'up' || !isDirected(actor) || hasActedThisTurn(state, id)) return null;
    const remaining = p.deadline - deps.now();
    if (remaining <= 0) {
        p.waitedOut = true;
        return null;
    }
    const from = deps.now();
    return Promise.race([p.done, sleep(remaining)]).then(() => {
        if (!p.settled) p.waitedOut = true;
        const waited = Math.max(0, deps.now() - from);
        updateTelemetry(p.campaignId, p.sessionId, t => ({ ...t, waits: t.waits + 1, waitedMs: t.waitedMs + waited }));
    });
}

export function resumeDirector(session: CombatSession): void {
    cancelDirector('reload');
    handled = { sessionId: session.state.id, round: session.state.round };
}

export const directorRoundHook: CombatRoundHook = {
    onCommit: onDirectorCommit,
    hold: directorHold,
    cancel: cancelDirector,
    resume: resumeDirector,
};

function watchStore(): () => void {
    return useAppStore.subscribe(s => {
        const p = pending;
        if (!p) return;
        const live = s.combatSession;
        if (s.activeCampaignId !== p.campaignId) cancelDirector('reload');
        else if (!live || live.state.id !== p.sessionId) cancelDirector('ended');
        else if (live.state.eventSeq < p.baseSeq) cancelDirector('undo');
    });
}

export function installCombatDirector(custom?: Partial<DirectorDeps>): void {
    deps = { ...defaultDirectorDeps, ...(custom ?? {}) };
    if (installed) return;
    installed = true;
    setCombatRoundHook(directorRoundHook);
    unsubscribe = watchStore();
    unhook = onCombatNarrationAbort(() => cancelDirector('stopped'));
}

export function uninstallCombatDirector(): void {
    cancelDirector('uninstalled');
    setCombatRoundHook(null);
    unsubscribe?.();
    unhook?.();
    unsubscribe = null;
    unhook = null;
    installed = false;
    handled = null;
    deps = defaultDirectorDeps;
    lastRecord = null;
}

export function isDirectorPending(): boolean {
    return pending !== null;
}

export function lastDirectorRecord(): DirectorCallRecord | null {
    return lastRecord;
}
