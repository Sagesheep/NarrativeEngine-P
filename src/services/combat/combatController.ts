import {
    applyAction, buildPcCombatant, createCombat, currentActorId, stepEngine,
} from '@narrative/engine';
import type { AbilityKey, AttackRange, CombatantSpec, PcCombatantInput, WeaponQuality } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';
import { commitPendingTurn, findPendingCommitMessage } from '../turn/pendingCommit';
import { api } from '../llm/apiClient';
import { ratingToIndexImportance } from '../archive-memory/importanceRater';
import { toast } from '../../components/Toast';
import { uid } from '../../utils/uid';
import { t } from '../../i18n';
import { normalizeCombatConfig } from '../../types';
import type {
    CharacterProfile, ChatMessage, CombatAction, CombatNarrationCadence, CombatEvent, CombatProposal, CombatSession,
    CombatState, Combatant, GameContext, InventoryItem, NPCEntry, ProposedCombatant,
} from '../../types';
import { groupEventsByTurn, hpBandLabel, isGroupComplete, turnLines } from './combatEvents';
import { compendiumFor, type CompendiumLookupState } from './compendiumLookup';
import { queueCombatNarration, waitForCombatNarration } from './combatNarration';
import { hasEnemy } from './combatProposal';
import { makeCombatNote, COMBAT_DECLINED_TEXT } from './combatTurnNotes';
import { markProposedMessage } from './combatCommitHooks';

export const COMBAT_LOG_NAME = 'combat-log';
export const COMBAT_RESULT_NAME = 'combat-result';
export const COMBAT_ENCOUNTER_RATING = 4;

type Store = ReturnType<typeof useAppStore.getState>;

const MAX_ENGINE_STEPS = 2000;

let finishing: Promise<void> | null = null;
let starting = false;
let stepping: Promise<void> | null = null;
let stepDelayMs = 150;
let skipSteps = false;

export function equippedWeapon(items: readonly InventoryItem[] | undefined): InventoryItem | undefined {
    return (items ?? []).find(i => i.equipped && i.category === 'weapon');
}

export function weaponRange(range: InventoryItem['range']): AttackRange | undefined {
    if (range === 'Close') return 'close';
    if (range === 'Reach') return 'reach';
    if (range === 'Ranged') return 'ranged';
    return undefined;
}

export function buildPcInput(store: Pick<Store, 'context' | 'inventoryItems'>): PcCombatantInput | null {
    const context = store.context;
    const sheet = context.combatSheet;
    if (!sheet) return null;
    const config = normalizeCombatConfig(context.combatConfig);
    const profile = context.characterProfileData;
    const weapon = equippedWeapon(context.inventoryItems ?? store.inventoryItems);
    return {
        name: profile?.name?.trim() || 'You',
        sheet,
        hpCurrent: profile?.hp?.current,
        weapon: weapon
            ? {
                name: weapon.name,
                ...(weapon.quality ? { quality: weapon.quality as WeaponQuality } : {}),
                ...(weapon.scalingStat ? { scalingStat: weapon.scalingStat as AbilityKey } : {}),
                ...(weaponRange(weapon.range) ? { range: weaponRange(weapon.range) } : {}),
            }
            : null,
        ...(config.defaultWeaponDie ? { defaultWeaponDie: config.defaultWeaponDie } : {}),
    };
}

export function canPostCombatMessages(store: Pick<Store, 'messages' | 'pipelinePhase'>): boolean {
    return store.pipelinePhase === 'idle' && !findPendingCommitMessage(store.messages);
}

function postMessage(name: string, content: string): ChatMessage {
    const msg: ChatMessage = { id: uid(), role: 'system', name, content, timestamp: Date.now() };
    useAppStore.getState().addMessage(msg);
    return msg;
}

export function postPendingLog(session: CombatSession): CombatSession {
    const after = session.postedThroughSeq ?? 0;
    const pending = session.log.filter(e => e.seq > after);
    if (pending.length === 0) return session;
    let postedThrough = after;
    let posted = 0;
    for (const group of groupEventsByTurn(pending)) {
        if (!isGroupComplete(group, session.state)) break;
        const lines = turnLines(group, session.state, { numbers: true });
        postedThrough = Math.max(postedThrough, ...group.events.map(e => e.seq));
        if (lines.length === 0) continue;
        postMessage(COMBAT_LOG_NAME, lines.join('\n'));
        posted++;
    }
    if (posted > 0) debouncedSaveCampaignState();
    return postedThrough === after ? session : { ...session, postedThroughSeq: postedThrough };
}

function cadence(): CombatNarrationCadence {
    return normalizeCombatConfig(useAppStore.getState().context.combatConfig).narrationCadence;
}

function storeSession(session: CombatSession): void {
    useAppStore.getState().setCombatSession(session);
}

function commitSession(session: CombatSession): CombatSession {
    const posted = postPendingLog(session);
    storeSession(posted);
    queueCombatNarration(posted, cadence(), posted.state.outcome !== null);
    return posted;
}

export function isEngineTurn(state: CombatState): boolean {
    if (!state || state.outcome || !Array.isArray(state.order) || !state.combatants) return false;
    const id = currentActorId(state);
    const actor = id ? state.combatants[id] : undefined;
    return !!actor && (actor.controller !== 'player' || actor.status !== 'up');
}

export function setCombatStepDelay(ms: number): void {
    stepDelayMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function skipEngineAnimation(): void {
    skipSteps = true;
}

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function driveEngineTurns(sessionId: string, campaignId: string, collected: CombatEvent[]): Promise<void> {
    useAppStore.getState().setCombatBusy(true);
    try {
        for (let i = 0; i < MAX_ENGINE_STEPS; i++) {
            const live = useAppStore.getState();
            if (live.activeCampaignId !== campaignId) return;
            const session = live.combatSession;
            if (!session || session.state.id !== sessionId || !isEngineTurn(session.state)) return;
            const step = stepEngine(session.state);
            if (!step) return;
            collected.push(...step.events);
            const next = commitSession({ ...session, state: step.state, log: [...session.log, ...step.events] });
            if (next.state.outcome) return;
            if (stepDelayMs > 0 && !skipSteps && isEngineTurn(next.state)) await wait(stepDelayMs);
        }
    } finally {
        skipSteps = false;
        useAppStore.getState().setCombatBusy(false);
    }
}

export async function runEngineTurnsStepped(): Promise<CombatEvent[]> {
    while (stepping) await stepping;
    const store = useAppStore.getState();
    const session = store.combatSession;
    const campaignId = store.activeCampaignId;
    if (!session || !campaignId || !isEngineTurn(session.state)) return [];
    const collected: CombatEvent[] = [];
    stepping = driveEngineTurns(session.state.id, campaignId, collected);
    try {
        await stepping;
    } finally {
        stepping = null;
    }
    const after = useAppStore.getState();
    if (after.activeCampaignId === campaignId && after.combatSession?.state.id === session.state.id && after.combatSession.state.outcome) {
        await finishCombat();
    }
    return collected;
}

export function isEngineStepping(): boolean {
    return stepping !== null;
}

export function declineProposal(): void {
    const store = useAppStore.getState();
    const proposal = store.combatProposal;
    if (!proposal) return;
    store.setCombatProposal(null);
    if (proposal.source === 'tool') {
        store.updateContext({ combatDeclined: makeCombatNote(COMBAT_DECLINED_TEXT) });
    }
}

export function stageProposal(proposal: CombatProposal): void {
    markProposedMessage(proposal.messageId);
    useAppStore.getState().setCombatProposal(proposal);
}

export function rangeForAttack(attack: ProposedCombatant['attack']): AttackRange | undefined {
    if (attack === 'melee') return 'close';
    if (attack === 'ranged') return 'ranged';
    return undefined;
}

export function buildCombatantSpecs(combatants: readonly ProposedCombatant[], lookup: CompendiumLookupState): CombatantSpec[] {
    return combatants.map(c => {
        const range = rangeForAttack(c.attack);
        const { overlay } = compendiumFor(c, lookup);
        return {
            name: c.name,
            side: c.side,
            tier: c.tier,
            ...(c.archetype ? { archetype: c.archetype } : {}),
            ...(c.npcId ? { npcId: c.npcId } : {}),
            ...(c.species ? { species: c.species } : {}),
            ...(c.look ? { look: c.look } : {}),
            ...(range ? { range } : {}),
            ...(overlay ? { template: overlay } : {}),
        };
    });
}

export function newMapSeed(): number {
    return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

export async function startFromProposal(proposal: CombatProposal, seed?: number): Promise<boolean> {
    if (starting || useAppStore.getState().combatSession) return false;
    if (!hasEnemy(proposal.combatants)) {
        toast.warning(t('combat.toast.needEnemy'));
        return false;
    }
    starting = true;
    try {
        await commitPendingTurn().catch(e => console.warn('[combat] commit before start failed:', e));
        const store = useAppStore.getState();
        if (store.combatSession) return false;
        if (!canPostCombatMessages(store)) {
            toast.warning(t('combat.toast.busy'));
            return false;
        }
        const pcInput = buildPcInput(store);
        if (!pcInput || store.context.combatModeActive !== true) return false;
        const config = normalizeCombatConfig(store.context.combatConfig);
        const fightSeed = seed ?? Math.floor(Math.random() * 0xffffffff);
        const pc = buildPcCombatant(pcInput);
        const created = createCombat({
            id: uid(),
            combatants: buildCombatantSpecs(proposal.combatants, store),
            ...(config.mookJitterRange !== undefined ? { jitterRange: config.mookJitterRange } : {}),
            ...(proposal.map ? { map: proposal.map } : {}),
            mapSeed: proposal.mapSeed ?? newMapSeed(),
        }, pc, fightSeed);
        const session: CombatSession = {
            state: created.state,
            log: created.events,
            narratedThroughSeq: 0,
            postedThroughSeq: 0,
            startedAtMessageId: proposal.messageId,
            reason: proposal.reason,
            ...(proposal.map ? { map: proposal.map } : {}),
        };
        commitSession(session);
        store.setCombatProposal(null);
        if (store.context.combatDeclined) store.updateContext({ combatDeclined: undefined });
        await runEngineTurnsStepped();
        if (useAppStore.getState().combatSession?.state.outcome) await finishCombat();
        return true;
    } finally {
        starting = false;
    }
}

export function playerActorId(state: CombatState): string | null {
    const id = currentActorId(state);
    if (!id) return null;
    const actor = state.combatants[id];
    return actor && actor.controller === 'player' && actor.status === 'up' ? id : null;
}

export async function playerAction(action: CombatAction): Promise<CombatEvent[]> {
    const store = useAppStore.getState();
    const session = store.combatSession;
    if (!session || session.state.outcome || finishing || store.combatBusy || stepping) return [];
    if (isEngineTurn(session.state)) {
        void runEngineTurnsStepped();
        return [];
    }
    if (playerActorId(session.state) !== action.actorId) return [];
    const applied = applyAction(session.state, action);
    if (applied.events.some(e => e.type === 'rejected')) return [];
    const next = commitSession({ ...session, state: applied.state, log: [...session.log, ...applied.events] });
    const events = [...applied.events];
    if (next.state.outcome) {
        await finishCombat();
        return events;
    }
    if (isEngineTurn(next.state)) events.push(...await runEngineTurnsStepped());
    return events;
}

export async function abortCombat(): Promise<void> {
    const session = useAppStore.getState().combatSession;
    if (!session || finishing) return;
    if (!session.state.outcome) {
        const seq = session.state.eventSeq + 1;
        const event: CombatEvent = {
            seq, round: session.state.round, turn: session.state.turnCount ?? 0, type: 'combat_ended', data: { outcome: 'aborted' }, text: 'The fight is broken off.',
        };
        commitSession({
            ...session,
            state: { ...session.state, outcome: 'aborted', eventSeq: seq },
            log: [...session.log, event],
        });
    }
    await finishCombat();
}

export function conditionForCombatant(c: Combatant): NPCEntry['condition'] {
    if (c.status !== 'up' || c.hp <= 0) return c.side === 'enemy' ? 'dead' : 'critical';
    const ratio = c.hp / Math.max(1, c.maxHp);
    if (ratio > 0.5) return 'healthy';
    if (ratio >= 0.25) return 'wounded';
    return 'critical';
}

function describe(c: Combatant): string {
    if (c.status !== 'up') return c.side === 'player' || c.side === 'ally' ? `${c.name} (unconscious)` : `${c.name} (down)`;
    return `${c.name} (${hpBandLabel(c)})`;
}

export function buildResultText(state: CombatState): string {
    const all = state.order.map(id => state.combatants[id]).filter(Boolean);
    const down = all.filter(c => c.status !== 'up');
    const hurt = all.filter(c => c.status === 'up' && c.hp < c.maxHp);
    const outcome = state.outcome ?? 'aborted';
    return [
        `Combat ended: ${outcome}.`,
        down.length > 0 ? `Down: ${down.map(c => c.name).join(', ')}.` : 'No one is down.',
        hurt.length > 0 ? `Hurt: ${hurt.map(c => `${c.name} (${hpBandLabel(c)})`).join(', ')}.` : '',
    ].filter(Boolean).join(' ');
}

export function buildAftermathText(session: CombatSession): string {
    const state = session.state;
    const all = state.order.map(id => state.combatants[id]).filter(Boolean);
    const casualties = all.filter(c => c.status !== 'up');
    const survivors = all.filter(c => c.status === 'up');
    const lines = [
        session.reason ? `Fight: ${session.reason}` : '',
        `Outcome: ${state.outcome ?? 'aborted'}.`,
        `Casualties: ${casualties.length > 0 ? casualties.map(describe).join(', ') : 'none'}.`,
        `Survivors: ${survivors.length > 0 ? survivors.map(describe).join(', ') : 'none'}.`,
    ];
    if (state.outcome === 'defeat') {
        lines.push('The party is unconscious and at the victors\' mercy. What the victors do next is your decision as the story AI.');
    }
    if (state.outcome === 'aborted') lines.push('The fight was broken off before it was decided.');
    return lines.filter(Boolean).join('\n');
}

function writeBackPc(store: Store, state: CombatState): void {
    const pc = Object.values(state.combatants).find(c => c.side === 'player');
    const profile: CharacterProfile | undefined = store.context.characterProfileData;
    if (!pc || !profile) return;
    const current = pc.status === 'up' ? Math.max(1, pc.hp) : 1;
    const next: CharacterProfile = { ...profile, hp: { current, max: profile.hp?.max ?? pc.maxHp } };
    store.setCharacterProfileData(next);
}

function writeBackNpcs(store: Store, state: CombatState): void {
    for (const c of Object.values(state.combatants)) {
        if (!c.npcId) continue;
        if (!store.npcLedger.some(n => n.id === c.npcId)) continue;
        store.updateNPC(c.npcId, { condition: conditionForCombatant(c) });
    }
}

export function buildArchiveBody(session: CombatSession, messages: readonly ChatMessage[], resultText: string): string {
    const beats = messages
        .filter(m => m.combatBeat?.sessionId === session.state.id && !m.combatBeat.failed && m.content.trim())
        .map(m => m.content.trim());
    const body = beats.length > 0 ? beats : groupEventsByTurn(session.log).flatMap(g => turnLines(g, session.state, { numbers: true }));
    return [...body, resultText].join('\n\n');
}

async function archiveFight(campaignId: string, session: CombatSession, resultMessageId: string, resultText: string): Promise<void> {
    try {
        const store = useAppStore.getState();
        const body = buildArchiveBody(session, store.messages, resultText);
        const input = `[Combat] ${session.reason || 'Engine-resolved fight'}`;
        const appended = await api.archive.append(campaignId, input, body, ratingToIndexImportance(COMBAT_ENCOUNTER_RATING));
        const sceneId = appended?.sceneId;
        if (!sceneId) {
            console.warn('[combat] archive append returned no scene id; the fight was not archived');
            return;
        }
        if (useAppStore.getState().activeCampaignId !== campaignId) return;
        useAppStore.setState(live => ({ messages: live.messages.map(m => m.id === resultMessageId ? { ...m, sceneId } : m) }));
        debouncedSaveCampaignState();
        const [index, timeline, chapters] = await Promise.all([
            api.archive.getIndex(campaignId),
            api.timeline.get(campaignId),
            api.chapters.list(campaignId),
        ]);
        if (useAppStore.getState().activeCampaignId !== campaignId) return;
        const live = useAppStore.getState();
        live.setArchiveIndex(index);
        live.setTimeline(timeline);
        live.setChapters(chapters);
    } catch (e) {
        console.warn('[combat] archive append failed; the fight result is kept:', e);
    }
}

async function runFinish(): Promise<void> {
    const initial = useAppStore.getState();
    const campaignId = initial.activeCampaignId;
    if (!initial.combatSession || !campaignId) return;
    initial.setCombatBusy(true);
    try {
        const pending = initial.combatSession;
        queueCombatNarration(pending, cadence(), true);
        await waitForCombatNarration();
        const store = useAppStore.getState();
        if (store.activeCampaignId !== campaignId || !store.combatSession) return;
        const session = store.combatSession;
        const state = session.state;
        writeBackPc(store, state);
        writeBackNpcs(store, state);
        const resultText = buildResultText(state);
        const result = postMessage(COMBAT_RESULT_NAME, resultText);
        const aftermath = makeCombatNote(buildAftermathText(session));
        useAppStore.getState().updateContext({ combatAftermath: aftermath } as Partial<GameContext>);
        debouncedSaveCampaignState();
        await archiveFight(campaignId, session, result.id, resultText);
        if (useAppStore.getState().activeCampaignId !== campaignId) return;
        useAppStore.getState().setCombatSession(null);
        debouncedSaveCampaignState();
    } finally {
        useAppStore.getState().setCombatBusy(false);
    }
}

export function finishCombat(): Promise<void> {
    if (finishing) return finishing;
    finishing = runFinish().finally(() => { finishing = null; });
    return finishing;
}

export function resumeStoredSession(): void {
    const session = useAppStore.getState().combatSession;
    if (!session) return;
    if (session.state.outcome) {
        void finishCombat();
        return;
    }
    if (isEngineTurn(session.state)) void runEngineTurnsStepped();
}
