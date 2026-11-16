import { describe, it, expect } from 'vitest';
import { applyAction, currentActorId, planTurn, stepEngine } from '@narrative/engine';
import type { CombatEvent, CombatState, Combatant, Grid, Pos, Tile } from '@narrative/engine';
import { groupEventsByTurn, narrationLine, stateAtSeq, turnLines } from '../combatEvents';
import { parseCombatArgs } from '../combatProposal';
import { buildCombatantSpecs, engineIntents } from '../combatController';
import { compendiumFor } from '../compendiumLookup';
import { buildManualStartPrompt } from '../combatManualStart';
import { getToolDefinitions } from '../../turn/toolHandlers';

const TILE: Record<string, Tile> = { '.': 'floor', o: 'cover', '^': 'hazard', '#': 'wall' };

function gridOf(rows: string[]): Grid {
    return { width: rows[0].length, height: rows.length, tiles: rows.join('').split('').map(ch => TILE[ch] ?? 'floor') };
}

function unit(id: string, side: Combatant['side'], at: Pos, extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id === 'pc' ? 'Kira' : id.charAt(0).toUpperCase() + id.slice(1), side, controller: side === 'player' ? 'player' : 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 30, hp: 30, ac: 12, attackBonus: 4, damage: { count: 1, sides: 6, bonus: 1, type: 'slashing' },
        initiative: 10, status: 'up', conditions: [], position: at, range: 'close', ...extra,
    };
}

function board(rows: string[], units: Combatant[], seed = 3): CombatState {
    return {
        id: 'h', round: 2, order: units.map(u => u.id), turnIndex: 0, combatants: Object.fromEntries(units.map(u => [u.id, u])),
        rngSeed: seed, rngCursor: 0, eventSeq: 0, outcome: null, grid: gridOf(rows), turnCount: 1,
        turnStart: { actorId: units[0].id, pos: { ...(units[0].position as Pos) } },
    };
}

function engineTurn(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    let s = state;
    const events: CombatEvent[] = [];
    const id = currentActorId(s);
    for (let i = 0; i < 12 && !s.outcome && currentActorId(s) === id; i++) {
        const step = stepEngine(s);
        if (!step) break;
        events.push(...step.events);
        s = step.state;
    }
    return { state: s, events };
}

function linesOf(state: CombatState, events: CombatEvent[]): string[] {
    return groupEventsByTurn(events).flatMap(g => turnLines(g, state, { numbers: false }));
}

describe('an enemy turn with the new actions narrates correctly', () => {
    it('a bonus Shove after an attack', () => {
        const rows = ['..........', '......^^..', '......^^..', '......^^..', '..........'];
        for (let seed = 1; seed < 40; seed++) {
            const s = board(rows, [unit('brute', 'enemy', { x: 4, y: 2 }, { tier: 'elite' }), unit('pc', 'player', { x: 5, y: 2 }, { hp: 99, maxHp: 99 })], seed);
            expect(planTurn(s, 'brute').steps.some(a => a.type === 'use_ability' && a.abilityId === 'builtin:shove')).toBe(true);
            const r = engineTurn(s);
            const pushed = r.events.find(e => e.type === 'pushed');
            if (!pushed) continue;
            const lines = linesOf(r.state, r.events);
            expect(lines).toContain('Brute shoves Kira back.');
            expect(lines.some(l => l.includes('hurt by the') || l.includes('hazard'))).toBe(true);
            expect(lines.every(l => l.trim().length > 0)).toBe(true);
            return;
        }
        throw new Error('no seed produced a landed shove');
    });

    it('a Throw of a cover object', () => {
        const rows = ['...o...', '...o...', '...o...', '...o...', '...o...'];
        const s = board(rows, [unit('ogre', 'enemy', { x: 2, y: 2 }, { tier: 'elite' }), unit('pc', 'player', { x: 4, y: 2 })]);
        const r = engineTurn(s);
        const thrown = r.events.find(e => e.type === 'thrown')!;
        expect(thrown.actorId).toBe('ogre');
        const line = narrationLine(thrown, r.state);
        expect(line).toMatch(/^Ogre /);
        expect(line.length).toBeGreaterThan(10);
        expect(linesOf(r.state, r.events).some(l => l.startsWith('Ogre'))).toBe(true);
    });

    it('a Help that hauls a fallen enemy back up', () => {
        const rows = ['........', '........', '........', '........'];
        const s = board(rows, [
            unit('captain', 'enemy', { x: 3, y: 1 }, { tier: 'elite', tactic: 'support' }),
            unit('grunt', 'enemy', { x: 4, y: 1 }, { status: 'down', hp: 0 }),
            unit('pc', 'player', { x: 7, y: 3 }),
        ]);
        const r = engineTurn(s);
        const rallied = r.events.find(e => e.type === 'rallied')!;
        expect(rallied).toBeDefined();
        expect(narrationLine(rallied, r.state)).toBe('Captain hauls Grunt back to their feet.');
        expect(r.state.combatants.grunt.status).toBe('up');
    });

    it('replays through stateAtSeq: every recorded seq rebuilds a state that plans the same as the live one did', () => {
        const rows = ['..........', '......^^..', '......^^..', '......^^..', '..........'];
        let s = board(rows, [unit('brute', 'enemy', { x: 4, y: 2 }, { tier: 'elite' }), unit('pc', 'player', { x: 5, y: 2 }, { hp: 99, maxHp: 99 })], 5);
        const log: CombatEvent[] = [];
        const snapshots = new Map<number, CombatState>([[0, s]]);
        for (let i = 0; i < 30 && !s.outcome; i++) {
            const id = currentActorId(s) as string;
            const r = s.combatants[id].controller === 'engine' ? stepEngine(s)! : applyAction(s, planTurn(s, id).steps[0]);
            log.push(...r.events);
            s = r.state;
            snapshots.set(s.eventSeq, s);
        }
        for (const [seq, live] of snapshots) {
            const rebuilt = stateAtSeq(s, log, seq);
            for (const id of Object.keys(live.combatants)) {
                expect(rebuilt.combatants[id].position).toEqual(live.combatants[id].position);
                expect(rebuilt.combatants[id].hp).toEqual(live.combatants[id].hp);
            }
        }
    });
});

describe('tactic at fight start', () => {
    it('start_combat and the manual-start prompt describe tactic, one line each', () => {
        const tools = getToolDefinitions({ allowDiceTool: false, allowCombatTool: true }) as Array<{ function: { name: string; parameters: { properties: { combatants: { items: { properties: Record<string, { enum?: string[]; description?: string }> } } } } } }>;
        const combat = tools.find(t => t.function.name === 'start_combat')!;
        const tactic = combat.function.parameters.properties.combatants.items.properties.tactic;
        expect(tactic.enum).toEqual(['aggressive', 'skirmisher', 'guard', 'hunter', 'coward', 'berserker', 'support']);
        for (const name of tactic.enum!) expect(tactic.description!.split('\n').filter(l => l.startsWith(`${name}:`))).toHaveLength(1);
        const prompt = buildManualStartPrompt([], 'Kira');
        for (const name of tactic.enum!) expect(prompt).toContain(`- ${name}: `);
    });

    it('parses tactic like speech: known values kept, case folded, unknown dropped', () => {
        const parsed = parseCombatArgs({ combatants: [{ name: 'A', tactic: 'Hunter' }, { name: 'B', tactic: 'sneaky' }, { name: 'C' }] });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.combatants.map(c => c.tactic)).toEqual(['hunter', undefined, undefined]);
    });

    it('the model value wins over the compendium, which wins over the derived default', () => {
        const wolf = { id: 'w', name: 'Wolf', stats: [], tactic: 'hunter' };
        const lookup = { modTables: { 'mod.enemies.compendium': [wolf] }, settings: { moduleEnabled: {} } };
        expect(compendiumFor({ name: 'Wolf', species: 'wolf' }, lookup).tactic).toBe('hunter');
        const specs = buildCombatantSpecs([
            { name: 'Wolf 1', side: 'enemy', tier: 'grunt', species: 'wolf' },
            { name: 'Wolf 2', side: 'enemy', tier: 'grunt', species: 'wolf', tactic: 'coward' },
            { name: 'Bandit', side: 'enemy', tier: 'grunt' },
        ], lookup);
        expect(specs.map(s => s.tactic)).toEqual(['hunter', 'coward', undefined]);
    });

    it('exposes each engine unit\'s intent without changing the state', () => {
        const s = board(['........', '........'], [unit('brute', 'enemy', { x: 1, y: 0 }), unit('pc', 'player', { x: 6, y: 1 })]);
        const before = JSON.stringify(s);
        expect(engineIntents(s)).toEqual({ brute: { kind: 'attack', targetId: 'pc' } });
        expect(JSON.stringify(s)).toBe(before);
        expect(engineIntents({ ...s, outcome: 'victory' })).toEqual({});
    });
});
