import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SendArgs = [unknown, Array<{ role: string; content: string }>, (t: string) => void, (t: string) => void, (e: string) => void, unknown, AbortController, unknown, unknown, string];
const sends: SendArgs[] = [];

vi.mock('../../chatEngine', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../chatEngine')>();
    return {
        ...actual,
        sendMessage: vi.fn((...args: SendArgs) => { sends.push(args); return Promise.resolve(); }),
    };
});

import { buildPcCombatant, createCombat } from '@narrative/engine';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import {
    beatDirective, buildCombatBlock, directiveForRange, fallbackManner, FIGHT_MANNERS, FLOURISH_LABEL, MAX_VOICE_LINES, queueCombatNarration,
    resetCombatNarrationForTests, rewriteCombatBeat, stripBeatText, voiceLines, waitForCombatNarration,
} from '../combatNarration';
import { hitSeverity, momentTags, narrationLine } from '../combatEvents';
import { attachFlourish, buildCombatantSpecs, cleanFlourish, takesFlourish } from '../combatController';
import { parseCombatArgs } from '../combatProposal';
import type { CombatEvent, CombatNarrationLength, CombatSession, CombatSheet, CombatState, Combatant, NPCEntry } from '../../../types';

function fighter(id: string, side: Combatant['side'], extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side, controller: side === 'player' ? 'player' : 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 10, status: 'up', conditions: [], ...extra,
    };
}

function stateOf(list: Combatant[], extra: Partial<CombatState> = {}): CombatState {
    return {
        id: 'n1', round: 1, order: list.map(c => c.id), turnIndex: 0, combatants: Object.fromEntries(list.map(c => [c.id, c])),
        rngSeed: 77, rngCursor: 0, eventSeq: 0, outcome: null, ...extra,
    };
}

const ev = (seq: number, type: string, data: Record<string, unknown>, actorId?: string, targetId?: string): CombatEvent => ({
    seq, round: 1, turn: seq, type, data, text: `${type} ${seq}`, ...(actorId ? { actorId } : {}), ...(targetId ? { targetId } : {}),
});

const LOCKED = [
    'every listed event happens, in the listed order, with the listed result',
    'Add no other attacks, hits, misses, wounds that would matter, deaths, falls, escapes, surrenders, arrivals or changes of position',
    'State no numbers',
    'Settle nothing about what happens next',
    'Do not invent speech, thoughts or decisions for them',
];

beforeEach(() => {
    sends.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    useAppStore.setState({
        activeCampaignId: 'c1',
        messages: [{ id: 'gm', role: 'assistant', content: 'They attack.', timestamp: 1 }],
        combatSession: null,
        npcLedger: [],
        getActiveStoryEndpoint: () => ({ endpoint: 'http://x', apiKey: '', modelName: 'm' }) as never,
    });
});

afterEach(() => {
    resetCombatNarrationForTests();
    cancelPendingSaves();
    vi.unstubAllGlobals();
});

describe('N1/N4 beatDirective', () => {
    const lengths: CombatNarrationLength[] = ['brief', 'standard', 'rich'];

    it('keeps every locked rule in every length, set piece and flourish combination', () => {
        for (const length of lengths) {
            for (const opening of [false, true]) {
                for (const ending of [false, true]) {
                    for (const flourish of [false, true]) {
                        const text = beatDirective({ length, opening, ending, flourish });
                        for (const rule of LOCKED) expect(text).toContain(rule);
                        expect(text).toContain('This reply is a combat beat: no one leaves this place, and you add no hidden comment or movement tag of any kind.');
                        expect(text).toContain('Free, and wanted');
                        expect(text).toContain('action first, then the people');
                        expect(text).toContain('Coarse language is welcome');
                        expect(text).toContain('do not reuse an opening, image or insult');
                        expect(text.includes('honour its manner and quote any speech')).toBe(flourish);
                        expect(text.includes('set the scene, show the sides sizing each other up')).toBe(opening);
                        expect(text.includes('what the survivors do with their hands, without deciding what happens next')).toBe(ending);
                    }
                }
            }
        }
    });

    it('sets the length per setting and goes one step up for the opening, the ending and cadence end', () => {
        expect(beatDirective({ length: 'brief' })).toContain('two to four sentences');
        expect(beatDirective({ length: 'standard' })).toContain('one or two paragraphs, roughly 80 to 160 words');
        expect(beatDirective({ length: 'rich' })).toContain('two to four paragraphs, roughly 160 to 320 words');
        expect(beatDirective({ length: 'brief', opening: true })).toContain('80 to 160 words');
        expect(beatDirective({ length: 'standard', ending: true })).toContain('160 to 320 words');
        expect(beatDirective({ length: 'standard', setPiece: true })).toContain('160 to 320 words');
        const richSet = beatDirective({ length: 'rich', opening: true });
        expect(richSet).toContain('160 to 320 words');
        expect(richSet).toContain('upper end');
        expect(beatDirective({ length: 'rich' })).toContain('when only one or two events are listed, stay at the lower end');
        expect(beatDirective()).toBe(beatDirective({ length: 'standard' }));
    });
});

describe('movement comments never reach a beat', () => {
    it('strips a complete MOVEMENT comment and an unterminated one while streaming', () => {
        expect(stripBeatText('Steel rings on stone.\n<!-- MOVEMENT {"action":"stay"} -->')).toBe('Steel rings on stone.');
        expect(stripBeatText('Steel rings on stone. <!-- movement {"action":"depart","place":"x"} --> Vey spits.')).toBe('Steel rings on stone.  Vey spits.');
        expect(stripBeatText('Steel rings on stone.\n<!-- MOVEMENT {"act')).toBe('Steel rings on stone.');
        expect(stripBeatText('Steel rings on stone.\n<!-- MOVEMENT')).toBe('Steel rings on stone.');
        expect(stripBeatText('Scene #4 | Steel rings. <!-- note -->')).toBe('Steel rings. <!-- note -->');
    });

    it('keeps the comment out of a streamed beat, partial and final', async () => {
        const pc = buildPcCombatant({ name: 'Kira', sheet: { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } });
        const created = createCombat({ id: 'mv', combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }] }, pc, 3);
        const s: CombatSession = { state: created.state, log: created.events, narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'r' };
        useAppStore.getState().setCombatSession(s);
        queueCombatNarration(s, 'end', true);
        await vi.waitFor(() => expect(sends).toHaveLength(1));
        const beat = () => useAppStore.getState().messages.find(m => m.combatBeat)!;
        sends[0][2]('Mud sucks at their boots. <!-- MOVEMENT {"acti');
        expect(beat().content).toBe('Mud sucks at their boots.');
        sends[0][3]('Mud sucks at their boots. <!-- MOVEMENT {"action":"depart","place":"town"} -->');
        await waitForCombatNarration();
        expect(beat().content).toBe('Mud sucks at their boots.');
    });
});

describe('N3 severity and near misses', () => {
    const s = stateOf([fighter('A', 'player'), fighter('B', 'enemy')]);
    const hit = (damage: number, extra: Record<string, unknown> = {}) => ev(1, 'attack', { hit: true, crit: false, damage, damageType: 'slashing', hpAfter: 20 - damage, ...extra }, 'A', 'B');
    const miss = (total: number, extra: Record<string, unknown> = {}) => ev(1, 'attack', { hit: false, crit: false, total, ac: 12, fumble: false, ...extra }, 'A', 'B');

    it('words a hit by damage against maximum HP at each boundary', () => {
        expect(narrationLine(hit(2), s)).toBe('A grazes B (slashing).');
        expect(narrationLine(hit(3), s)).toBe('A hits B (slashing).');
        expect(narrationLine(hit(6), s)).toBe('A hits B (slashing).');
        expect(narrationLine(hit(7), s)).toBe('A hits B hard (slashing).');
        expect(narrationLine(hit(12), s)).toBe('A hits B hard (slashing).');
        expect(narrationLine(hit(13), s)).toBe('A lands a devastating blow on B (slashing).');
        expect(hitSeverity(hit(10, { absorbed: 8 }), s)).toBe('graze');
    });

    it('lets a critical keep its own wording over any severity', () => {
        expect(narrationLine(hit(2, { crit: true }), s)).toBe('A lands a critical hit on B (slashing).');
        expect(narrationLine(hit(19, { crit: true }), s)).toBe('A lands a critical hit on B (slashing).');
    });

    it('words a miss by how close the roll came, and a guard or shield turns a close one aside', () => {
        expect(narrationLine(miss(10), s)).toBe('A narrowly misses B.');
        expect(narrationLine(miss(11), s)).toBe('A narrowly misses B.');
        expect(narrationLine(miss(9), s)).toBe('A attacks B and misses.');
        expect(narrationLine(miss(11, { defending: true }), s)).toBe('A\'s attack is turned aside by B\'s guard.');
        expect(narrationLine(miss(11, { shielded: true }), s)).toBe('A\'s attack is turned aside by B\'s shield.');
        expect(narrationLine(miss(5, { defending: true }), s)).toBe('A attacks B and misses.');
        expect(narrationLine(miss(14, { fumble: true }), s)).toBe('A attacks B and misses.');
        expect(narrationLine(ev(1, 'ability_attack', { ability: 'Bolt', hit: false, total: 11, ac: 12 }, 'A', 'B'), s)).toBe('Bolt narrowly misses B.');
        expect(narrationLine(ev(1, 'ability_attack', { ability: 'Bolt', hit: false, total: 11, ac: 12, defending: true }, 'A', 'B'), s)).toBe('Bolt is turned aside by B\'s guard.');
    });

    it('says "only just" for a save within 2 of the DC either way', () => {
        const save = (total: number, success: boolean) => ev(1, 'save', { save: 'DEX', dc: 13, total, success }, 'A', 'B');
        expect(narrationLine(save(15, true), s)).toBe('B only just dives clear of the worst of it.');
        expect(narrationLine(save(16, true), s)).toBe('B dives clear of the worst of it.');
        expect(narrationLine(save(11, false), s)).toBe('B only just fails to get clear and is caught.');
        expect(narrationLine(save(10, false), s)).toBe('B is caught full on.');
    });

    it('names the weapon on a weapon attack when one is known', () => {
        expect(narrationLine(hit(7, { weapon: 'hand-axe' }), s)).toBe('A hits B hard with the hand-axe (slashing).');
        expect(narrationLine(miss(11, { weapon: 'her hand-axe' }), s)).toBe('A narrowly misses B with her hand-axe.');
    });

    it('renders old events that lack the new fields exactly as before', () => {
        const legacy = stateOf([fighter('pc', 'player', { name: 'Kira' }), fighter('x', 'enemy', { name: 'Bandit 1' })]);
        const lines = [
            ev(1, 'attack', { hit: true, crit: false, damageType: 'slashing' }, 'pc', 'x'),
            ev(2, 'attack', { hit: true, crit: true, damageType: 'slashing' }, 'pc', 'x'),
            ev(3, 'attack', { hit: false }, 'x', 'pc'),
            ev(4, 'ability_attack', { ability: 'Bolt', hit: false }, 'pc', 'x'),
            ev(5, 'save', { save: 'CON', success: true }, 'pc', 'x'),
            ev(6, 'save', { save: 'DEX', success: false }, 'pc', 'x'),
            ev(7, 'ability_damage', { damageType: 'fire', saved: true }, 'pc', 'x'),
            ev(8, 'ability_damage', { damageType: 'fire' }, 'pc', 'x'),
        ].map(e => narrationLine(e, legacy));
        expect(lines).toEqual([
            'Kira hits Bandit 1 (slashing).',
            'Kira lands a critical hit on Bandit 1 (slashing).',
            'Bandit 1 attacks Kira and misses.',
            'Bolt misses Bandit 1.',
            'Bandit 1 endures the worst of it.',
            'Bandit 1 is caught full on.',
            'Bandit 1 is grazed by the fire.',
            'Bandit 1 takes the full fire.',
        ]);
    });
});

describe('N3 moment tags', () => {
    function bloodyFight() {
        const final = stateOf([
            fighter('pc', 'player', { hp: 0, status: 'down' }),
            fighter('b1', 'enemy', { hp: 0, status: 'down' }),
            fighter('b2', 'enemy'),
        ]);
        const log: CombatEvent[] = [
            ev(1, 'combat_started', {}),
            ev(2, 'attack', { hit: true, damage: 4, hpAfter: 16 }, 'pc', 'b1'),
            ev(3, 'attack', { hit: true, damage: 8, hpAfter: 8 }, 'pc', 'b1'),
            ev(4, 'attack', { hit: true, damage: 2, hpAfter: 6 }, 'pc', 'b1'),
            ev(5, 'attack', { hit: true, damage: 3, hpAfter: 17 }, 'b2', 'pc'),
            ev(6, 'attack', { hit: true, damage: 9, hpAfter: 0 }, 'pc', 'b1'),
            ev(7, 'down', { side: 'enemy' }, 'pc', 'b1'),
            ev(8, 'attack', { hit: true, damage: 17, hpAfter: 0 }, 'b2', 'pc'),
            ev(9, 'down', { side: 'player' }, 'b2', 'pc'),
        ];
        return { state: final, log };
    }

    it('tags first blood once, the band crossing only on the crossing hit, the kill, the last enemy and the PC falling', () => {
        const { state, log } = bloodyFight();
        const tags = momentTags(state, log, 9);
        expect([...tags.entries()]).toEqual([
            [2, 'first blood'],
            [3, 'now badly hurt'],
            [6, 'killing blow'],
            [7, 'last one standing'],
            [8, 'the player character falls'],
        ]);
        expect([...momentTags(state, log, 9).values()].filter(t => t === 'first blood')).toHaveLength(1);
    });

    it('puts at most one tag on a line, in square brackets, only in the beat block and never in the engine log', () => {
        const { state, log } = bloodyFight();
        const block = buildCombatBlock(state, log, { fromSeq: 1, toSeq: 9 });
        const events = block.split('\n').filter(l => /^\d+\. /.test(l));
        for (const line of events) expect((line.match(/\[[a-z ]+\]/g) ?? []).length).toBeLessThanOrEqual(1);
        expect(block).toContain('[killing blow]');
        expect(block).toContain('[first blood]');
        const later = buildCombatBlock(state, log, { fromSeq: 5, toSeq: 9 });
        expect(later).not.toContain('[first blood]');
        expect(later).toContain('[the player character falls]');
    });

    it('adds the start band to the roster only when it changed during the beat', () => {
        const { state, log } = bloodyFight();
        const block = buildCombatBlock(state, log, { fromSeq: 3, toSeq: 4 });
        expect(block).toContain('- b1 (enemy): hurt → badly hurt');
        expect(block).toContain('- b2 (enemy): unhurt');
        expect(block).not.toContain('b2 (enemy): unhurt →');
    });
});

describe('N2 voices', () => {
    const ledger: NPCEntry[] = [{
        id: 'npc-mara', name: 'Mara', aliases: '', appearance: 'tall', faction: '', storyRelevance: '', status: 'Alive',
        voice: 'Low and gravelly, clipped sentences, swears in an old dockside cant when hurt. '.repeat(3),
        personality: 'Loyal to a fault, sardonic, hides fear behind jokes. '.repeat(3), exampleOutput: '',
    } as NPCEntry];

    function cast(seed = 77): CombatState {
        return stateOf([
            fighter('pc', 'player', { name: 'Kira' }),
            fighter('a1', 'ally', { name: 'Mara', npcId: 'npc-mara' }),
            fighter('c1', 'enemy', { name: 'Bandit 1' }),
            fighter('c2', 'enemy', { name: 'Bandit 2' }),
            fighter('c3', 'enemy', { name: 'Vey', manner: 'icy, imperious' }),
            fighter('s1', 'ally', { name: 'Aqua', summonerId: 'pc' }),
        ], { rngSeed: seed });
    }

    it('lists the combatants involved in the beat first, then the others still standing in initiative order, never the player character or summons', () => {
        const state = cast();
        const log = [ev(1, 'combat_started', {}), ev(2, 'attack', { hit: false }, 'c1', 'pc'), ev(3, 'attack', { hit: false }, 'a1', 'c2')];
        const names = (lines: string[]) => lines.map(l => l.split(' (')[0]);
        const one = voiceLines(state, log, { fromSeq: 2, toSeq: 2 }, ledger);
        expect(one[0]).toMatch(/^- Bandit 1 \(enemy\) — manner: /);
        expect(names(one)).toEqual(['- Bandit 1', '- Mara', '- Bandit 2', '- Vey']);
        expect(names(voiceLines(state, log, { fromSeq: 3, toSeq: 3 }, ledger))).toEqual(['- Mara', '- Bandit 2', '- Bandit 1', '- Vey']);
        const opening = voiceLines(state, log, { fromSeq: 1, toSeq: 1 }, ledger);
        expect(names(opening)).toEqual(['- Mara', '- Bandit 1', '- Bandit 2', '- Vey']);
        expect(opening.join('\n')).not.toContain('Kira');
        expect(opening.join('\n')).not.toContain('Aqua');
    });

    it('leaves out onlookers who are not standing, and caps the section at 6 lines', () => {
        const fallen = stateOf([
            fighter('pc', 'player', { name: 'Kira' }),
            fighter('c1', 'enemy', { name: 'Bandit 1' }),
            fighter('c2', 'enemy', { name: 'Bandit 2', hp: 0, status: 'down' }),
            fighter('c3', 'enemy', { name: 'Bandit 3', status: 'fled' }),
            fighter('c4', 'enemy', { name: 'Bandit 4' }),
        ]);
        const names = voiceLines(fallen, [ev(1, 'attack', { hit: false }, 'c1', 'pc')], { fromSeq: 1, toSeq: 1 }).map(l => l.split(' (')[0]);
        expect(names).toEqual(['- Bandit 1', '- Bandit 4']);
        const crowd = stateOf([fighter('pc', 'player'), ...Array.from({ length: 9 }, (_, i) => fighter(`e${i}`, 'enemy', { name: `Thug ${i + 1}` }))]);
        const capped = voiceLines(crowd, [ev(1, 'attack', { hit: false }, 'e8', 'pc')], { fromSeq: 1, toSeq: 1 });
        expect(capped).toHaveLength(MAX_VOICE_LINES);
        expect(MAX_VOICE_LINES).toBe(6);
        expect(capped[0]).toMatch(/^- Thug 9 /);
        expect(capped.slice(1).map(l => l.split(' (')[0])).toEqual(['- Thug 1', '- Thug 2', '- Thug 3', '- Thug 4', '- Thug 5']);
    });

    it('gives a ledger NPC its voice and personality, trimmed to about 160 characters', () => {
        const line = voiceLines(cast(), [ev(1, 'attack', { hit: false }, 'a1', 'c1')], { fromSeq: 1, toSeq: 1 }, ledger)[0];
        expect(line).toContain('voice: Low and gravelly');
        expect(line).toContain('personality: Loyal to a fault');
        const body = line.split(' — ')[1].replace('voice: ', '').replace('; personality: ', '');
        expect(body.length).toBeLessThanOrEqual(165);
    });

    it('uses the manner from the call, and a seeded fallback stable for the same seed and id and different for identical grunts', () => {
        const state = cast();
        const lines = voiceLines(state, [ev(1, 'combat_started', {})], { fromSeq: 1, toSeq: 1 }, ledger);
        expect(lines).toContain('- Vey (enemy) — manner: icy, imperious');
        expect(fallbackManner(state, 'c1')).toBe(fallbackManner(cast(), 'c1'));
        expect(FIGHT_MANNERS.length).toBeGreaterThanOrEqual(24);
        for (let seed = 1; seed <= 60; seed++) {
            const s = cast(seed);
            expect(fallbackManner(s, 'c1')).not.toBe(fallbackManner(s, 'c2'));
            expect(FIGHT_MANNERS).toContain(fallbackManner(s, 'c1'));
        }
        expect(FIGHT_MANNERS.every(m => m.length <= 40)).toBe(true);
    });

    it('takes an optional manner from start_combat, trimmed to 40 characters, through to the combatant, with no stat change', () => {
        const parsed = parseCombatArgs({ combatants: [{ name: 'Thug', manner: '  sneering,\n overconfident, and louder than anyone needs to be ' }, { name: 'Thug' }], reason: 'r' });
        if (!parsed.ok) throw new Error('parse failed');
        expect(parsed.value.combatants[0].manner).toBe('sneering, overconfident, and louder than');
        expect(parsed.value.combatants[1].manner).toBeUndefined();
        const specs = buildCombatantSpecs(parsed.value.combatants, {});
        expect(specs[0].manner).toBe('sneering, overconfident, and louder than');
        const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };
        const pc = buildPcCombatant({ name: 'Kira', sheet });
        const withManner = createCombat({ id: 'm', combatants: specs }, pc, 9).state;
        const without = createCombat({ id: 'm', combatants: specs.map(s => ({ ...s, manner: undefined })) }, pc, 9).state;
        expect(withManner.combatants.c1.manner).toBe('sneering, overconfident, and louder than');
        const strip = (c: Combatant) => ({ ...c, manner: undefined });
        expect(Object.values(withManner.combatants).map(strip)).toEqual(Object.values(without.combatants).map(strip));
        expect(withManner.rngCursor).toBe(without.rngCursor);
    });
});

describe('terrain in the block', () => {
    it('names only the terrain the map actually has, with no numbers', () => {
        const grid = { width: 3, height: 1, tiles: ['floor', 'cover', 'difficult'] as const, labels: { wall: 'stone walls', cover: 'tombstones', difficult: 'mud', hazard: 'fire' } };
        const state = stateOf([fighter('pc', 'player'), fighter('b', 'enemy')], { grid: { ...grid, tiles: [...grid.tiles] } });
        const block = buildCombatBlock(state, [ev(1, 'attack', { hit: false }, 'b', 'pc')], { fromSeq: 1, toSeq: 1 });
        expect(block.split('\n')[1]).toBe('Terrain: tombstones (cover), mud (difficult ground).');
        expect(buildCombatBlock(stateOf([fighter('pc', 'player')]), [ev(1, 'defend', {}, 'pc')], { fromSeq: 1, toSeq: 1 })).not.toContain('Terrain:');
    });
});

describe('N5 flourish in the block', () => {
    const state = stateOf([fighter('pc', 'player', { name: 'Kira' }), fighter('b', 'enemy', { name: 'Bandit' })]);
    const log = [ev(1, 'defend', {}, 'pc'), ev(2, 'attack', { hit: false }, 'b', 'pc')];

    it('appears under its event line, quoted, with quotes and newlines neutralised', () => {
        const block = buildCombatBlock(state, log, { fromSeq: 1, toSeq: 2 }, { flourishes: [{ seq: 1, text: 'I raise my shield and shout "Come on then!"\nlaughing' }] });
        const lines = block.split('\n');
        const at = lines.findIndex(l => l.startsWith('1. '));
        expect(lines[at + 1]).toBe(`   ${FLOURISH_LABEL} "I raise my shield and shout 'Come on then!' laughing"`);
        expect(lines[at + 2]).toMatch(/^2\. /);
        expect(buildCombatBlock(state, log, { fromSeq: 2, toSeq: 2 }, { flourishes: [{ seq: 1, text: 'x' }] })).not.toContain(FLOURISH_LABEL);
    });

    it('switches the flourish rule on in the directive only for a beat that holds one', () => {
        const session: CombatSession = { state, log, narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: '', flourishes: [{ seq: 1, text: 'x' }] };
        expect(directiveForRange(session, { fromSeq: 1, toSeq: 2 }, 'side', 'standard')).toContain('honour its manner');
        expect(directiveForRange(session, { fromSeq: 2, toSeq: 2 }, 'side', 'standard')).not.toContain('honour its manner');
    });

    it('attaches only to the next attack, ability, defend or flee, cleaned and capped at 200 characters', () => {
        expect(takesFlourish({ type: 'attack', actorId: 'pc', targetId: 'b' })).toBe(true);
        expect(takesFlourish({ type: 'use_ability', actorId: 'pc', abilityId: 'x' })).toBe(true);
        expect(takesFlourish({ type: 'defend', actorId: 'pc' })).toBe(true);
        expect(takesFlourish({ type: 'flee', actorId: 'pc' })).toBe(true);
        expect(takesFlourish({ type: 'move', actorId: 'pc', to: { x: 1, y: 1 } })).toBe(false);
        expect(takesFlourish({ type: 'end_turn', actorId: 'pc' })).toBe(false);
        expect(cleanFlourish(`${'a'.repeat(250)}\n`)).toHaveLength(200);
        const session: CombatSession = { state, log: [], narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: '' };
        const moved = attachFlourish(session, { type: 'move', actorId: 'pc', to: { x: 1, y: 1 } }, [ev(5, 'moved', {}, 'pc')], 'x');
        expect(moved.flourishes).toBeUndefined();
        const defended = attachFlourish(session, { type: 'defend', actorId: 'pc' }, [ev(6, 'defend', {}, 'pc'), ev(7, 'round', {})], '  low  and\nready ');
        expect(defended.flourishes).toEqual([{ seq: 6, text: 'low and ready' }]);
        expect(attachFlourish(session, { type: 'defend', actorId: 'pc' }, [ev(6, 'defend', {}, 'pc')], '   ')).toBe(session);
    });
});

describe('beat streaming with the new directive', () => {
    const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };

    it('stores the directive on the beat, uses the length setting, and Rewrite sends the same prompt', async () => {
        const pc = buildPcCombatant({ name: 'Kira', sheet });
        const created = createCombat({ id: 'f9', combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }] }, pc, 3);
        const s: CombatSession = { state: created.state, log: created.events, narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'r' };
        const ctx = useAppStore.getState().context;
        useAppStore.setState({ context: { ...ctx, combatConfig: { ...ctx.combatConfig!, narrationLength: 'brief' } } });
        useAppStore.getState().setCombatSession(s);
        queueCombatNarration(s, 'action', true);
        await vi.waitFor(() => expect(sends).toHaveLength(1));
        const beat = useAppStore.getState().messages.find(m => m.combatBeat)!;
        expect(beat.combatBeat?.directive).toBe(beatDirective({ length: 'brief', opening: true }));
        const user = sends[0][1][sends[0][1].length - 1].content;
        expect(user.endsWith(beat.combatBeat!.directive!)).toBe(true);
        sends[0][3]('Steel.');
        await waitForCombatNarration();
        const rewrite = rewriteCombatBeat(beat.id);
        await vi.waitFor(() => expect(sends).toHaveLength(2));
        expect(sends[1][1][sends[1][1].length - 1].content).toBe(user);
        sends[1][3]('Again.');
        await rewrite;
    });

    it('rewrites a beat saved before this change with the default directive', async () => {
        useAppStore.setState({
            messages: [
                { id: 'gm', role: 'assistant', content: 'They attack.', timestamp: 1 },
                { id: 'old', role: 'assistant', content: 'Old text.', timestamp: 2, combatBeat: { sessionId: 'x', fromSeq: 1, toSeq: 2, block: '[COMBAT BEAT — resolved by the game engine]\nEvents, in order:\n1. Kira hits Bandit.' } },
            ],
        });
        const rewrite = rewriteCombatBeat('old');
        await vi.waitFor(() => expect(sends).toHaveLength(1));
        expect(sends[0][1][sends[0][1].length - 1].content.endsWith(`[COMBAT BEAT — resolved by the game engine]\nEvents, in order:\n1. Kira hits Bandit.\n\n${beatDirective()}`)).toBe(true);
        sends[0][3]('New text.');
        await rewrite;
        expect(useAppStore.getState().messages.find(m => m.id === 'old')?.content).toBe('New text.');
    });
});
