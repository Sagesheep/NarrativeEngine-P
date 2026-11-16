import { describe, expect, it, vi } from 'vitest';

vi.mock('../../chatEngine', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../chatEngine')>();
    return { ...actual, sendMessage: vi.fn(() => Promise.resolve()) };
});

import { WIN_KINDS, applyAction, buildPcCombatant, chooseEngineTurn, createCombat, currentActorId, runEngineTurns } from '@narrative/engine';
import type { CombatAction } from '@narrative/engine';
import { stateAtSeq, narrationLine, momentTags, turnLines, groupEventsByTurn } from '../combatEvents';
import { parseCombatArgs } from '../combatProposal';
import { buildAftermathText, buildCombatantSpecs, buildResultText, conditionForCombatant } from '../combatController';
import {
    DEFAULT_BYSTANDER_NAME, DEFAULT_WARD_NAME, isPlainObjective, matchUnitName, objectiveSpecFields, previewObjectiveRepairs, reconcileObjective,
} from '../combatObjective';
import { objectiveResultClause, objectiveStakes } from '../objectiveStory';
import { beatDirective, directiveForRange } from '../combatNarration';
import { buildManualStartPrompt } from '../combatManualStart';
import { START_COMBAT_TOOL_RESULT, getToolDefinitions, handleStartCombatTool } from '../../turn/toolHandlers';
import type { CombatEvent, CombatObjective, CombatSession, CombatSheet, CombatState, Combatant, ProposedCombatant, ProposedObjective } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };
const fighter = () => buildPcCombatant({ name: 'Kira', sheet, weapon: { quality: 'common', scalingStat: 'STR' } });
const LOOKUP = { modTables: {}, settings: { moduleEnabled: {} } };
const MEDIUM = { size: 'medium' as const, area: 'open' as const, density: 'sparse' as const };

const ROSTER: ProposedCombatant[] = [
    { name: 'Captain Vey', side: 'enemy', tier: 'elite' },
    { name: 'Bandit', side: 'enemy', tier: 'grunt' },
    { name: 'Mara', side: 'ally', tier: 'grunt' },
];

function fight(objective: ProposedObjective | undefined, seed = 11, roster: readonly ProposedCombatant[] = ROSTER) {
    const reconciled = reconcileObjective(roster, objective);
    const specs = buildCombatantSpecs(reconciled.combatants, LOOKUP, 'engine');
    return createCombat({ id: 'h', combatants: specs, map: MEDIUM, mapSeed: seed * 31 + 7, ...objectiveSpecFields(reconciled.objective) }, fighter(), seed);
}

function drive(state: CombatState, log: CombatEvent[]): CombatState {
    let s = state;
    for (let i = 0; i < 3000 && !s.outcome; i++) {
        const id = currentActorId(s) as string;
        if (s.combatants[id]?.controller === 'engine' || s.combatants[id]?.status !== 'up') {
            const r = runEngineTurns(s);
            log.push(...r.events);
            s = r.state;
            continue;
        }
        const action: CombatAction = chooseEngineTurn(s, id).actions[0] ?? { type: 'end_turn', actorId: id };
        const r = applyAction(s, action);
        if (r.events.some(e => e.type === 'rejected')) throw new Error(`rejected ${JSON.stringify(action)}`);
        log.push(...r.events);
        s = r.state;
    }
    return s;
}

function play(objective: ProposedObjective | undefined, seed: number, roster: readonly ProposedCombatant[] = ROSTER) {
    const created = fight(objective, seed, roster);
    const log = [...created.events];
    const final = drive(created.state, log);
    return { created, log, final };
}

function unit(id: string, name: string, side: Combatant['side'], extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name, side, controller: side === 'player' ? 'player' : 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 10, status: 'up', conditions: [], position: { x: 1, y: 1 }, range: 'close', ...extra,
    };
}

const ev = (seq: number, type: string, data: Record<string, unknown>, actorId?: string, targetId?: string): CombatEvent => ({
    seq, round: 2, turn: seq, type, data, text: `${type} ${seq}`, ...(actorId ? { actorId } : {}), ...(targetId ? { targetId } : {}),
});

function hand(objective: CombatObjective | undefined, extra: Partial<CombatState> = {}): CombatState {
    const list = [unit('pc', 'Kira', 'player'), unit('w', 'Mara', 'ally', { mark: 'ward' }), unit('boss', 'Vey', 'enemy', { mark: 'leader' }), unit('by', 'Pilgrim', 'neutral', { mark: 'bystander' })];
    return {
        id: 'x', round: 2, order: list.map(c => c.id), turnIndex: 0, combatants: Object.fromEntries(list.map(c => [c.id, c])),
        rngSeed: 5, rngCursor: 0, eventSeq: 0, outcome: null, ...(objective ? { objective } : {}), ...extra,
    };
}

function sessionOf(state: CombatState, log: CombatEvent[] = []): CombatSession {
    return { state, log, narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: '' };
}

describe('start_combat objective parsing', () => {
    const base = { combatants: [{ name: 'Bandit' }, { name: 'Captain Vey', tier: 'elite' }], reason: 'r' };

    it('reads an object, strips coordinates, lower-cases kinds and keeps the reinforcement level', () => {
        const parsed = parseCombatArgs({ ...base, objective: { win: 'Defeat Leader', leader: 'captain vey', exits: [{ x: 1, y: 1 }], seize: { x: 2, y: 2 }, reinforcements: 'Some' } });
        expect(parsed.ok && parsed.value.objective).toEqual({ win: 'defeat_leader', leader: 'Captain Vey', reinforcements: 'some' });
    });

    it('reads a JSON string and a bare kind', () => {
        const json = parseCombatArgs(JSON.stringify({ ...base, objective: '{"win":"survive","rounds":4,"lose":["round_limit"],"roundLimit":6}' }));
        expect(json.ok && json.value.objective).toEqual({ win: 'survive', rounds: 4, lose: ['round_limit'], roundLimit: 6 });
        const bare = parseCombatArgs({ ...base, objective: 'escape' });
        expect(bare.ok && bare.value.objective).toEqual({ win: 'escape' });
    });

    it('drops a plain rout but keeps a rout that carries a side aim', () => {
        const plain = parseCombatArgs({ ...base, objective: { win: 'rout' } });
        expect(plain.ok && plain.value.objective).toBeUndefined();
        expect(isPlainObjective({ win: 'rout' })).toBe(true);
        const side = parseCombatArgs({ ...base, objective: { win: 'rout', side: 'no_one_falls' } });
        expect(side.ok && side.value.objective).toEqual({ win: 'rout', side: 'no_one_falls' });
    });

    it('leaves a fight with no objective exactly as before', () => {
        const parsed = parseCombatArgs(base);
        expect(parsed.ok && 'objective' in parsed.value).toBe(false);
        expect(parsed.ok && parsed.notes).toEqual([]);
    });

    it('keeps an unknown kind for the engine to report, and says so when the objective cannot be read', () => {
        const unknown = parseCombatArgs({ ...base, objective: { win: 'capture' } });
        expect(unknown.ok && unknown.value.objective).toEqual({ win: 'capture' });
        const unreadable = parseCombatArgs({ ...base, objective: { leader: 'nobody' } });
        expect(unreadable.ok && unreadable.value.objective).toBeUndefined();
        expect(unreadable.ok && unreadable.notes[0]).toContain('not understood');
    });
});

describe('matching names to combatants', () => {
    it('matches case-insensitively, by base name for duplicates, and prefers the right side', () => {
        const list: ProposedCombatant[] = [
            { name: 'Bandit 1', side: 'enemy', tier: 'grunt' }, { name: 'Bandit 2', side: 'enemy', tier: 'grunt' },
            { name: 'Old Marta', side: 'ally', tier: 'grunt' }, { name: 'Marta the Bold', side: 'enemy', tier: 'grunt' },
        ];
        expect(matchUnitName('bandit', list, 'enemy')).toBe('Bandit 1');
        expect(matchUnitName('BANDIT 2', list, 'enemy')).toBe('Bandit 2');
        expect(matchUnitName('marta', list, 'ally')).toBe('Old Marta');
        expect(matchUnitName('Stranger', list, 'enemy')).toBeUndefined();
        expect(matchUnitName('  ', list, 'enemy')).toBeUndefined();
    });

    it('resolves the leader through the parsed duplicate names', () => {
        const parsed = parseCombatArgs({ combatants: [{ name: 'Bandit' }, { name: 'Bandit' }], objective: { win: 'defeat_leader', leader: 'Bandit' } });
        expect(parsed.ok && parsed.value.objective?.leader).toBe('Bandit 1');
    });

    it('reports a leader who is not an enemy', () => {
        const repairs = previewObjectiveRepairs(ROSTER, { win: 'defeat_leader', leader: 'Mara' });
        expect(repairs.map(r => r.code)).toContain('wrong_side');
    });
});

describe('adding a ward or bystander the model named but did not list', () => {
    it('adds the ward as a weak, included ally and says so', () => {
        const parsed = parseCombatArgs({ combatants: [{ name: 'Bandit' }], objective: { win: 'protect', ward: 'Old Marta', rounds: 4 } });
        if (!parsed.ok) throw new Error('parse');
        expect(parsed.value.combatants.at(-1)).toEqual({ name: 'Old Marta', side: 'ally', tier: 'grunt', included: true });
        expect(parsed.value.objective?.ward).toBe('Old Marta');
        expect(parsed.notes.join(' ')).toContain('Old Marta was not listed in combatants and was added to the fight as an ally');
    });

    it('adds a neutral bystander', () => {
        const parsed = parseCombatArgs({ combatants: [{ name: 'Bandit' }], objective: { win: 'rout', side: 'save_bystander', bystander: 'Pilgrim' } });
        if (!parsed.ok) throw new Error('parse');
        expect(parsed.value.combatants.at(-1)).toEqual({ name: 'Pilgrim', side: 'neutral', tier: 'grunt' });
        expect(parsed.notes.join(' ')).toContain('a neutral bystander');
    });

    it('uses a default name when none is given, only once', () => {
        const once = reconcileObjective([{ name: 'Bandit', side: 'enemy', tier: 'grunt' }], { win: 'protect', side: 'save_bystander' });
        expect(once.added.map(a => a.name)).toEqual([DEFAULT_WARD_NAME, DEFAULT_BYSTANDER_NAME]);
        const twice = reconcileObjective(once.combatants, once.objective);
        expect(twice.added).toEqual([]);
        expect(twice.combatants).toHaveLength(3);
    });

    it('does not add a unit that is already listed, and marks a listed ally as included', () => {
        const solo = reconcileObjective([{ name: 'Bandit', side: 'enemy', tier: 'grunt' }, { name: 'Mara', side: 'ally', tier: 'grunt' }], { win: 'protect', ward: 'mara' });
        expect(solo.added).toEqual([]);
        expect(solo.objective?.ward).toBe('Mara');
        expect(solo.combatants[1].included).toBe(true);
    });

    it('adds nothing when the roster is full and lets the engine report it', () => {
        const full = Array.from({ length: 12 }, (_, i): ProposedCombatant => ({ name: `Rat ${i}`, side: 'enemy', tier: 'minion' }));
        const r = reconcileObjective(full, { win: 'protect', ward: 'Mara', rounds: 3 });
        expect(r.combatants).toHaveLength(12);
        expect(previewObjectiveRepairs(r.combatants, r.objective).map(x => x.code)).toContain('missing_unit');
    });

    it('drops a ward the objective no longer needs', () => {
        const r = reconcileObjective(ROSTER, { win: 'rout', ward: 'Mara', side: 'no_one_falls' });
        expect(r.objective).toEqual({ win: 'rout', side: 'no_one_falls' });
    });

    it('puts the added ward in the fight with the ward mark and the coward tactic', () => {
        const created = fight({ win: 'protect', ward: 'Old Marta', rounds: 4 }, 3, [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }]);
        const ward = Object.values(created.state.combatants).find(c => c.name === 'Old Marta');
        expect(ward).toMatchObject({ side: 'ally', mark: 'ward', tactic: 'coward', tier: 'grunt' });
        expect(created.state.objective?.win).toMatchObject({ kind: 'protect', wardId: ward?.id, rounds: 4 });
        expect(created.objective?.repairs.map(r => r.code)).toEqual(['lose_added']);
    });

    it('puts the added bystander in as a neutral', () => {
        const created = fight({ win: 'rout', side: 'save_bystander', bystander: 'Pilgrim' }, 3, [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }]);
        const by = Object.values(created.state.combatants).find(c => c.name === 'Pilgrim');
        expect(by).toMatchObject({ side: 'neutral', mark: 'bystander' });
    });
});

describe('the engine fields of a proposal', () => {
    it('sends nothing for a plain fight, and splits the reinforcement level from the objective', () => {
        expect(objectiveSpecFields(undefined)).toEqual({});
        expect(objectiveSpecFields({ win: 'rout' })).toEqual({});
        expect(objectiveSpecFields({ win: 'survive', rounds: 5, reinforcements: 'many' })).toEqual({ objective: { win: 'survive', rounds: 5 }, reinforcements: 'many' });
    });

    it('a fight without an objective has no objective state or events', () => {
        const created = fight(undefined, 5);
        expect(created.objective).toBeUndefined();
        expect(created.state.objective).toBeUndefined();
        expect(created.events.some(e => e.type.startsWith('objective') || e.type.startsWith('reinforcements'))).toBe(false);
    });

    it('reports the engine repairs on the created fight', () => {
        const created = fight({ win: 'survive', rounds: 99 }, 5);
        expect(created.state.objective?.win).toMatchObject({ kind: 'survive', rounds: 8 });
        expect(created.objective?.repairs.map(r => r.code)).toContain('clamped');
    });
});

describe('telling the model about repairs', () => {
    const args = (objective: unknown) => JSON.stringify({ combatants: [{ name: 'Bandit' }, { name: 'Captain Vey', tier: 'elite' }], reason: 'r', objective });

    it('leaves the tool result alone without an objective or with one that needs no repair', () => {
        expect(handleStartCombatTool(args(undefined)).toolResult).toBe(START_COMBAT_TOOL_RESULT);
        expect(handleStartCombatTool(args({ win: 'survive', rounds: 4 })).toolResult).toBe(START_COMBAT_TOOL_RESULT);
    });

    it('tells the model a number was clamped', () => {
        const out = handleStartCombatTool(args({ win: 'survive', rounds: 99 }));
        expect(out.toolResult.startsWith(START_COMBAT_TOOL_RESULT)).toBe(true);
        expect(out.toolResult).toContain('The fight objective was adjusted');
        expect(out.toolResult).toContain('99');
        expect(out.proposal?.objective).toEqual({ win: 'survive', rounds: 99 });
    });

    it('tells the model an unknown kind became a plain rout', () => {
        expect(handleStartCombatTool(args({ win: 'capture' })).toolResult).toContain('plain rout');
    });

    it('tells the model a named leader was missing and which one was taken', () => {
        const text = handleStartCombatTool(args({ win: 'defeat_leader', leader: 'The Warlord' })).toolResult;
        expect(text).toContain('adjusted');
        expect(text.toLowerCase()).toContain('leader');
    });

    it('tells the model about an added ward and about dropped reinforcements', () => {
        const added = handleStartCombatTool(args({ win: 'protect', ward: 'Old Marta', rounds: 4 })).toolResult;
        expect(added).toContain('Old Marta was not listed in combatants and was added to the fight as an ally');
        const dropped = handleStartCombatTool(args({ win: 'rout', side: 'no_one_falls', reinforcements: 'many' })).toolResult;
        expect(dropped).toContain('Reinforcements are not allowed');
    });

    it('does not mention repairs that depend on the layout the player may still change', () => {
        const text = handleStartCombatTool(args({ win: 'escape' })).toolResult;
        expect(text).toBe(START_COMBAT_TOOL_RESULT);
    });
});

describe('the tool and the manual prompt describe the objective', () => {
    const tool = () => {
        const defs = getToolDefinitions({ allowDiceTool: false, allowCombatTool: true }) as Array<{ function: { name: string; parameters: { properties: Record<string, { description?: string; properties?: Record<string, { enum?: string[]; items?: { enum?: string[] } }>; required?: string[] }> } } }>;
        return defs.find(d => d.function.name === 'start_combat')!.function.parameters.properties.objective;
    };

    it('lists every win kind with a line saying when it fits', () => {
        const objective = tool();
        expect(objective.properties?.win.enum).toEqual([...WIN_KINDS]);
        expect(objective.required).toEqual(['win']);
        for (const kind of ['defeat_leader', 'survive', 'escape', 'protect', 'seize']) expect(objective.description).toContain(`${kind}:`);
        expect(objective.description).toContain('Never give coordinates');
        expect(objective.properties?.reinforcements.enum).toEqual(['none', 'some', 'many']);
        expect(objective.properties?.lose.items?.enum).toEqual(['pc_falls', 'round_limit', 'leader_escapes']);
        expect(objective.properties?.side.enum).toEqual(['within_rounds', 'no_one_falls', 'save_bystander', 'reach_tile']);
    });

    it('the manual start prompt asks for it too', () => {
        const prompt = buildManualStartPrompt([], 'Kira');
        expect(prompt).toContain('objective is optional');
        for (const line of ['- rout:', '- defeat_leader:', '- survive:', '- escape:', '- protect:', '- seize:']) expect(prompt).toContain(line);
        expect(prompt).toContain('Never give coordinates');
    });
});

describe('rewinding the objective events', () => {
    it('restores escaped units and arrivals at the start of the fight, and between events', () => {
        let escapes = 0;
        let arrivals = 0;
        for (let seed = 1; seed <= 12; seed++) {
            for (const objective of [{ win: 'escape' }, { win: 'survive', rounds: 4, reinforcements: 'many' }, { win: 'defeat_leader', reinforcements: 'some' }] as ProposedObjective[]) {
                const { created, log, final } = play(objective, seed);
                const start = stateAtSeq(final, log, 0);
                for (const [id, c0] of Object.entries(created.state.combatants)) {
                    expect(start.combatants[id], `${objective.win} ${seed} ${id}`).toMatchObject({ status: c0.status, hp: c0.hp, position: c0.position });
                }
                for (const event of log) {
                    if (event.type === 'objective_progress' && event.data.kind === 'escaped' && event.targetId) {
                        escapes++;
                        expect(stateAtSeq(final, log, event.seq - 1).combatants[event.targetId]).toMatchObject({ status: 'up', position: event.data.at });
                        expect(stateAtSeq(final, log, event.seq).combatants[event.targetId].status).toBe('escaped');
                    }
                    if (event.type === 'reinforcements_arrive') {
                        arrivals++;
                        const units = event.data.units as Array<{ id: string }>;
                        for (const u of units) {
                            expect(stateAtSeq(final, log, event.seq - 1).combatants[u.id].status).toBe('gone');
                            expect(stateAtSeq(final, log, event.seq).combatants[u.id].status).not.toBe('gone');
                        }
                    }
                }
            }
        }
        expect(escapes).toBeGreaterThan(0);
        expect(arrivals).toBeGreaterThan(0);
    });
});

describe('narrating the objective events', () => {
    const o: CombatObjective = {
        win: { kind: 'protect', wardId: 'w', with: { kind: 'escape', exits: [{ x: 5, y: 0 }], everyone: false } },
        lose: [{ kind: 'ward_falls', wardId: 'w' }, { kind: 'round_limit' }, { kind: 'leader_escapes', leaderId: 'boss', exits: [{ x: 0, y: 3 }] }],
        roundLimit: 6,
        side: { kind: 'save_bystander', bystanderId: 'by' },
    };
    const state = hand(o);
    const line = (e: CombatEvent) => narrationLine(e, state);

    it('words the clock without numbers and only when time is short', () => {
        expect(line(ev(1, 'objective_progress', { kind: 'rounds_left', clock: 'survive', left: 1, round: 5 }))).toBe('This is the last round to hold out.');
        expect(line(ev(1, 'objective_progress', { kind: 'rounds_left', clock: 'protect', left: 1, round: 5 }))).toBe('This is the last round to keep Mara alive.');
        expect(line(ev(1, 'objective_progress', { kind: 'rounds_left', clock: 'round_limit', left: 1, round: 5 }))).toBe('This is the last round before time runs out.');
        expect(line(ev(1, 'objective_progress', { kind: 'rounds_left', clock: 'survive', left: 2, round: 4 }))).toBe('Time is running short.');
        expect(line(ev(1, 'objective_progress', { kind: 'rounds_left', clock: 'survive', left: 4, round: 2 }))).toBe('');
    });

    it('narrates escapes, the held square, the reached spot and a broken hold', () => {
        expect(line(ev(1, 'objective_progress', { kind: 'escaped', unitId: 'pc', how: 'exit', at: { x: 1, y: 0 } }, 'pc', 'pc'))).toBe('Kira gets out through the exit.');
        expect(line(ev(1, 'objective_progress', { kind: 'escaped', unitId: 'boss', how: 'leader_exit', at: { x: 1, y: 0 } }, 'boss', 'boss'))).toBe('Vey slips away through the exit.');
        expect(line(ev(1, 'objective_progress', { kind: 'holding', unitId: 'pc', at: { x: 2, y: 2 } }, 'pc', 'pc'))).toBe('Kira takes the marked ground.');
        expect(line(ev(1, 'objective_progress', { kind: 'reached', unitId: 'w', at: { x: 2, y: 2 } }, 'w', 'w'))).toBe('Mara reaches the marked spot.');
        expect(line(ev(1, 'objective_progress', { kind: 'hold_broken', unitId: 'pc' }, undefined, 'pc'))).toBe('Kira loses the hold on the marked ground.');
    });

    it('narrates the win, the loss and the side aim in plain words', () => {
        expect(line(ev(1, 'objective_met', { part: 'win', kind: 'escape', by: 'escape' }))).toBe('The way out is taken and the party is clear.');
        expect(line(ev(1, 'objective_met', { part: 'win', kind: 'protect', by: 'protect' }))).toBe('Mara is safe.');
        expect(line(ev(1, 'objective_met', { part: 'win', kind: 'rout', by: 'rout' }))).toBe('');
        expect(line(ev(1, 'objective_met', { part: 'side', kind: 'save_bystander' }))).toBe('Pilgrim is safe.');
        expect(line(ev(1, 'objective_failed', { part: 'lose', kind: 'ward_falls', by: 'ward_falls' }))).toBe('Mara is lost, and with them the party\'s aim.');
        expect(line(ev(1, 'objective_failed', { part: 'lose', kind: 'round_limit', by: 'round_limit' }))).toBe('Time has run out.');
        expect(line(ev(1, 'objective_failed', { part: 'lose', kind: 'leader_escapes', by: 'leader_escapes' }))).toBe('Vey has got away.');
        expect(line(ev(1, 'objective_failed', { part: 'side', kind: 'save_bystander' }))).toBe('Pilgrim was lost.');
        expect(line(ev(1, 'objective_failed', { part: 'lose', kind: 'pc_falls', by: 'pc_falls' }))).toBe('');
    });

    it('narrates the warning and the arrival', () => {
        expect(line(ev(1, 'reinforcements_warning', { waveId: 'r1', round: 3, tiles: [], count: 2 }))).toBe('Reinforcements are coming.');
        expect(line(ev(1, 'reinforcements_warning', { waveId: 'r1', round: 3, tiles: [], count: 2, delayed: true }))).toBe('The reinforcements are held up, but they are still coming.');
        expect(line(ev(1, 'reinforcements_arrive', { waveId: 'r1', units: [{ id: 'r1', name: 'Raider' }, { id: 'r2', name: 'Thug' }], waiting: 0 }))).toBe('Reinforcements arrive: Raider, Thug.');
        expect(line(ev(1, 'reinforcements_arrive', { waveId: 'r1', units: [], waiting: 2 }))).toBe('');
    });

    it('states no numbers in any of them', () => {
        const all: CombatEvent[] = [
            ev(1, 'objective_progress', { kind: 'rounds_left', clock: 'survive', left: 1, round: 5 }),
            ev(2, 'objective_progress', { kind: 'escaped', unitId: 'pc', how: 'exit' }, 'pc', 'pc'),
            ev(3, 'objective_met', { part: 'win', by: 'seize' }),
            ev(4, 'objective_failed', { part: 'lose', by: 'round_limit' }),
            ev(5, 'reinforcements_warning', { waveId: 'r1', round: 3, tiles: [], count: 2 }),
            ev(6, 'reinforcements_arrive', { waveId: 'r1', units: [{ id: 'r1', name: 'Raider' }], waiting: 0 }),
        ];
        for (const e of all) expect(line(e)).not.toMatch(/\d/);
    });

    it('keeps the engine text when numbers are on', () => {
        const events = [ev(1, 'objective_progress', { kind: 'rounds_left', clock: 'survive', left: 3, round: 3 })];
        const group = groupEventsByTurn(events)[0];
        expect(turnLines(group, state, { numbers: true })).toEqual(['objective_progress 1']);
    });

    it('tags the moments that have a line, and only those', () => {
        const log = [
            ev(1, 'objective_progress', { kind: 'rounds_left', clock: 'survive', left: 4, round: 2 }),
            ev(2, 'objective_progress', { kind: 'rounds_left', clock: 'survive', left: 1, round: 5 }),
            ev(3, 'reinforcements_warning', { waveId: 'r1', round: 3, tiles: [], count: 1 }),
            ev(4, 'reinforcements_arrive', { waveId: 'r1', units: [{ id: 'r1', name: 'Raider' }], waiting: 0 }),
            ev(5, 'objective_progress', { kind: 'escaped', unitId: 'pc', how: 'exit' }, 'pc', 'pc'),
            ev(6, 'objective_progress', { kind: 'escaped', unitId: 'boss', how: 'leader_exit' }, 'boss', 'boss'),
            ev(7, 'objective_progress', { kind: 'holding', unitId: 'pc' }, 'pc', 'pc'),
            ev(8, 'objective_progress', { kind: 'hold_broken', unitId: 'pc' }, undefined, 'pc'),
            ev(9, 'objective_met', { part: 'win', by: 'rout' }),
            ev(10, 'objective_met', { part: 'win', by: 'escape' }),
            ev(11, 'objective_failed', { part: 'lose', by: 'round_limit' }),
            ev(12, 'objective_met', { part: 'side', kind: 'save_bystander' }),
        ];
        const tags = momentTags(state, log, 12);
        expect([...tags.entries()]).toEqual([
            [2, 'the last round'],
            [3, 'reinforcements are coming'],
            [4, 'reinforcements have arrived'],
            [5, 'a way out is taken'],
            [6, 'the leader gets away'],
            [7, 'the ground is taken'],
            [8, 'the hold is broken'],
            [10, 'the objective is achieved'],
            [11, 'the objective is lost'],
        ]);
    });
});

describe('the beat directive carries the stakes', () => {
    it('adds one stakes line when the objective has stakes', () => {
        const text = beatDirective({ stakes: 'Stakes: test.' });
        expect(text).toContain('Stakes: test.');
        expect(beatDirective()).not.toContain('Stakes:');
    });

    it('describes the aim, the ways to lose, the side aim and the pressure of time', () => {
        const o: CombatObjective = {
            win: { kind: 'protect', wardId: 'w', rounds: 4 },
            lose: [{ kind: 'ward_falls', wardId: 'w' }, { kind: 'round_limit' }],
            roundLimit: 4,
            side: { kind: 'no_one_falls' },
        };
        const text = objectiveStakes(hand(o, { round: 4 })) ?? '';
        expect(text).toContain('keep Mara alive for 4 rounds');
        expect(text).toContain('the fight is lost if Mara falls or time runs out');
        expect(text).toContain('no one in the party falls');
        expect(text).toContain('this is the last round');
        expect(text).toContain('without stating numbers or deciding the result');
    });

    it('says nothing for a plain rout or no objective, and names the leader and the exit', () => {
        expect(objectiveStakes(hand(undefined))).toBeNull();
        expect(objectiveStakes(hand({ win: { kind: 'rout' } }))).toBeNull();
        expect(objectiveStakes(hand({ win: { kind: 'defeat_leader', leaderId: 'boss' } }))).toContain('bring down Vey');
        expect(objectiveStakes(hand({ win: { kind: 'escape', exits: [{ x: 1, y: 0 }], everyone: true } }))).toContain('every one of the party out through the exit');
    });

    it('the range directive includes the stakes only with an objective', () => {
        const withObjective = fight({ win: 'protect', ward: 'Mara', rounds: 4 }, 4);
        const session = sessionOf(withObjective.state, withObjective.events);
        const range = { fromSeq: 1, toSeq: withObjective.events[withObjective.events.length - 1].seq };
        expect(directiveForRange(session, range, 'side', 'standard')).toContain('Stakes: the party\'s aim is to keep Mara alive for 4 rounds');
        const plain = fight(undefined, 4);
        const plainSession = sessionOf(plain.state, plain.events);
        expect(directiveForRange(plainSession, { fromSeq: 1, toSeq: plain.events[plain.events.length - 1].seq }, 'side', 'standard')).not.toContain('Stakes:');
    });
});

describe('the outcome told to the story model and posted in chat', () => {
    const escapeObjective = (extra: Partial<CombatObjective> = {}): CombatObjective => ({
        win: { kind: 'escape', exits: [{ x: 5, y: 0 }], everyone: false },
        result: { status: 'won', by: 'escape', round: 3, outcome: 'victory' },
        ...extra,
    });

    it('calls a party member who left by the exit escaped, never unconscious', () => {
        const s = hand(escapeObjective(), { outcome: 'victory' });
        s.combatants.pc = { ...s.combatants.pc, status: 'escaped', position: undefined, hp: 9 };
        s.combatants.boss = { ...s.combatants.boss, status: 'up' };
        const aftermath = buildAftermathText(sessionOf(s));
        expect(aftermath).toContain('Kira (escaped, badly hurt)');
        expect(aftermath).not.toContain('unconscious');
        expect(aftermath).toContain('Got out through the exit: Kira. They are safe and alive.');
        expect(aftermath).toContain('Objective achieved by getting out through the exit.');
        expect(aftermath).toContain('Survivors:');
        expect(aftermath.match(/Casualties: (.*)\./)?.[1]).toBe('none');
        const result = buildResultText(s);
        expect(result).toContain('Objective achieved by getting out through the exit.');
        expect(result).toContain('Left through the exit: Kira.');
        expect(result).not.toContain('Down:');
    });

    it('does not call a fight lost by time "unconscious and at the victors\' mercy" while the party stands', () => {
        const o: CombatObjective = {
            win: { kind: 'survive', rounds: 5 }, lose: [{ kind: 'round_limit' }], roundLimit: 5,
            result: { status: 'lost', by: 'round_limit', round: 5, outcome: 'defeat' },
        };
        const s = hand(o, { outcome: 'defeat' });
        const text = buildAftermathText(sessionOf(s));
        expect(text).not.toContain('unconscious and at the victors');
        expect(text).toContain('The fight was lost although the party is not beaten: time ran out.');
        expect(text).toContain('Those still standing: Kira, Mara.');
        expect(text).toContain('Objective lost: time ran out.');
    });

    it('says the ward fell, or the leader got away', () => {
        const ward: CombatObjective = {
            win: { kind: 'protect', wardId: 'w', rounds: 4 }, lose: [{ kind: 'ward_falls', wardId: 'w' }],
            result: { status: 'lost', by: 'ward_falls', round: 2, outcome: 'defeat' },
        };
        const s = hand(ward, { outcome: 'defeat' });
        s.combatants.w = { ...s.combatants.w, status: 'down', hp: 0 };
        const text = buildAftermathText(sessionOf(s));
        expect(text).toContain('the ward fell');
        expect(text).toContain('Those still standing: Kira.');
        const leader: CombatObjective = {
            win: { kind: 'defeat_leader', leaderId: 'boss' }, lose: [{ kind: 'leader_escapes', leaderId: 'boss', exits: [{ x: 0, y: 3 }] }],
            result: { status: 'lost', by: 'leader_escapes', round: 3, outcome: 'defeat' },
        };
        const l = hand(leader, { outcome: 'defeat' });
        l.combatants.boss = { ...l.combatants.boss, status: 'escaped', position: undefined };
        const lt = buildAftermathText(sessionOf(l));
        expect(lt).toContain('the enemy leader got away');
        expect(lt).toContain('Vey escaped through the exit and is still at large.');
        expect(lt).not.toContain('Vey (down)');
        expect(conditionForCombatant(l.combatants.boss)).toBe('healthy');
    });

    it('keeps the old text when the party is beaten, and when there is no objective', () => {
        const beaten = hand({ win: { kind: 'survive', rounds: 5 }, result: { status: 'lost', by: 'defeat', round: 3, outcome: 'defeat' } }, { outcome: 'defeat' });
        beaten.combatants.pc = { ...beaten.combatants.pc, status: 'down', hp: 0 };
        beaten.combatants.w = { ...beaten.combatants.w, status: 'down', hp: 0 };
        expect(buildAftermathText(sessionOf(beaten))).toContain('The party is unconscious and at the victors\' mercy.');
        const none = hand(undefined, { outcome: 'victory' });
        const text = buildAftermathText(sessionOf(none));
        expect(text).not.toContain('bjective');
        expect(buildResultText(none)).not.toContain('bjective');
    });

    it('says whether the side aim was met and which reinforcements came', () => {
        const o: CombatObjective = {
            win: { kind: 'survive', rounds: 4 }, side: { kind: 'no_one_falls' },
            result: { status: 'won', by: 'survive', round: 4, outcome: 'victory', side: { kind: 'no_one_falls', met: false } },
        };
        const s = hand(o, { outcome: 'victory' });
        const log = [ev(3, 'reinforcements_arrive', { waveId: 'r1', units: [{ id: 'r1', name: 'Raider' }, { id: 'r2', name: 'Thug' }], waiting: 0 })];
        const text = buildAftermathText(sessionOf(s, log));
        expect(text).toContain('Objective achieved by holding out to the end. Side aim (no one in the party falls): missed.');
        expect(text).toContain('Reinforcements arrived during the fight: Raider, Thug.');
        expect(objectiveResultClause(hand(undefined))).toBe('');
    });

    it('an objective that ends by parley or flight is not called won or lost', () => {
        const o: CombatObjective = { win: { kind: 'seize', tile: { x: 3, y: 3 } }, result: { status: 'ended', by: 'parley', round: 2, outcome: 'truce' } };
        expect(buildAftermathText(sessionOf(hand(o, { outcome: 'truce' })))).toContain('Objective not decided: the sides stopped fighting after words.');
    });
});

describe('real fights end with a result the host can read', () => {
    it('writes an objective line into the aftermath for every kind', () => {
        const kinds: ProposedObjective[] = [
            { win: 'defeat_leader', leader: 'Captain Vey' }, { win: 'survive', rounds: 3 }, { win: 'escape' }, { win: 'protect', ward: 'Mara', rounds: 3 }, { win: 'seize' },
        ];
        for (const objective of kinds) {
            const { created, log, final } = play(objective, 6);
            expect(final.outcome, objective.win).not.toBeNull();
            const text = buildAftermathText(sessionOf(final, log));
            expect(text, objective.win).toMatch(/Objective (achieved|lost|not decided)/);
            expect(text).toContain("The fight's objective was to");
            expect(created.state.objective?.result).toBeUndefined();
        }
    });
});
