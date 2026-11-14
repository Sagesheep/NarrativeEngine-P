import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];

vi.mock('../../turn/pendingCommit', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../turn/pendingCommit')>();
    return {
        ...actual,
        commitPendingTurn: vi.fn(async () => { order.push('commit'); }),
    };
});

vi.mock('../combatNarration', () => ({
    queueCombatNarration: vi.fn(() => []),
    waitForCombatNarration: vi.fn(async () => { order.push('narration-flushed'); }),
    abortCombatNarration: vi.fn(),
    rewriteCombatBeat: vi.fn(),
}));

vi.mock('../../llm/apiClient', () => ({
    api: {
        archive: {
            append: vi.fn(async () => { order.push('archive'); return { sceneId: '042' }; }),
            getIndex: vi.fn(async () => []),
        },
        timeline: { get: vi.fn(async () => []) },
        chapters: { list: vi.fn(async () => []) },
    },
}));

import { useAppStore } from '../../../store/useAppStore';
import { ratingToIndexImportance } from '../../archive-memory/importanceRater';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { commitPendingTurn } from '../../turn/pendingCommit';
import { api } from '../../llm/apiClient';
import { queueCombatNarration } from '../combatNarration';
import {
    abortCombat, buildPcInput, conditionForCombatant, declineProposal, isEngineStepping, isEngineTurn, playerAction, playerActorId,
    resumeStoredSession, setCombatStepDelay, stageProposal, startFromProposal,
} from '../combatController';
import { applyAction, reachable, runEngineTurns } from '@narrative/engine';
import { requestManualCombat } from '../combatManualStart';
import { settleCombatNotesOnCommit, resetProposedMessages } from '../combatCommitHooks';
import { buildCombatNoteRegistry, renderCombatNotes } from '../combatTurnNotes';
import { isRewindDeleteLocked, isSwipeLockedByCombat } from '../combatLocks';
import { proposalIsOrphaned } from '../../../components/combat/useCombatLifecycle';
import type { ChatMessage, CombatProposal, CombatSheet, GameContext } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };

const gm: ChatMessage = { id: 'gm-1', role: 'assistant', content: 'Bandits!', timestamp: 100 };

function proposal(extra: Partial<CombatProposal> = {}): CombatProposal {
    return {
        id: 'p1',
        messageId: 'gm-1',
        combatants: [{ name: 'Bandit', side: 'enemy', tier: 'minion' }, { name: 'Captain Vey', side: 'enemy', tier: 'minion', npcId: 'npc-1' }],
        reason: 'Ambush on the road',
        source: 'tool',
        ...extra,
    };
}

function seed(contextPatch: Partial<GameContext> = {}) {
    const base = useAppStore.getState().context;
    const context = {
        ...base,
        combatModeActive: true,
        combatSheet: sheet,
        combatConfig: { ...base.combatConfig, narrationCadence: 'side' },
        characterProfileData: { ...base.characterProfileData, name: 'Kira', hp: { current: 28, max: 28 } },
        inventoryItems: [],
        ...contextPatch,
    } as GameContext;
    useAppStore.setState({
        activeCampaignId: 'camp-1',
        messages: [{ id: 'u1', role: 'user', content: 'I walk on.', timestamp: 50 }, gm],
        context,
        characterProfileData: context.characterProfileData,
        npcLedger: [{ id: 'npc-1', name: 'Captain Vey' } as never],
        pipelinePhase: 'idle',
        combatSession: null,
        combatProposal: null,
        combatBusy: false,
    });
}

beforeEach(() => {
    setCombatStepDelay(0);
    order.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    resetProposedMessages();
    seed();
});

afterEach(() => {
    cancelPendingSaves();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const logMessages = () => useAppStore.getState().messages.filter(m => m.role === 'system' && m.name === 'combat-log');

describe('T3 proposal lifecycle', () => {
    it('rule 1: a proposal is tied to its GM message', () => {
        stageProposal(proposal());
        expect(useAppStore.getState().combatProposal?.messageId).toBe('gm-1');
    });

    it('rule 2: a pending proposal locks swipes on its message only', () => {
        stageProposal(proposal());
        expect(isSwipeLockedByCombat('gm-1')).toBe(true);
        expect(isSwipeLockedByCombat('u1')).toBe(false);
        declineProposal();
        expect(isSwipeLockedByCombat('gm-1')).toBe(false);
    });

    it('rule 3 + A2: confirm commits the pending turn first, then creates the session, then clears the proposal', async () => {
        stageProposal(proposal());
        const origSet = useAppStore.getState().setCombatSession;
        useAppStore.setState({ setCombatSession: (s) => { order.push(s ? 'session' : 'session-cleared'); origSet(s); } });
        const ok = await startFromProposal(proposal(), 7);
        expect(ok).toBe(true);
        expect(order.slice(0, 2)).toEqual(['commit', 'session']);
        expect(useAppStore.getState().combatProposal).toBeNull();
        useAppStore.setState({ setCombatSession: origSet });
    });

    it('rule 4: decline clears the proposal and sets a one-turn note that the next turn carries and its commit clears', () => {
        stageProposal(proposal());
        declineProposal();
        const s = useAppStore.getState();
        expect(s.combatProposal).toBeNull();
        expect(s.context.combatDeclined?.text).toBe('The player declined engine-run combat. Resolve this confrontation in narration.');
        expect(renderCombatNotes(s.context)).toContain('declined engine-run combat');
        expect(buildCombatNoteRegistry(s.context)?.get('combat.notes')).toBeDefined();
        const noteTime = s.context.combatDeclined!.createdAt;
        settleCombatNotesOnCommit({ messageId: 'gm-1', messageTimestamp: noteTime - 1, sceneStakes: 'tense' });
        expect(useAppStore.getState().context.combatDeclined).toBeDefined();
        settleCombatNotesOnCommit({ messageId: 'gm-2', messageTimestamp: noteTime + 1, sceneStakes: 'calm' });
        expect(useAppStore.getState().context.combatDeclined).toBeUndefined();
    });

    it('rule 4: with no notes the default registry is used, so the payload is unchanged', () => {
        expect(buildCombatNoteRegistry(useAppStore.getState().context)).toBeUndefined();
    });

    it('rule 5: deleting or rewinding the message orphans the proposal', () => {
        expect(proposalIsOrphaned(proposal(), useAppStore.getState().messages)).toBe(false);
        expect(proposalIsOrphaned(proposal(), [])).toBe(true);
    });

    it('rule 7: the start_combat handler stages data only and never creates a session', async () => {
        const { resolveToolHandler } = await import('../../turn/toolRegistry');
        resolveToolHandler('start_combat')!({ arguments: JSON.stringify({ combatants: [{ name: 'X' }], reason: 'r' }), loreChunks: [], notebook: [], diceSystem: null });
        expect(useAppStore.getState().combatSession).toBeNull();
        expect(useAppStore.getState().combatProposal).toBeNull();
    });
});

describe('A2 ordering', () => {
    it('refuses to start while a turn is still pending commit', async () => {
        useAppStore.setState({ messages: [{ ...gm, pendingCommit: true, swipeSet: [{ id: 'v', text: 'x', sceneStakes: 'calm', tagPresent: false }] }] });
        const ok = await startFromProposal(proposal());
        expect(vi.mocked(commitPendingTurn)).toHaveBeenCalled();
        expect(ok).toBe(false);
        expect(useAppStore.getState().combatSession).toBeNull();
        expect(logMessages()).toHaveLength(0);
    });

    it('refuses to start while a story turn is streaming', async () => {
        useAppStore.setState({ pipelinePhase: 'generating' });
        expect(await startFromProposal(proposal())).toBe(false);
        expect(logMessages()).toHaveLength(0);
    });

    it('manual start (also used by the stakes offer) commits first and opens a manual card', async () => {
        const call = vi.fn(async () => { order.push('utility'); return '{"combatants":[{"name":"Wolf","tier":"minion"},{"name":"Wolf"}],"reason":"Wolves"}'; });
        const out = await requestManualCombat(call);
        expect(order.slice(0, 2)).toEqual(['commit', 'utility']);
        expect(out?.source).toBe('manual');
        expect(out?.combatants.map(c => c.name)).toEqual(['Wolf 1', 'Wolf 2']);
        expect(useAppStore.getState().combatProposal?.id).toBe(out?.id);
    });

    it('manual start opens an empty card when the utility call fails', async () => {
        const out = await requestManualCombat(async () => { throw new Error('offline'); });
        expect(out?.combatants).toEqual([]);
        expect(useAppStore.getState().combatProposal?.source).toBe('manual');
    });
});

describe('T4 controller', () => {
    it('starts a session, posts batched log lines and saves', async () => {
        await startFromProposal(proposal(), 11);
        const session = useAppStore.getState().combatSession!;
        expect(session.startedAtMessageId).toBe('gm-1');
        expect(session.reason).toBe('Ambush on the road');
        expect(session.log[0].type).toBe('combat_started');
        const logs = logMessages();
        expect(logs.length).toBeGreaterThan(0);
        expect(logs.every(m => !m.pendingCommit && !m.swipeSet)).toBe(true);
        expect(vi.mocked(queueCombatNarration)).toHaveBeenCalled();
        const pcTurn = playerActorId(session.state);
        expect(pcTurn === 'pc' || session.state.outcome !== null).toBe(true);
    });

    it('resolves a player action with no model call and stores the log', async () => {
        await startFromProposal(proposal(), 11);
        const before = useAppStore.getState().combatSession!;
        const events = await playerAction({ type: 'end_turn', actorId: 'pc' });
        expect(events.length).toBeGreaterThan(1);
        const after = useAppStore.getState().combatSession;
        if (after) expect(after.log.length).toBe(before.log.length + events.length);
        expect(vi.mocked(api.archive.append).mock.calls.length).toBeLessThanOrEqual(1);
    });

    it('stores the player\'s flourish against the action event and keeps it through a save and reload', async () => {
        await startFromProposal(proposal({ combatants: [{ name: 'Bandit', side: 'enemy', tier: 'minion', manner: 'sneering, overconfident' }] }), 11);
        const started = useAppStore.getState().combatSession!;
        expect(Object.values(started.state.combatants).find(c => c.name === 'Bandit')?.manner).toBe('sneering, overconfident');
        expect(playerActorId(started.state)).toBe('pc');
        const events = await playerAction({ type: 'defend', actorId: 'pc' }, 'I set my feet and grin "Try it."');
        const defend = events.find(e => e.type === 'defend')!;
        const session = useAppStore.getState().combatSession ?? started;
        expect(session.flourishes).toEqual([{ seq: defend.seq, text: 'I set my feet and grin "Try it."' }]);
        const { normalizeCombatSession } = await import('../../tables/combatTable');
        expect(normalizeCombatSession(JSON.parse(JSON.stringify(session)))?.flourishes).toEqual(session.flourishes);
        const queued = vi.mocked(queueCombatNarration).mock.calls.at(-1)?.[0];
        expect(queued?.flourishes).toEqual(session.flourishes);
    });

    it('ignores actions out of turn', async () => {
        await startFromProposal(proposal(), 11);
        const events = await playerAction({ type: 'defend', actorId: 'c1' });
        expect(events).toEqual([]);
    });

    it('blocks rewind and delete on every message while a session is active', async () => {
        await startFromProposal(proposal(), 11);
        expect(isRewindDeleteLocked({ role: 'user', name: undefined })).toBe(true);
        expect(isRewindDeleteLocked({ role: 'assistant', combatBeat: { sessionId: 's', fromSeq: 1, toSeq: 2 } }, null)).toBe(true);
        expect(isRewindDeleteLocked({ role: 'system', name: 'combat-result' }, null)).toBe(true);
        expect(isRewindDeleteLocked({ role: 'assistant' }, null)).toBe(false);
    });

    it('builds the PC from the first equipped weapon', () => {
        seed({ inventoryItems: [
            { id: 'a', name: 'Stick', qty: 1, category: 'misc', keywords: [], equipped: true, lastUsedScene: '0', importance: 1, notes: '' },
            { id: 'b', name: 'Rapier', qty: 1, category: 'weapon', keywords: [], equipped: true, lastUsedScene: '0', importance: 1, notes: '', quality: 'rare', scalingStat: 'DEX' },
        ] });
        const input = buildPcInput(useAppStore.getState())!;
        expect(input.weapon).toEqual({ name: 'Rapier', quality: 'rare', scalingStat: 'DEX' });
        seed();
        expect(buildPcInput(useAppStore.getState())!.weapon).toBeNull();
    });
});

describe('T7 ending', () => {
    it('maps remaining HP to ledger conditions', () => {
        const c = { hp: 10, maxHp: 10, status: 'up', side: 'enemy' } as never;
        expect(conditionForCombatant(c)).toBe('healthy');
        expect(conditionForCombatant({ ...(c as object), hp: 4 } as never)).toBe('wounded');
        expect(conditionForCombatant({ ...(c as object), hp: 2 } as never)).toBe('critical');
        expect(conditionForCombatant({ ...(c as object), hp: 0, status: 'down' } as never)).toBe('dead');
        expect(conditionForCombatant({ ...(c as object), hp: 0, status: 'down', side: 'ally' } as never)).toBe('critical');
    });

    it('aborting ends the fight: flush, HP write-back, NPC condition, result, aftermath, one archive scene stamped by id', async () => {
        const updateNPC = vi.fn();
        const origUpdate = useAppStore.getState().updateNPC;
        useAppStore.setState({ updateNPC });
        await startFromProposal(proposal(), 11);
        if (useAppStore.getState().combatSession) await abortCombat();
        const s = useAppStore.getState();
        expect(s.combatSession).toBeNull();
        expect(order).toContain('narration-flushed');
        expect(order.indexOf('narration-flushed')).toBeLessThan(order.indexOf('archive'));
        const resultMsg = s.messages.find(m => m.role === 'system' && m.name === 'combat-result')!;
        expect(resultMsg.content).toMatch(/^Combat ended: /);
        expect(resultMsg.sceneId).toBe('042');
        expect(vi.mocked(api.archive.append)).toHaveBeenCalledTimes(1);
        const [campaignId, input, body, importance] = vi.mocked(api.archive.append).mock.calls[0];
        expect(campaignId).toBe('camp-1');
        expect(input).toBe('[Combat] Ambush on the road');
        expect(body).toContain(resultMsg.content);
        expect(importance).toBe(ratingToIndexImportance(4));
        expect(updateNPC).toHaveBeenCalledWith('npc-1', expect.objectContaining({ condition: expect.any(String) }));
        expect(s.context.combatAftermath?.text).toContain('Outcome:');
        expect(s.characterProfileData.hp.current).toBeGreaterThanOrEqual(1);
        useAppStore.setState({ updateNPC: origUpdate });
    });

    it('keeps the fight result when the archive append fails', async () => {
        vi.mocked(api.archive.append).mockRejectedValueOnce(new Error('down'));
        await startFromProposal(proposal(), 11);
        if (useAppStore.getState().combatSession) await abortCombat();
        const s = useAppStore.getState();
        expect(s.combatSession).toBeNull();
        expect(s.messages.some(m => m.name === 'combat-result')).toBe(true);
    });

    it('a knockout defeat leaves the PC at 1 HP and tells the story AI the victors decide', async () => {
        seed({ characterProfileData: { ...useAppStore.getState().context.characterProfileData, name: 'Kira', hp: { current: 1, max: 28 } } });
        await startFromProposal(proposal({ combatants: Array.from({ length: 6 }, () => ({ name: 'Ogre', side: 'enemy' as const, tier: 'legendary' as const })) }), 3);
        for (let i = 0; i < 50 && useAppStore.getState().combatSession; i++) {
            await playerAction({ type: 'end_turn', actorId: 'pc' });
        }
        const s = useAppStore.getState();
        expect(s.combatSession).toBeNull();
        expect(s.context.combatAftermath?.text).toContain('Outcome: defeat.');
        expect(s.context.combatAftermath?.text).toContain('at the victors\' mercy');
        expect(s.characterProfileData.hp.current).toBe(1);
    });
});

describe('restart mid-fight (acceptance 4)', () => {
    it('a stored session reloads unchanged and the next action resolves exactly as without the restart', async () => {
        const { normalizeCombatRecord } = await import('../../tables/combatTable');
        await startFromProposal(proposal({ combatants: [{ name: 'Ogre', side: 'enemy', tier: 'elite' }] }), 21);
        const live = useAppStore.getState().combatSession!;
        const restored = normalizeCombatRecord(JSON.parse(JSON.stringify({ session: live }))).session!;
        expect(restored).toEqual(live);
        const to = reachable(live.state, 'pc')[0];
        const a = [...await playerAction({ type: 'move', actorId: 'pc', to }), ...await playerAction({ type: 'end_turn', actorId: 'pc' })];
        const afterA = useAppStore.getState().combatSession;
        useAppStore.setState({ combatSession: restored });
        const b = [...await playerAction({ type: 'move', actorId: 'pc', to }), ...await playerAction({ type: 'end_turn', actorId: 'pc' })];
        expect(a.length).toBeGreaterThan(2);
        expect(b).toEqual(a);
        expect(useAppStore.getState().combatSession?.state).toEqual(afterA?.state);
    });
});

describe('Phase 2 grid controller', () => {
    it('posts one log message per completed turn: a move updates the board but not the log', async () => {
        await startFromProposal(proposal({ combatants: [{ name: 'Ogre', side: 'enemy', tier: 'elite' }] }), 21);
        const live = useAppStore.getState().combatSession!;
        expect(playerActorId(live.state)).toBe('pc');
        const logsBefore = logMessages().length;
        const to = reachable(live.state, 'pc').find(p => p.cost === 3)!;
        await playerAction({ type: 'move', actorId: 'pc', to });
        const moved = useAppStore.getState().combatSession!;
        expect(moved.state.combatants.pc.position).toEqual({ x: to.x, y: to.y });
        expect(logMessages()).toHaveLength(logsBefore);
        await playerAction({ type: 'end_turn', actorId: 'pc' });
        const logs = logMessages();
        expect(logs.length).toBeGreaterThan(logsBefore);
        expect(logs[logsBefore].content).toMatch(/^Kira moves 3 squares( toward Ogre)?\.$/);
        expect(logs[logsBefore].content).not.toContain('ends the turn');
    });

    it('runs enemy turns without a model call and stops at the next player turn', async () => {
        await startFromProposal(proposal(), 11);
        await playerAction({ type: 'end_turn', actorId: 'pc' });
        const s = useAppStore.getState().combatSession;
        if (s) expect(playerActorId(s.state)).toBe('pc');
        expect(vi.mocked(api.archive.append).mock.calls.length).toBeLessThanOrEqual(1);
        expect(useAppStore.getState().combatBusy).toBe(false);
    });

    it('B6: applies each engine step to the stored session before waiting', async () => {
        await startFromProposal(proposal({ combatants: [{ name: 'Ogre', side: 'enemy', tier: 'elite' }, { name: 'Imp', side: 'enemy', tier: 'minion' }] }), 21);
        setCombatStepDelay(40);
        const before = useAppStore.getState().combatSession!;
        const run = playerAction({ type: 'end_turn', actorId: 'pc' });
        await vi.waitFor(() => {
            const live = useAppStore.getState().combatSession!;
            expect(isEngineStepping()).toBe(true);
            expect(useAppStore.getState().combatBusy).toBe(true);
            expect(live.log.length).toBeGreaterThan(before.log.length + 1);
        });
        await run;
        expect(isEngineStepping()).toBe(false);
    });

    it('B6: an enemy turn interrupted after its first action resumes after a reload with the same result', async () => {
        const { normalizeCombatRecord } = await import('../../tables/combatTable');
        await startFromProposal(proposal({ combatants: [{ name: 'Ogre', side: 'enemy', tier: 'elite' }, { name: 'Imp', side: 'enemy', tier: 'minion' }] }), 21);
        const start = useAppStore.getState().combatSession!;
        const pcDone = applyAction(start.state, { type: 'end_turn', actorId: 'pc' }).state;
        const expected = runEngineTurns(pcDone).state;
        setCombatStepDelay(40);
        const run = playerAction({ type: 'end_turn', actorId: 'pc' });
        await vi.waitFor(() => expect(useAppStore.getState().combatSession!.log.length).toBeGreaterThan(start.log.length + 1));
        const saved = JSON.parse(JSON.stringify({ session: useAppStore.getState().combatSession }));
        useAppStore.setState({ activeCampaignId: 'other' });
        await run;
        setCombatStepDelay(0);
        const restored = normalizeCombatRecord(saved).session!;
        expect(isEngineTurn(restored.state)).toBe(true);
        expect(restored.log.length).toBeGreaterThan(start.log.length + 1);
        useAppStore.setState({ activeCampaignId: 'camp-1', combatSession: restored, combatBusy: false });
        resumeStoredSession();
        await vi.waitFor(() => expect(isEngineStepping()).toBe(false));
        const resumed = useAppStore.getState().combatSession;
        if (expected.outcome) expect(resumed).toBeNull();
        else expect(resumed?.state).toEqual(expected);
    });

    it('acceptance 6: a Phase 1 session without a grid loads and continues', async () => {
        const { normalizeCombatRecord } = await import('../../tables/combatTable');
        const { buildPcCombatant } = await import('@narrative/engine');
        const { range: _pcRange, ...pc } = buildPcCombatant({ name: 'Kira', sheet });
        const foe = { ...pc, id: 'c1', name: 'Bandit', side: 'enemy' as const, controller: 'engine' as const, hp: 9, maxHp: 9 };
        const legacy = {
            state: { id: 'old', round: 2, order: ['c1', 'pc'], turnIndex: 0, combatants: { pc, c1: foe }, rngSeed: 5, rngCursor: 9, eventSeq: 4, outcome: null },
            log: [
                { seq: 1, round: 1, type: 'combat_started', data: {}, text: 'Combat begins.' },
                { seq: 2, round: 1, type: 'attack', actorId: 'pc', targetId: 'c1', data: { hit: false }, text: 'Kira attacks Bandit and misses.' },
                { seq: 3, round: 1, type: 'attack', actorId: 'c1', targetId: 'pc', data: { hit: false }, text: 'Bandit attacks Kira and misses.' },
                { seq: 4, round: 2, type: 'round', data: { round: 2 }, text: 'Round 2 begins.' },
            ],
            narratedThroughSeq: 4,
            startedAtMessageId: 'gm-1',
            reason: 'Old fight',
        };
        const session = normalizeCombatRecord(JSON.parse(JSON.stringify({ session: legacy }))).session!;
        expect(session.state.grid?.width).toBe(14);
        expect(session.postedThroughSeq).toBe(4);
        expect(session.state.rngCursor).toBe(9);
        const logsBefore = logMessages().length;
        useAppStore.setState({ combatSession: session });
        resumeStoredSession();
        await vi.waitFor(() => expect(isEngineStepping()).toBe(false));
        const live = useAppStore.getState().combatSession!;
        expect(playerActorId(live.state)).toBe('pc');
        expect(live.state.combatants.c1.position!.x).toBeLessThan(12);
        expect(logMessages().length).toBe(logsBefore + 1);
        const events = await playerAction({ type: 'end_turn', actorId: 'pc' });
        expect(events.length).toBeGreaterThan(0);
    });

    describe('T8 Enemy Compendium link', () => {
        const wolf = {
            id: 't1', name: 'Dire Wolf', aliases: 'warg, Grey Wolf',
            stats: [{ name: 'HP', value: '30' }, { name: 'Armor Class', value: '15' }, { name: 'Attack', value: '+6' }, { name: 'Damage', value: '2d6+1' }],
            weaknesses: ['fire'], resistances: [],
        };
        const wolfFight = (c: Partial<CombatProposal['combatants'][number]>) => proposal({ combatants: [{ name: 'Warg', side: 'enemy', tier: 'grunt', species: 'warg', ...c }] });
        const foe = () => Object.values(useAppStore.getState().combatSession!.state.combatants).find(c => c.side === 'enemy')!;
        const enable = (on: boolean) => useAppStore.setState({ settings: { ...useAppStore.getState().settings, moduleEnabled: on ? {} : { 'mod.enemies': false } } });

        it('uses the template stats for a common species', async () => {
            enable(true);
            useAppStore.setState({ modTables: { 'mod.enemies.compendium': [wolf] } });
            await startFromProposal(wolfFight({}), 4);
            expect(foe()).toMatchObject({ maxHp: 30, ac: 15, attackBonus: 6, damage: { count: 2, sides: 6, bonus: 1 }, weaknesses: ['fire'] });
        });

        it('raises a unique individual to the stated tier with HP and AC as a floor', async () => {
            enable(true);
            useAppStore.setState({ modTables: { 'mod.enemies.compendium': [wolf] } });
            await startFromProposal(wolfFight({ name: 'Old One-Eye', tier: 'boss' }), 4);
            expect(foe()).toMatchObject({ maxHp: 65, ac: 15, attackBonus: 7, damage: { count: 2, sides: 8, bonus: 3 } });
        });

        it('falls back to the tier block when the mod is disabled, the species is unknown or the compendium is empty', async () => {
            const tierOnly = { maxHp: 9, ac: 11, attackBonus: 3 };
            useAppStore.setState({ modTables: { 'mod.enemies.compendium': [wolf] } });
            enable(false);
            await startFromProposal(wolfFight({}), 4);
            expect(foe()).toMatchObject(tierOnly);
            useAppStore.setState({ combatSession: null });
            enable(true);
            await startFromProposal(wolfFight({ species: 'Owlbear' }), 4);
            expect(foe()).toMatchObject(tierOnly);
            useAppStore.setState({ combatSession: null, modTables: {} });
            await startFromProposal(wolfFight({}), 4);
            expect(foe()).toMatchObject(tierOnly);
        });

        it('draws the same random numbers whether or not a template matched', async () => {
            enable(true);
            useAppStore.setState({ modTables: { 'mod.enemies.compendium': [wolf] } });
            await startFromProposal(wolfFight({}), 4);
            const withTemplate = useAppStore.getState().combatSession!.state;
            useAppStore.setState({ combatSession: null, modTables: {} });
            await startFromProposal(wolfFight({}), 4);
            const without = useAppStore.getState().combatSession!.state;
            expect(withTemplate.order).toEqual(without.order);
            expect(Object.values(withTemplate.combatants).map(c => c.initiative)).toEqual(Object.values(without.combatants).map(c => c.initiative));
            expect(withTemplate.rngCursor).toBe(without.rngCursor);
        });
    });
});
