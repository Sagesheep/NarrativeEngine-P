import { describe, expect, it } from 'vitest';
import {
    applyAction, buildPcCombatant, chooseEngineTurn, createCombat, currentActorId, runEngineTurns,
} from '@narrative/engine';
import type { CombatAction } from '@narrative/engine';
import {
    buildAftermathText, buildArchiveBody, buildCombatantSpecs, buildResultText, conditionForCombatant, excludedAllies,
    fallenRecord, HARDCORE_CONSEQUENCE_TEXT, isIncluded,
} from '../combatController';
import { hpBandLabel, narrationLine, stateAtSeq } from '../combatEvents';
import { buildCombatBlock } from '../combatNarration';
import { buildSceneMap } from '../../campaign-state/divergenceRegister';
import type {
    ChatMessage, CombatPartyControl, CombatSession, CombatSheet, CombatState, Combatant, ParleyRecord, ProposedCombatant,
} from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 12 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function fighter(id: string, side: Combatant['side'], extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id.toUpperCase(), side, controller: side === 'player' ? 'player' : 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 10, status: 'up', conditions: [], position: { x: 0, y: 0 }, ...extra,
    };
}

function sessionOf(list: Combatant[], extra: Partial<CombatState> = {}, more: Partial<CombatSession> = {}): CombatSession {
    const combatants: Record<string, Combatant> = {};
    for (const c of list) combatants[c.id] = c;
    const state: CombatState = {
        id: 's1', round: 3, order: list.map(c => c.id), turnIndex: 0, combatants, rngSeed: 1, rngCursor: 0, eventSeq: 0,
        outcome: null, ...extra,
    };
    return { state, log: [], narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush', ...more };
}

const success = (intent: ParleyRecord['intent'], effect: ParleyRecord['effect'], attemptId = 'a1'): ParleyRecord => ({
    attemptId, round: 2, turn: 4, actorId: 'pc', intent, rating: 'even', dc: 13, natural: 15, total: 17, success: true, effect,
});

describe('endings reach the story with the right facts', () => {
    it('fled: lists who got away and who was left behind, and leaves their fate to the story', () => {
        const s = sessionOf([
            fighter('pc', 'player', { status: 'fled', hp: 7 }),
            fighter('ally', 'ally', { status: 'down', hp: 0 }),
            fighter('foe', 'enemy'),
        ], { outcome: 'fled' });
        const text = buildAftermathText(s);
        expect(text).toContain('Outcome: fled.');
        expect(text).toContain('Got away: PC.');
        expect(text).toContain('Left behind on the field: ALLY (unconscious)');
        expect(text).toContain('your decision as the story AI');
        expect(text).not.toContain('Casualties: PC');
        expect(buildResultText(s.state)).toContain('Fled: PC.');
    });

    it('let_go: the party carries its downed out and no one is left behind', () => {
        const s = sessionOf([
            fighter('pc', 'player'),
            fighter('ally', 'ally', { status: 'down', hp: 0 }),
            fighter('foe', 'enemy'),
        ], { outcome: 'fled', ending: { carried: true, parleyIntent: 'let_go' }, parleys: [success('let_go', 'let_go')] });
        const text = buildAftermathText(s);
        expect(text).toContain('carried its fallen with it; no one was left behind');
        expect(text).not.toContain('Left behind');
    });

    it('truce does not read as a loss, and bargain terms are quoted as the player\'s offer', () => {
        const s = sessionOf([fighter('pc', 'player'), fighter('foe', 'enemy')], {
            outcome: 'truce', parleys: [success('bargain', 'truce')], ending: { parleyIntent: 'bargain' },
        }, { parleyLines: [{ attemptId: 'a1', words: 'Take the gold and the "castle" and go' }] });
        const text = buildAftermathText(s);
        expect(text).toContain('truce');
        expect(text).toContain('not a defeat');
        expect(text).toContain('The player offered these terms: "Take the gold and the \'castle\' and go"');
        expect(text).toContain('not an accepted fact');
        expect(text).not.toContain('lost');
    });

    it('surrender: the enemies yielded and are at the party\'s mercy; escaped enemies are named', () => {
        const s = sessionOf([
            fighter('pc', 'player'),
            fighter('boss', 'enemy', { status: 'surrendered', hp: 12, tier: 'elite' }),
            fighter('runner', 'enemy', { status: 'fled', hp: 3 }),
        ], { outcome: 'victory', parleys: [success('surrender_demand', 'surrender')] });
        const text = buildAftermathText(s);
        expect(text).toContain('The enemies yielded: BOSS');
        expect(text).toContain('at the party\'s mercy');
        expect(text).toContain('Escaped: RUNNER fled the field');
        expect(buildResultText(s.state)).toContain('Yielded: BOSS.');
    });

    it('hardcore survival carries the consequence instruction; death is stated as final', () => {
        const pcDown = fighter('pc', 'player', { status: 'down', hp: 0 });
        const survived = sessionOf([pcDown, fighter('foe', 'enemy')], { outcome: 'defeat', defeatMode: 'hardcore', fate: { pcId: 'pc', mode: 'hardcore', natural: 12, dies: false } });
        expect(buildAftermathText(survived)).toContain(HARDCORE_CONSEQUENCE_TEXT);
        const died = sessionOf([pcDown, fighter('foe', 'enemy')], { outcome: 'defeat', defeatMode: 'ironman', fate: { pcId: 'pc', mode: 'ironman', dies: true } });
        const text = buildAftermathText(died);
        expect(text).toContain('PC died in this fight. The death is final.');
        expect(text).toContain('PC (dead)');
        expect(text).not.toContain(HARDCORE_CONSEQUENCE_TEXT);
        expect(buildResultText(died.state)).toContain('PC has died.');
        expect(fallenRecord({ context: { playerCharacter: { id: 'p-1', name: 'Kira' } } as never }, died.state)).toMatchObject({ name: 'Kira', pcId: 'p-1', mode: 'ironman', stage: 'fallen' });
        expect(fallenRecord({ context: {} as never }, survived.state)).toBeNull();
    });

    it('does not write fled enemies to the ledger as dead; surrendered take their condition from HP', () => {
        expect(conditionForCombatant(fighter('a', 'enemy', { status: 'fled', hp: 2 }))).toBeNull();
        expect(conditionForCombatant(fighter('a', 'enemy', { status: 'surrendered', hp: 18 }))).toBe('healthy');
        expect(conditionForCombatant(fighter('a', 'enemy', { status: 'surrendered', hp: 3 }))).toBe('critical');
        expect(conditionForCombatant(fighter('a', 'enemy', { status: 'down', hp: 0 }))).toBe('dead');
    });

    it('gives fled and surrendered combatants their own wording in bands, narration and the beat roster', () => {
        expect(hpBandLabel({ hp: 5, maxHp: 20, status: 'fled' })).toBe('fled');
        expect(hpBandLabel({ hp: 5, maxHp: 20, status: 'surrendered' })).toBe('yielded');
        const s = sessionOf([fighter('pc', 'player'), fighter('foe', 'enemy', { status: 'fled' }), fighter('other', 'enemy', { status: 'surrendered' })]);
        const flee = { seq: 5, round: 3, turn: 7, type: 'flee', actorId: 'foe', targetId: 'foe', data: { success: true }, text: 'FOE leaves.' };
        const yieldEv = { seq: 6, round: 3, turn: 8, type: 'surrendered', targetId: 'other', data: {}, text: 'OTHER yields.' };
        expect(narrationLine(flee, s.state)).toBe('FOE breaks away and leaves the fight.');
        expect(narrationLine({ ...flee, type: 'parley', data: {} }, s.state)).toBe('');
        const before = stateAtSeq(s.state, [flee, yieldEv], 4);
        expect(before.combatants.foe.status).toBe('up');
        expect(before.combatants.other.status).toBe('up');
        const withFlee = buildCombatBlock(s.state, [flee, yieldEv], { fromSeq: 5, toSeq: 6 });
        expect(withFlee).toContain('FOE (enemy): fled');
        expect(withFlee).toContain('OTHER (enemy): yielded');
        const later = buildCombatBlock(s.state, [flee, yieldEv], { fromSeq: 6, toSeq: 6 });
        expect(later).not.toContain('FOE (enemy)');
    });

    it('archives the player\'s spoken line with the beats, in chat order', () => {
        const s = sessionOf([fighter('pc', 'player', { name: 'Kira' }), fighter('foe', 'enemy')], { outcome: 'truce' });
        const messages: ChatMessage[] = [
            { id: 'b1', role: 'assistant', content: 'Steel rings.', timestamp: 1, combatBeat: { sessionId: 's1', fromSeq: 1, toSeq: 3 } },
            { id: 'l1', role: 'user', content: 'Enough. Lower your blades.', timestamp: 2, combatParley: { sessionId: 's1', attemptId: 'a1', part: 'line' } },
            { id: 'r1', role: 'assistant', content: '"Fine," the captain spits.', timestamp: 3, combatBeat: { sessionId: 's1', fromSeq: 4, toSeq: 4 }, combatParley: { sessionId: 's1', attemptId: 'a1', part: 'reply' } },
        ];
        expect(buildArchiveBody(s, messages, 'Combat ended: truce.')).toBe('Steel rings.\n\nKira: "Enough. Lower your blades."\n\n"Fine," the captain spits.\n\nCombat ended: truce.');
    });

    it('keeps parley lines out of the divergence register pairing', () => {
        const messages: ChatMessage[] = [
            { id: 'u1', role: 'user', content: 'go', timestamp: 1 },
            { id: 'g1', role: 'assistant', content: 'ok', timestamp: 2 },
            { id: 'l1', role: 'user', content: 'Stop!', timestamp: 3, combatParley: { sessionId: 's', attemptId: 'a', part: 'line' } },
        ];
        const map = buildSceneMap([{ sceneId: '001' } as never], messages);
        expect(map.sceneIdsByMessageId.u1).toBe('001');
        expect(map.sceneIdsByMessageId.l1).toBeUndefined();
    });
});

describe('party modes', () => {
    const roster: ProposedCombatant[] = [
        { name: 'Mira', side: 'ally', tier: 'grunt', archetype: 'caster' },
        { name: 'Bandit', side: 'enemy', tier: 'minion' },
        { name: 'Bandit 2', side: 'enemy', tier: 'minion' },
    ];
    const lookup = { modTables: {}, settings: { moduleEnabled: {} } } as never;

    it('solo leaves allies out unless included; the other modes bring them', () => {
        expect(isIncluded(roster[0], 'solo')).toBe(false);
        expect(isIncluded({ ...roster[0], included: true }, 'solo')).toBe(true);
        expect(isIncluded(roster[0], 'engine')).toBe(true);
        expect(buildCombatantSpecs(roster, lookup, 'solo').map(s => s.name)).toEqual(['Bandit', 'Bandit 2']);
        expect(excludedAllies(roster, 'solo')).toEqual(['Mira']);
        expect(buildAftermathText(sessionOf([fighter('pc', 'player'), fighter('foe', 'enemy', { status: 'down', hp: 0 })], { outcome: 'victory' }, { excluded: ['Mira'] })))
            .toContain('Did not fight: Mira stayed out of the fight.');
    });

    function play(mode: CombatPartyControl): CombatState {
        const pc = buildPcCombatant({ name: 'Kira', sheet, weapon: { quality: 'rare', scalingStat: 'STR' } });
        let state = createCombat({ id: `m-${mode}`, combatants: buildCombatantSpecs(roster, lookup, mode), partyControl: mode, map: { size: 'small', area: 'open', density: 'sparse' } }, pc, 9).state;
        for (let guard = 0; guard < 400 && !state.outcome; guard++) {
            state = runEngineTurns(state).state;
            if (state.outcome) break;
            const actorId = currentActorId(state) as string;
            const choice = chooseEngineTurn(state, actorId);
            const action: CombatAction = choice.actions[0] ?? { type: 'end_turn', actorId };
            const applied = applyAction(choice.state, action);
            state = applied.events.some(e => e.type === 'rejected') ? applyAction(choice.state, { type: 'end_turn', actorId }).state : applied.state;
        }
        return state;
    }

    it.each(['solo', 'engine', 'player'] as const)('%s mode completes a fight', (mode) => {
        const end = play(mode);
        expect(end.outcome).not.toBeNull();
        const mira = Object.values(end.combatants).find(c => c.name === 'Mira');
        if (mode === 'solo') expect(mira).toBeUndefined();
        if (mode === 'engine') expect(mira?.controller).toBe('engine');
        if (mode === 'player') expect(mira?.controller).toBe('player');
        expect(end.partyControl).toBe(mode);
    });
});
