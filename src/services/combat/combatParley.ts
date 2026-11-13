import {
    applyAction, checkParley, currentTurn, lostHalf, onlySummonedEnemies, PARLEY_INTENTS, PARLEY_RATINGS, playerCharacterOf,
} from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';
import { buildPayload, sendMessage } from '../chatEngine';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { getApiFormat } from '../../utils/llmApiHelper';
import { llmCall } from '../../utils/llmCall';
import { uid } from '../../utils/uid';
import type {
    ChatMessage, CombatSession, CombatState, Combatant, EndpointConfig, ParleyIntent, ParleyLine, ParleyRating,
    ParleyRatingSource, ParleyRecord, PendingParley, ProviderConfig,
} from '../../types';
import type { OpenAIMessage } from '../chatEngine';
import {
    cadence, finishCombat, isEngineStepping, isEngineTurn, playerActorId, postPendingLog, runEngineTurnsStepped,
} from './combatController';
import {
    beatHistory, onCombatNarrationAbort, queueCombatNarration, queueParleyReply, rewriteCombatBeat, rosterLines,
    waitForCombatNarration,
} from './combatNarration';
import { countParleyTelemetry } from './combatCommitHooks';

export const PARLEY_RATE_TRACKING_LABEL = 'combat-parley-rate';
export const PARLEY_RATE_JSON_TRACKING_LABEL = 'combat-parley-rate-json';
export const PARLEY_WORDS_MAX = 600;

export const PARLEY_RATING_INSTRUCTION = [
    'Rate the attempt from the enemies\' point of view: their goals, their nature and how the fight is going for them.',
    'Refusing is the default. Flattery, insistence, repetition and bare assertion do not improve a rating.',
    'Rate easy only if the enemies are losing badly or are being offered what they actually want; rate hopeless for mindless, fanatical or cornered foes and for demands that cost them everything.',
    'A successful surrender demand makes every enemy still standing yield, elites and bosses included, so rate it with that in mind.',
    'Do not decide the outcome and do not write the reply yet.',
].join(' ');

export const PARLEY_TOOL_DIRECTIVE = 'Call the rate_parley tool once. intent is what the player character is trying to achieve: ceasefire (stop fighting), let_go (let the party leave), surrender_demand (the enemies yield), bargain (stop in exchange for something), taunt, or other. rating is hopeless, hard, even or easy. speaker is the name of the enemy combatant who answers.';

export const PARLEY_JSON_DIRECTIVE = 'Reply with JSON only, in this shape: {"intent":"ceasefire","rating":"hard","speaker":"Bandit 1"}. intent is ceasefire, let_go, surrender_demand, bargain, taunt or other. rating is hopeless, hard, even or easy. speaker is the name of the enemy combatant who answers.';

export const PARLEY_REPLY_DIRECTIVE = 'Write the speaker\'s reply in character, two to four sentences, in their own voice. The engine result above is decided: do not contradict it, soften it or reverse it. Do not state numbers. Do not act or speak for the player character. Do not add events: no attacks, wounds, deaths, arrivals or anyone leaving beyond what the result says.';

export const RATE_PARLEY_TOOL = {
    type: 'function' as const,
    function: {
        name: 'rate_parley',
        description: 'Rate how the enemies receive what the player character just said. This only rates the attempt; the game engine decides the outcome.',
        parameters: {
            type: 'object' as const,
            properties: {
                intent: { type: 'string' as const, enum: [...PARLEY_INTENTS], description: 'What the player character is trying to achieve.' },
                rating: { type: 'string' as const, enum: [...PARLEY_RATINGS], description: 'How the enemies receive it, from their point of view.' },
                speaker: { type: 'string' as const, description: 'The name of the enemy combatant who answers.' },
            },
            required: ['intent', 'rating', 'speaker'],
        },
    },
};

export type ParleyRating3 = { intent: ParleyIntent; rating: ParleyRating; speaker?: string };

export type ParleyRated = ParleyRating3 & { source: ParleyRatingSource };

type Provider = EndpointConfig | ProviderConfig;

export type ParleyDeps = {
    callTool: (provider: Provider, messages: OpenAIMessage[], controller: AbortController) => Promise<{ name: string; arguments: string | Record<string, unknown> } | null>;
    callJson: (provider: Provider, prompt: string) => Promise<string>;
};

let running = false;
let rateController: AbortController | null = null;
let hookInstalled = false;

function installAbortHook(): void {
    if (hookInstalled) return;
    hookInstalled = true;
    onCombatNarrationAbort(() => {
        rateController?.abort();
        rateController = null;
    });
}

function defaultCallTool(provider: Provider, messages: OpenAIMessage[], controller: AbortController): Promise<{ name: string; arguments: string } | null> {
    return new Promise(resolve => {
        void sendMessage(
            provider,
            messages,
            () => undefined,
            (_text, toolCall) => resolve(toolCall ? { name: toolCall.name, arguments: toolCall.arguments } : null),
            (err) => {
                console.warn('[combat] parley rating call failed:', err);
                resolve(null);
            },
            [RATE_PARLEY_TOOL],
            controller,
            { temperature: 0.2 },
            undefined,
            PARLEY_RATE_TRACKING_LABEL,
        );
    });
}

export const defaultParleyDeps: ParleyDeps = {
    callTool: defaultCallTool,
    callJson: (provider, prompt) => llmCall(provider, prompt, { trackingLabel: PARLEY_RATE_JSON_TRACKING_LABEL, timeoutMs: 45000, temperature: 0.2 }),
};

function pick<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return (allowed as readonly string[]).includes(v) ? v as T : null;
}

export function parseParleyRating(raw: unknown): ParleyRating3 | null {
    let obj: unknown = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch {
            const { value, parseOk } = extractJsonRobust<Record<string, unknown>>(raw, {});
            obj = parseOk ? value : null;
        }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const r = obj as Record<string, unknown>;
    const intent = pick(r.intent, PARLEY_INTENTS);
    const rating = pick(r.rating, PARLEY_RATINGS);
    if (!intent || !rating) return null;
    const speaker = typeof r.speaker === 'string' && r.speaker.trim() ? r.speaker.trim().slice(0, 80) : undefined;
    return { intent, rating, ...(speaker ? { speaker } : {}) };
}

function quote(words: string): string {
    return words.replace(/\s+/g, ' ').replace(/"/g, '\'').trim().slice(0, PARLEY_WORDS_MAX);
}

function upCount(list: readonly Combatant[]): number {
    return list.filter(c => c.status === 'up').length;
}

export function situationWords(state: CombatState): string {
    const all = Object.values(state.combatants).filter(c => !c.summonerId);
    const party = all.filter(c => c.side === 'player' || c.side === 'ally');
    const enemies = all.filter(c => c.side === 'enemy');
    const enemyHurt = lostHalf(state, 'enemy');
    const partyHurt = lostHalf(state, 'party');
    let lead = 'The fight is still even.';
    if (enemyHurt && !partyHurt) lead = 'The party is winning: the enemies have taken heavy losses.';
    else if (partyHurt && !enemyHurt) lead = 'The enemies are winning: the party is badly hurt.';
    else if (enemyHurt && partyHurt) lead = 'Both sides are badly hurt.';
    return `${lead} Enemies still fighting: ${upCount(enemies)} of ${enemies.length}. Party still fighting: ${upCount(party)} of ${party.length}.`;
}

function enemyLines(state: CombatState): string[] {
    return state.order
        .map(id => state.combatants[id])
        .filter((c): c is Combatant => !!c && c.side === 'enemy' && c.status !== 'gone')
        .map(c => {
            const bits = [
                c.tier,
                c.species ? `species: ${c.species}` : '',
                c.look ? `looks: ${c.look.slice(0, 120)}` : '',
                c.summonerId ? 'summoned creature' : '',
                c.status === 'up' ? '' : c.status === 'surrendered' ? 'has yielded' : c.status === 'fled' ? 'has fled' : 'down',
            ].filter(Boolean);
            return `- ${c.name}: ${bits.join('; ')}`;
        });
}

function earlierLines(session: CombatSession, currentId: string): string[] {
    const records = new Map((session.state.parleys ?? []).filter(p => p.attemptId).map(p => [p.attemptId as string, p]));
    return (session.parleyLines ?? [])
        .filter(l => l.attemptId !== currentId)
        .map(l => {
            const r = records.get(l.attemptId);
            const result = !r ? 'not resolved' : r.effect === 'none' ? 'no effect' : r.success ? 'accepted' : 'refused';
            return `- "${quote(l.words)}" (${r ? `${r.intent.replace('_', ' ')}, rated ${r.rating}, ` : ''}${result})`;
        });
}

export function buildRatingBlock(session: CombatSession, words: string, attemptId: string): string {
    const state = session.state;
    const pc = playerCharacterOf(state);
    const lastSeq = session.log.length > 0 ? session.log[session.log.length - 1].seq : 0;
    const earlier = earlierLines(session, attemptId);
    return [
        '[PARLEY — the player character talks instead of fighting]',
        'Combatants:',
        ...rosterLines(state, session.log, { fromSeq: lastSeq, toSeq: lastSeq }),
        'Enemies:',
        ...enemyLines(state),
        `Situation: ${situationWords(state)}`,
        ...(earlier.length > 0 ? ['Earlier attempts in this fight:', ...earlier] : ['Earlier attempts in this fight: none.']),
        `${pc?.name ?? 'The player character'} says: "${quote(words)}"`,
    ].join('\n');
}

export function resultFact(record: ParleyRecord, words: string): string {
    if (record.effect === 'none') return 'The words change nothing. The fight goes on.';
    if (record.effect === 'failed') return 'The enemies refuse. The fight goes on.';
    if (record.effect === 'truce' && record.intent === 'bargain') {
        return `The enemies agree to stop fighting in exchange for what was offered. The fight ends in a truce. The offer was the player's: "${quote(words)}". What exactly the enemies accept within it is for the story to settle.`;
    }
    if (record.effect === 'truce') return 'The enemies agree to stop fighting. The fight ends in a truce.';
    if (record.effect === 'let_go') return 'The enemies let the party leave, carrying its fallen with it. The fight ends.';
    return 'The enemies yield and lay down their arms. They are at the party\'s mercy. The fight ends.';
}

export function buildReplyBlock(session: CombatSession, record: ParleyRecord, words: string, eventSeq: number): string {
    const state = session.state;
    const pc = playerCharacterOf(state);
    const speaker = record.speakerId ? state.combatants[record.speakerId] : undefined;
    return [
        '[PARLEY REPLY — resolved by the game engine]',
        'Combatants:',
        ...rosterLines(state, session.log, { fromSeq: eventSeq, toSeq: eventSeq }),
        `${pc?.name ?? 'The player character'} said: "${quote(words)}"`,
        `Speaker: ${speaker ? `${speaker.name}${speaker.look ? ` — ${speaker.look.slice(0, 120)}` : ''}` : 'the enemies'}`,
        `Engine result: ${resultFact(record, words)}`,
        PARLEY_REPLY_DIRECTIVE,
    ].join('\n');
}

function ratingMessages(session: CombatSession, words: string, attemptId: string, lineId: string): OpenAIMessage[] {
    const store = useAppStore.getState();
    const payload = buildPayload({
        settings: store.settings,
        context: store.context,
        history: beatHistory(store.messages, lineId),
        userMessage: `${buildRatingBlock(session, words, attemptId)}\n\n${PARLEY_RATING_INSTRUCTION}\n${PARLEY_TOOL_DIRECTIVE}`,
        condensedUpToIndex: store.condenser.condensedUpToIndex,
        npcLedger: store.npcLedger,
        archiveIndex: store.archiveIndex,
        chapters: store.chapters,
        onStageNpcIds: store.onStageNpcIds,
        pinnedExcerpts: store.pinnedExcerpts,
        locationLedger: store.locationLedger,
        divergenceRegister: store.divergenceRegister,
        engineCombatActive: true,
    }).messages;
    const provider = store.getActiveStoryEndpoint();
    return sanitizePayloadForApi(payload, false, provider?.modelName) as OpenAIMessage[];
}

export async function rateParley(session: CombatSession, pending: PendingParley, deps: ParleyDeps = defaultParleyDeps): Promise<ParleyRated> {
    if (onlySummonedEnemies(session.state)) return { intent: 'other', rating: 'hopeless', source: 'engine' };
    installAbortHook();
    const store = useAppStore.getState();
    const story = store.getActiveStoryEndpoint();
    if (story && getApiFormat(story) !== 'ollama') {
        const controller = new AbortController();
        rateController = controller;
        try {
            const call = await deps.callTool(story, ratingMessages(session, pending.words, pending.attemptId, pending.lineMessageId), controller);
            if (controller.signal.aborted) return { intent: 'other', rating: 'hard', source: 'default' };
            const parsed = call && call.name === 'rate_parley' ? parseParleyRating(call.arguments) : null;
            if (parsed) return { ...parsed, source: 'tool' };
        } catch (e) {
            console.warn('[combat] parley rating tool call failed:', e);
        } finally {
            if (rateController === controller) rateController = null;
        }
    }
    const utility = store.getActiveUtilityEndpoint?.() ?? story;
    if (utility) {
        try {
            const prompt = [buildRatingBlock(session, pending.words, pending.attemptId), PARLEY_RATING_INSTRUCTION, PARLEY_JSON_DIRECTIVE].join('\n\n');
            const parsed = parseParleyRating(await deps.callJson(utility, prompt));
            if (parsed) return { ...parsed, source: 'json' };
        } catch (e) {
            console.warn('[combat] parley rating fallback failed:', e);
        }
    }
    return { intent: 'other', rating: 'hard', source: 'default' };
}

export function canParley(session: CombatSession | null, busy: boolean): boolean {
    if (!session || busy || running || session.parley || session.state.outcome) return false;
    const actorId = playerActorId(session.state);
    if (!actorId) return false;
    return checkParley(session.state, actorId, currentTurn(session.state)).ok;
}

export function isParleyRunning(): boolean {
    return running;
}

function liveSession(campaignId: string, sessionId: string, attemptId: string): CombatSession | null {
    const live = useAppStore.getState();
    const session = live.combatSession;
    if (live.activeCampaignId !== campaignId || !session || session.state.id !== sessionId || session.parley?.attemptId !== attemptId) return null;
    return session;
}

function updateLine(lines: ParleyLine[] | undefined, attemptId: string, patch: Partial<ParleyLine>): ParleyLine[] {
    return (lines ?? []).map(l => (l.attemptId === attemptId ? { ...l, ...patch } : l));
}

async function rollParley(campaignId: string, session: CombatSession, deps: ParleyDeps): Promise<void> {
    const pending = session.parley as PendingParley;
    const rated = await rateParley(session, pending, deps);
    const live = liveSession(campaignId, session.state.id, pending.attemptId);
    if (!live || live.parley?.stage !== 'rating') return;
    const pc = playerCharacterOf(live.state);
    if (!pc) return;
    const applied = applyAction(live.state, {
        type: 'parley', actorId: pc.id, intent: rated.intent, rating: rated.rating, attemptId: pending.attemptId,
        ...(rated.speaker ? { speakerId: rated.speaker } : {}),
    });
    const event = applied.events.find(e => e.type === 'parley');
    if (!event) {
        console.warn('[combat] parley was rejected by the engine:', applied.events[0]?.text);
        useAppStore.getState().setCombatSession({ ...live, parley: undefined });
        debouncedSaveCampaignState();
        return;
    }
    const record = event.data as unknown as ParleyRecord;
    countParleyTelemetry(record, rated.source);
    const next: CombatSession = {
        ...live,
        state: applied.state,
        log: [...live.log, ...applied.events],
        parley: {
            ...pending,
            stage: 'rolled',
            intent: rated.intent,
            rating: rated.rating,
            source: rated.source,
            eventSeq: event.seq,
            ...(record.speakerId ? { speakerId: record.speakerId } : {}),
        },
        parleyLines: updateLine(live.parleyLines, pending.attemptId, { intent: record.intent, rating: record.rating, success: record.success }),
    };
    const posted = postPendingLog(next);
    useAppStore.getState().setCombatSession(posted);
    debouncedSaveCampaignState();
    queueParleyReply(posted, pending.attemptId, event.seq, buildReplyBlock(posted, record, pending.words, event.seq));
    queueCombatNarration(posted, cadence(), posted.state.outcome !== null);
}

function replyMessage(messages: readonly ChatMessage[], attemptId: string): ChatMessage | undefined {
    return messages.find(m => m.combatParley?.attemptId === attemptId && m.combatParley.part === 'reply');
}

async function replyOnly(campaignId: string, session: CombatSession): Promise<void> {
    const pending = session.parley as PendingParley;
    const existing = replyMessage(useAppStore.getState().messages, pending.attemptId);
    if (existing) {
        if (!existing.content.trim() || existing.combatBeat?.failed) await rewriteCombatBeat(existing.id);
        const live = liveSession(campaignId, session.state.id, pending.attemptId);
        if (live) {
            useAppStore.getState().setCombatSession({ ...live, parley: undefined });
            debouncedSaveCampaignState();
        }
        return;
    }
    const record = (session.state.parleys ?? []).find(p => p.attemptId === pending.attemptId);
    const seq = pending.eventSeq ?? session.log.find(e => e.type === 'parley' && e.data.attemptId === pending.attemptId)?.seq;
    if (!record || seq === undefined) {
        useAppStore.getState().setCombatSession({ ...session, parley: undefined });
        debouncedSaveCampaignState();
        return;
    }
    queueParleyReply(session, pending.attemptId, seq, buildReplyBlock(session, record, pending.words, seq));
}

async function settleAfter(campaignId: string, sessionId: string): Promise<void> {
    const live = useAppStore.getState();
    const session = live.combatSession;
    if (live.activeCampaignId !== campaignId || !session || session.state.id !== sessionId) return;
    if (session.state.outcome) {
        await finishCombat();
        return;
    }
    await waitForCombatNarration();
    const after = useAppStore.getState().combatSession;
    if (after && after.state.id === sessionId && !after.state.outcome && isEngineTurn(after.state)) await runEngineTurnsStepped();
}

async function continueParley(campaignId: string, deps: ParleyDeps): Promise<void> {
    const session = useAppStore.getState().combatSession;
    if (!session?.parley) return;
    if (session.parley.stage === 'rating') await rollParley(campaignId, session, deps);
    else await replyOnly(campaignId, session);
    await settleAfter(campaignId, session.state.id);
}

export async function submitParley(words: string, deps: ParleyDeps = defaultParleyDeps): Promise<boolean> {
    const text = words.trim().slice(0, PARLEY_WORDS_MAX);
    const store = useAppStore.getState();
    const campaignId = store.activeCampaignId;
    const session = store.combatSession;
    if (!text || !campaignId || !session || isEngineStepping() || !canParley(session, store.combatBusy)) return false;
    running = true;
    store.setCombatBusy(true);
    try {
        queueCombatNarration(session, cadence(), true);
        await waitForCombatNarration();
        const live = useAppStore.getState();
        const current = live.combatSession;
        if (live.activeCampaignId !== campaignId || !current || current.state.id !== session.state.id || current.parley) return false;
        const attemptId = uid();
        const line: ChatMessage = {
            id: uid(),
            role: 'user',
            content: text,
            timestamp: Date.now(),
            combatParley: { sessionId: current.state.id, attemptId, part: 'line' },
        };
        live.addMessage(line);
        live.setCombatSession({
            ...current,
            parley: { attemptId, words: text, lineMessageId: line.id, stage: 'rating' },
            parleyLines: [...(current.parleyLines ?? []), { attemptId, words: text }],
        });
        debouncedSaveCampaignState();
        await continueParley(campaignId, deps);
        return true;
    } finally {
        running = false;
        useAppStore.getState().setCombatBusy(false);
    }
}

export async function resumeParley(deps: ParleyDeps = defaultParleyDeps): Promise<void> {
    const store = useAppStore.getState();
    const campaignId = store.activeCampaignId;
    if (running || !campaignId || !store.combatSession?.parley) return;
    running = true;
    store.setCombatBusy(true);
    try {
        await continueParley(campaignId, deps);
    } finally {
        running = false;
        useAppStore.getState().setCombatBusy(false);
    }
}

export function resetParleyForTests(): void {
    running = false;
    rateController = null;
}
