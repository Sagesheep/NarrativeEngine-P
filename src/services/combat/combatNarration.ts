import { currentActorId } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';
import { buildPayload, sendMessage } from '../chatEngine';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';
import { extractAndStripSceneStakes } from '../turn/sceneStakesTag';
import { isEngineLogMessage } from '../payload/history';
import { uid } from '../../utils/uid';
import { groupEventsByTurn, hpBandLabel, isGroupComplete, isPresent, momentTags, positionPhrase, sideGroup, stateAtSeq, turnLineEntries } from './combatEvents';
import type { TurnLine } from './combatEvents';
import { normalizeCombatConfig } from '../../types';
import type {
    ChatMessage, CombatEvent, CombatFlourish, CombatNarrationCadence, CombatNarrationLength, CombatSession, CombatState, CombatTerrainLabels,
    CombatTile, Combatant, NPCEntry,
} from '../../types';

export type BeatDirectiveOptions = {
    length?: CombatNarrationLength;
    opening?: boolean;
    ending?: boolean;
    setPiece?: boolean;
    flourish?: boolean;
};

const LOCKED_RULE = 'Locked: every listed event happens, in the listed order, with the listed result. Add no other attacks, hits, misses, wounds that would matter, deaths, falls, escapes, surrenders, arrivals or changes of position. State no numbers. Settle nothing about what happens next.';
const FREE_RULE = 'Free, and wanted: how each blow looked, sounded and felt; what the fighters shout, mutter, taunt and curse; pain, fear, anger and bravado; the place itself, using the terrain named here; allies and enemies reacting to each other. Describe a wound only as far as the listed condition (hurt, badly hurt, down) supports.';
const SHAPE_RULE = 'Shape: action first, then the people. Lead each moment with what was done, then the reaction of whoever it was done to and whoever saw it. Give enemies and allies lines of speech in their own voices, from the Voices notes and their character notes. Coarse language is welcome where it fits the speaker and the tone this story has already set.';
const PC_RULE = 'The player character: describe what they do. Do not invent speech, thoughts or decisions for them.';
const FLOURISH_RULE = 'Where the player gave their own description under an event, honour its manner and quote any speech in it, but the listed result stands even if the description claims otherwise.';
const STAY_RULE = 'This reply is a combat beat: no one leaves this place, and you add no hidden comment or movement tag of any kind.';
const FRESH_RULE ='Freshness: do not reuse an opening, image or insult from the earlier beats of this fight.';
const TAG_RULE = 'A note in square brackets after an event marks a moment to give weight to; do not repeat the note itself.';
const OPENING_RULE = 'This is the opening of the fight: set the scene, show the sides sizing each other up, and let the first words be thrown.';
const ENDING_RULE = 'This is the end of the fight: give the moment after, the breath, the silence or the noise, and what the survivors do with their hands, without deciding what happens next in the story.';

const LENGTH_TEXT: Readonly<Record<CombatNarrationLength, string>> = {
    brief: 'Length: two to four sentences.',
    standard: 'Length: one or two paragraphs, roughly 80 to 160 words.',
    rich: 'Length: two to four paragraphs, roughly 160 to 320 words.',
};

const STEP_UP: Readonly<Record<CombatNarrationLength, CombatNarrationLength>> = { brief: 'standard', standard: 'rich', rich: 'rich' };

export function beatDirective(opts: BeatDirectiveOptions = {}): string {
    const base = opts.length ?? 'standard';
    const stepped = opts.setPiece === true || opts.opening === true || opts.ending === true;
    const length = stepped ? STEP_UP[base] : base;
    const scale = stepped && base === 'rich'
        ? 'Aim for the upper end.'
        : 'Scale to the content: when only one or two events are listed, stay at the lower end.';
    return [
        LOCKED_RULE,
        STAY_RULE,
        FREE_RULE,
        SHAPE_RULE,
        opts.flourish ? `${PC_RULE} ${FLOURISH_RULE}` : PC_RULE,
        FRESH_RULE,
        TAG_RULE,
        opts.opening ? OPENING_RULE : '',
        opts.ending ? ENDING_RULE : '',
        `${LENGTH_TEXT[length]} ${scale}`,
    ].filter(Boolean).join('\n');
}

export const BEAT_TRACKING_LABEL = 'combat-beat';
export const PARLEY_REPLY_TRACKING_LABEL = 'combat-parley-reply';

export type BeatRange = { fromSeq: number; toSeq: number };

type BeatJob = BeatRange & { sessionId: string; campaignId: string; block: string; directive?: string; attemptId?: string };

export type BeatBlockExtras = {
    npcLedger?: readonly NPCEntry[];
    flourishes?: readonly CombatFlourish[];
};

export const FIGHT_MANNERS: readonly string[] = [
    'sneering, overconfident',
    'grim, silent',
    'jittery, talks too much',
    'cold, professional',
    'loud, boastful',
    'snarling, feral',
    'nervous, eager to impress',
    'bored, contemptuous',
    'zealous, preaching',
    'cocky, showboating',
    'weary, bitter',
    'giggling, unhinged',
    'furious, red-faced',
    'calm, almost polite',
    'cruel, mocking',
    'proud, formal',
    'desperate, cornered',
    'sullen, resentful',
    'theatrical, grandiose',
    'cautious, calculating',
    'foul-mouthed, brawling',
    'terse, soldierly',
    'hungry, predatory',
    'scared but stubborn',
    'smug, sarcastic',
    'wild-eyed, reckless',
];

function hashText(text: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

function baseName(name: string): string {
    return name.replace(/\s+\d+$/, '').trim().toLowerCase();
}

export function fallbackManner(state: CombatState, id: string): string {
    const c = state.combatants[id];
    if (!c) return FIGHT_MANNERS[0];
    const base = baseName(c.name);
    const kin = Object.values(state.combatants)
        .filter(o => o.side !== 'player' && baseName(o.name) === base)
        .map(o => o.id)
        .sort();
    const ordinal = Math.max(0, kin.indexOf(id));
    const start = hashText(`${state.rngSeed}:${base}`) % FIGHT_MANNERS.length;
    return FIGHT_MANNERS[(start + ordinal * 7) % FIGHT_MANNERS.length];
}

function cleanLine(text: string | undefined): string {
    return (text ?? '').replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

export function mannerOf(state: CombatState, c: Combatant): string {
    return cleanLine(c.manner) || fallbackManner(state, c.id);
}

function ledgerVoice(npc: NPCEntry | undefined): string {
    if (!npc) return '';
    const voice = cleanLine(npc.voice);
    const personality = cleanLine(npc.personality);
    if (!voice && !personality) return '';
    const v = clip(voice, personality ? 80 : 160);
    const p = personality ? clip(personality, Math.max(40, 160 - v.length)) : '';
    return [v ? `voice: ${v}` : '', p ? `personality: ${p}` : ''].filter(Boolean).join('; ');
}

export const MAX_VOICE_LINES = 6;

function involvedIds(state: CombatState, events: readonly CombatEvent[]): Set<string> {
    const ids = new Set<string>();
    for (const e of events) {
        if (e.actorId) ids.add(e.actorId);
        if (e.targetId) ids.add(e.targetId);
        if (e.type === 'combat_started') {
            const listed = Array.isArray(e.data.combatants) ? e.data.combatants : [];
            const named = listed.map(x => (x && typeof x === 'object' ? (x as { id?: unknown }).id : undefined)).filter((x): x is string => typeof x === 'string');
            for (const id of named.length > 0 ? named : state.order) ids.add(id);
        }
    }
    return ids;
}

export function voiceLines(state: CombatState, log: readonly CombatEvent[], range: BeatRange, ledger: readonly NPCEntry[] = []): string[] {
    const involved = involvedIds(state, rangeEvents(log, range));
    const atEnd = stateAtSeq(state, log, range.toSeq);
    const voiced = (c: Combatant | undefined): c is Combatant => !!c && c.side !== 'player' && !c.summonerId;
    const first = state.order.map(id => state.combatants[id]).filter((c): c is Combatant => voiced(c) && involved.has(c.id));
    const others = state.order
        .map(id => state.combatants[id])
        .filter((c): c is Combatant => voiced(c) && !involved.has(c.id) && atEnd.combatants[c.id]?.status === 'up');
    return [...first, ...others]
        .slice(0, MAX_VOICE_LINES)
        .map(c => {
            const role = c.side;
            const npc = c.npcId ? ledger.find(n => n.id === c.npcId) : undefined;
            const voice = ledgerVoice(npc);
            return voice ? `- ${c.name} (${role}) — ${voice}` : `- ${c.name} (${role}) — manner: ${mannerOf(state, c)}`;
        });
}

export function neutraliseFlourish(text: string): string {
    return text.replace(/[\r\n]+/g, ' ').replace(/["“”]/g, '\'').replace(/\s+/g, ' ').trim();
}

export const FLOURISH_LABEL = 'Player\'s description (manner only; the result above stands):';

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

export function beatLineEntries(state: CombatState, log: readonly CombatEvent[], range: BeatRange, opts: { tags?: boolean } = {}): TurnLine[] {
    const atEnd = stateAtSeq(state, log, range.toSeq);
    const tags = opts.tags ? momentTags(state, log, range.toSeq) : undefined;
    return groupEventsByTurn(rangeEvents(log, range)).flatMap(group => turnLineEntries(group, atEnd, { numbers: false, ...(tags ? { tags } : {}) }));
}

export function beatLines(state: CombatState, log: readonly CombatEvent[], range: BeatRange, opts: { tags?: boolean } = {}): string[] {
    return beatLineEntries(state, log, range, opts).map(l => l.text);
}

export function rosterLines(state: CombatState, log: readonly CombatEvent[], range: BeatRange, opts: { bandChange?: boolean } = {}): string[] {
    const atEnd = stateAtSeq(state, log, range.toSeq);
    const atStart = opts.bandChange ? stateAtSeq(state, log, range.fromSeq - 1) : null;
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
            const before = atStart?.combatants[c.id];
            const band = hpBandLabel(c);
            const was = before && isPresent(before) && band !== 'fled' && band !== 'yielded' ? hpBandLabel(before) : band;
            return `- ${c.name} (${role})${look}: ${was !== band ? `${was} → ${band}` : band}${where ? `, ${where}` : ''}`;
        });
}

const TERRAIN_WORDS: ReadonlyArray<[CombatTile, keyof CombatTerrainLabels, string]> = [
    ['wall', 'wall', 'walls'],
    ['cover', 'cover', 'cover'],
    ['difficult', 'difficult', 'difficult ground'],
    ['hazard', 'hazard', 'hazard'],
];

export function terrainLine(state: CombatState): string | null {
    const grid = state.grid;
    if (!grid?.labels) return null;
    const present = new Set(grid.tiles);
    const parts = TERRAIN_WORDS
        .filter(([tile, key]) => present.has(tile) && cleanLine(grid.labels?.[key]))
        .map(([, key, word]) => `${clip(cleanLine(grid.labels?.[key]), 40)} (${word})`);
    return parts.length > 0 ? `Terrain: ${parts.join(', ')}.` : null;
}

function flourishesIn(range: BeatRange, flourishes: readonly CombatFlourish[] | undefined): CombatFlourish[] {
    return (flourishes ?? []).filter(f => f.seq >= range.fromSeq && f.seq <= range.toSeq && neutraliseFlourish(f.text));
}

export function buildCombatBlock(state: CombatState, log: readonly CombatEvent[], range: BeatRange, extras: BeatBlockExtras = {}): string {
    const roster = rosterLines(state, log, range, { bandChange: true });
    const voices = voiceLines(state, log, range, extras.npcLedger);
    const entries = beatLineEntries(state, log, range, { tags: true });
    const notes = new Map<number, string[]>();
    for (const f of flourishesIn(range, extras.flourishes)) {
        const index = entries.findIndex(e => e.seq >= f.seq);
        const at = index === -1 ? entries.length - 1 : index;
        if (at < 0) continue;
        notes.set(at, [...(notes.get(at) ?? []), `   ${FLOURISH_LABEL} "${neutraliseFlourish(f.text)}"`]);
    }
    const lines = entries.flatMap((entry, i) => [`${i + 1}. ${entry.text}`, ...(notes.get(i) ?? [])]);
    const terrain = terrainLine(state);
    return [
        '[COMBAT BEAT — resolved by the game engine]',
        ...(terrain ? [terrain] : []),
        'Combatants:',
        ...roster,
        ...(voices.length > 0 ? ['Voices:', ...voices] : []),
        'Events, in order:',
        ...lines,
    ].join('\n');
}

export function directiveForRange(session: CombatSession, range: BeatRange, cadence: CombatNarrationCadence, length: CombatNarrationLength): string {
    const events = rangeEvents(session.log, range);
    return beatDirective({
        length,
        opening: events.some(e => e.type === 'combat_started'),
        ending: events.some(e => e.type === 'combat_ended'),
        setPiece: cadence === 'end',
        flourish: flourishesIn(range, session.flourishes).length > 0,
    });
}

export function stripBeatText(text: string): string {
    const withoutMovement = text.replace(/<!--\s*MOVEMENT\b[\s\S]*?(?:-->|$)/gi, '');
    return extractAndStripSceneStakes(withoutMovement).displayText.replace(/^Scene\s*#\d+\s*\|?\s*/i, '').trim();
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
        userMessage: existing.combatParley ? block : `${block}\n\n${existing.combatBeat.directive ?? beatDirective()}`,
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
        combatBeat: { sessionId: job.sessionId, fromSeq: job.fromSeq, toSeq: job.toSeq, block: job.block, ...(job.directive ? { directive: job.directive } : {}) },
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
    const store = useAppStore.getState();
    const length = normalizeCombatConfig(store.context?.combatConfig).narrationLength;
    const extras: BeatBlockExtras = { npcLedger: store.npcLedger ?? [], flourishes: session.flourishes ?? [] };
    for (const range of ranges) {
        queuedThrough.set(sessionId, range.toSeq);
        if (beatLines(session.state, session.log, range).length === 0) continue;
        queue.push({
            ...range,
            sessionId,
            campaignId,
            block: buildCombatBlock(session.state, session.log, range, extras),
            directive: directiveForRange(session, range, cadence, length),
        });
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
