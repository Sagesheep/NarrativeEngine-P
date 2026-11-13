import { currentActorId } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';
import { buildPayload, sendMessage } from '../chatEngine';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';
import { extractAndStripSceneStakes } from '../turn/sceneStakesTag';
import { isEngineLogMessage } from '../payload/history';
import { uid } from '../../utils/uid';
import { groupEventsByTurn, hpBandLabel, isGroupComplete, isPresent, positionPhrase, sideGroup, stateAtSeq, turnLines } from './combatEvents';
import type { ChatMessage, CombatEvent, CombatNarrationCadence, CombatSession, CombatState } from '../../types';

export const BEAT_DIRECTIVE =
    'Narrate only the events listed, in order. Every listed hit, miss, and fall must appear and nothing may be added: no extra attacks, no new wounds, no deaths, no one fleeing or yielding, no new arrivals. Do not state numbers. Do not act or speak for the player character beyond the listed actions. Two to five sentences.';

export const BEAT_TRACKING_LABEL = 'combat-beat';
export const PARLEY_REPLY_TRACKING_LABEL = 'combat-parley-reply';

export type BeatRange = { fromSeq: number; toSeq: number };

type BeatJob = BeatRange & { sessionId: string; campaignId: string; block: string; attemptId?: string };

const queue: BeatJob[] = [];
const queuedThrough = new Map<string, number>();
let running: Promise<void> | null = null;
let inFlight: AbortController | null = null;
let idleWaiters: Array<() => void> = [];
let watchInstalled = false;

function sideOf(state: CombatState, actorId: string | undefined | null) {
    return sideGroup(actorId ? state.combatants[actorId]?.side : undefined);
}

export function computeBeatRanges(
    session: CombatSession,
    cadence: CombatNarrationCadence,
    afterSeq: number,
    final: boolean,
): BeatRange[] {
    const pending = session.log.filter(e => e.seq > afterSeq);
    if (pending.length === 0) return [];
    const all = groupEventsByTurn(pending);
    const groups: typeof all = [];
    for (const group of all) {
        if (!final && !isGroupComplete(group, session.state)) break;
        groups.push(group);
    }
    const ranges: BeatRange[] = [];
    let from = pending[0].seq;
    const nextActor = currentActorId(session.state);
    groups.forEach((group, index) => {
        if (group.events.length === 0) return;
        const last = group.events[group.events.length - 1].seq;
        const isLastGroup = index === groups.length - 1;
        const nextGroupActor = isLastGroup ? (all[index + 1]?.actorId ?? nextActor) : groups[index + 1].actorId;
        const roundEnded = group.events.some(e => e.type === 'round');
        let due = false;
        if (cadence === 'action') due = group.actorId !== undefined;
        else if (cadence === 'side') due = roundEnded || (group.actorId !== undefined && sideOf(session.state, group.actorId) !== sideOf(session.state, nextGroupActor));
        else if (cadence === 'round') due = roundEnded;
        if (isLastGroup && final) due = true;
        if (due) {
            ranges.push({ fromSeq: from, toSeq: last });
            from = last + 1;
        }
    });
    return ranges;
}

function rangeEvents(log: readonly CombatEvent[], range: BeatRange): CombatEvent[] {
    return log.filter(e => e.seq >= range.fromSeq && e.seq <= range.toSeq && e.type !== 'rejected');
}

export function beatLines(state: CombatState, log: readonly CombatEvent[], range: BeatRange): string[] {
    const atEnd = stateAtSeq(state, log, range.toSeq);
    return groupEventsByTurn(rangeEvents(log, range)).flatMap(group => turnLines(group, atEnd, { numbers: false }));
}

export function rosterLines(state: CombatState, log: readonly CombatEvent[], range: BeatRange): string[] {
    const atEnd = stateAtSeq(state, log, range.toSeq);
    const fledHere = new Set(rangeEvents(log, range)
        .filter(e => e.type === 'flee' && e.data.success === true && e.actorId)
        .map(e => e.actorId as string));
    return atEnd.order
        .map(id => atEnd.combatants[id])
        .filter(c => isPresent(c) && (c.status !== 'fled' || fledHere.has(c.id)))
        .map(c => {
            const role = c.side === 'player' ? 'player character' : c.side;
            const look = c.look ? ` — ${c.look.slice(0, 80)}` : '';
            const where = c.status === 'fled' ? null : positionPhrase(atEnd, c);
            return `- ${c.name} (${role})${look}: ${hpBandLabel(c)}${where ? `, ${where}` : ''}`;
        });
}

export function buildCombatBlock(state: CombatState, log: readonly CombatEvent[], range: BeatRange): string {
    const roster = rosterLines(state, log, range);
    const lines = beatLines(state, log, range).map((line, i) => `${i + 1}. ${line}`);
    return [
        '[COMBAT BEAT — resolved by the game engine]',
        'Combatants:',
        ...roster,
        'Events, in order:',
        ...lines,
    ].join('\n');
}

export function stripBeatText(text: string): string {
    return extractAndStripSceneStakes(text).displayText.replace(/^Scene\s*#\d+\s*\|?\s*/i, '').trim();
}

export function beatHistory(messages: readonly ChatMessage[], beatId: string): ChatMessage[] {
    const idx = messages.findIndex(m => m.id === beatId);
    const before = idx === -1 ? [...messages] : messages.slice(0, idx);
    let end = before.length;
    while (end > 0 && isEngineLogMessage(before[end - 1])) end--;
    return before.slice(0, end);
}

function parleyLineId(messages: readonly ChatMessage[], reply: ChatMessage): string | undefined {
    const attemptId = reply.combatParley?.attemptId;
    if (!attemptId) return undefined;
    return messages.find(m => m.combatParley?.attemptId === attemptId && m.combatParley.part === 'line')?.id;
}

function patchMessage(id: string, patch: Partial<ChatMessage>, campaignId: string): void {
    useAppStore.setState(live => {
        if (live.activeCampaignId !== campaignId) return live;
        return { messages: live.messages.map(m => m.id === id ? { ...m, ...patch } : m) };
    });
}

function installCampaignWatch(): void {
    if (watchInstalled) return;
    watchInstalled = true;
    useAppStore.subscribe((state, prev) => {
        if (state.activeCampaignId !== prev.activeCampaignId) abortCombatNarration();
    });
}

export async function streamBeat(messageId: string, block: string, campaignId: string): Promise<boolean> {
    const store = useAppStore.getState();
    const provider = store.getActiveStoryEndpoint();
    const existing = store.messages.find(m => m.id === messageId);
    if (!existing?.combatBeat) return false;
    if (!provider) {
        patchMessage(messageId, { combatBeat: { ...existing.combatBeat, failed: true } }, campaignId);
        debouncedSaveCampaignState();
        return false;
    }
    const controller = new AbortController();
    inFlight = controller;
    const payload = buildPayload({
        settings: store.settings,
        context: store.context,
        history: beatHistory(store.messages, parleyLineId(store.messages, existing) ?? messageId),
        userMessage: existing.combatParley ? block : `${block}\n\n${BEAT_DIRECTIVE}`,
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
    const request = sanitizePayloadForApi(payload, false, provider.modelName);
    const beat = existing.combatBeat;
    patchMessage(messageId, { content: '', combatBeat: { ...beat, failed: undefined } }, campaignId);
    const ok = await new Promise<boolean>((resolve) => {
        void sendMessage(
            provider,
            request,
            (text) => patchMessage(messageId, { content: stripBeatText(text) }, campaignId),
            (text) => {
                patchMessage(messageId, { content: stripBeatText(text), combatBeat: { ...beat, failed: undefined } }, campaignId);
                resolve(true);
            },
            (err) => {
                console.warn('[combat] narration beat failed:', err);
                patchMessage(messageId, { combatBeat: { ...beat, failed: true } }, campaignId);
                resolve(false);
            },
            undefined,
            controller,
            { temperature: store.getActivePreset()?.sampling?.temperature ?? 0.7 },
            undefined,
            existing.combatParley ? PARLEY_REPLY_TRACKING_LABEL : BEAT_TRACKING_LABEL,
        );
    });
    if (inFlight === controller) inFlight = null;
    debouncedSaveCampaignState();
    return ok;
}

async function runJob(job: BeatJob): Promise<void> {
    const store = useAppStore.getState();
    if (store.activeCampaignId !== job.campaignId) return;
    const messageId = uid();
    store.addMessage({
        id: messageId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        combatBeat: { sessionId: job.sessionId, fromSeq: job.fromSeq, toSeq: job.toSeq, block: job.block },
        ...(job.attemptId ? { combatParley: { sessionId: job.sessionId, attemptId: job.attemptId, part: 'reply' as const } } : {}),
    });
    const session = useAppStore.getState().combatSession;
    if (session && session.state.id === job.sessionId && session.narratedThroughSeq < job.toSeq) {
        useAppStore.getState().setCombatSession({ ...session, narratedThroughSeq: job.toSeq });
    }
    debouncedSaveCampaignState();
    await streamBeat(messageId, job.block, job.campaignId);
    if (!job.attemptId) return;
    const live = useAppStore.getState();
    const current = live.combatSession;
    if (live.activeCampaignId === job.campaignId && current?.state.id === job.sessionId && current.parley?.attemptId === job.attemptId) {
        live.setCombatSession({ ...current, parley: undefined });
        debouncedSaveCampaignState();
    }
}

function drain(): Promise<void> {
    if (running) return running;
    running = (async () => {
        while (queue.length > 0) {
            const job = queue.shift()!;
            try {
                await runJob(job);
            } catch (e) {
                console.warn('[combat] narration job failed:', e);
            }
        }
    })().finally(() => {
        running = null;
        const waiters = idleWaiters;
        idleWaiters = [];
        waiters.forEach(w => w());
    });
    return running;
}

export function queueCombatNarration(session: CombatSession, cadence: CombatNarrationCadence, final = false): BeatRange[] {
    installCampaignWatch();
    const campaignId = useAppStore.getState().activeCampaignId;
    if (!campaignId) return [];
    const sessionId = session.state.id;
    const after = Math.max(session.narratedThroughSeq, queuedThrough.get(sessionId) ?? 0);
    const ranges = computeBeatRanges(session, cadence, after, final);
    const queued: BeatRange[] = [];
    for (const range of ranges) {
        queuedThrough.set(sessionId, range.toSeq);
        if (beatLines(session.state, session.log, range).length === 0) continue;
        queue.push({ ...range, sessionId, campaignId, block: buildCombatBlock(session.state, session.log, range) });
        queued.push(range);
    }
    if (queued.length > 0) void drain();
    return queued;
}

export function queueParleyReply(session: CombatSession, attemptId: string, eventSeq: number, block: string): void {
    installCampaignWatch();
    const campaignId = useAppStore.getState().activeCampaignId;
    if (!campaignId) return;
    const sessionId = session.state.id;
    queue.push({ fromSeq: eventSeq, toSeq: eventSeq, sessionId, campaignId, block, attemptId });
    queuedThrough.set(sessionId, Math.max(queuedThrough.get(sessionId) ?? 0, eventSeq));
    void drain();
}

export function waitForCombatNarration(): Promise<void> {
    if (!running && queue.length === 0) return Promise.resolve();
    return new Promise(resolve => { idleWaiters.push(resolve); });
}

export function isBeatStreaming(): boolean {
    return running !== null;
}

const abortHooks = new Set<() => void>();

export function onCombatNarrationAbort(hook: () => void): () => void {
    abortHooks.add(hook);
    return () => { abortHooks.delete(hook); };
}

export function abortCombatNarration(): void {
    queue.length = 0;
    queuedThrough.clear();
    inFlight?.abort();
    inFlight = null;
    for (const hook of abortHooks) hook();
}

export async function rewriteCombatBeat(messageId: string): Promise<boolean> {
    const store = useAppStore.getState();
    const msg = store.messages.find(m => m.id === messageId);
    const campaignId = store.activeCampaignId;
    if (!msg?.combatBeat?.block || !campaignId) return false;
    if (running) await waitForCombatNarration();
    return streamBeat(messageId, msg.combatBeat.block, campaignId);
}

export function resetCombatNarrationForTests(): void {
    abortCombatNarration();
    running = null;
    idleWaiters = [];
}
