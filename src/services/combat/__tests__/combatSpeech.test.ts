import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import {
    ANIMAL_MANNERS, beatDirective, buildCombatBlock, directiveForRange, fallbackManner, hasNonSpeaker, SILENT_MANNERS, voiceLines,
} from '../combatNarration';
import { narrationLine } from '../combatEvents';
import { buildCombatantSpecs } from '../combatController';
import { parseCombatArgs } from '../combatProposal';
import { canParley, parleyBlockedBySpeech } from '../combatParley';
import { compendiumFor, ENEMY_COMPENDIUM_KEY } from '../compendiumLookup';
import type { CombatEvent, CombatSession, CombatState, Combatant, NPCEntry } from '../../../types';

function fighter(id: string, side: Combatant['side'], extra: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side, controller: side === 'player' ? 'player' : 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 20, hp: 20, ac: 12, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 10, status: 'up', conditions: [], position: { x: 1, y: 1 }, ...extra,
    };
}

function stateOf(list: Combatant[], extra: Partial<CombatState> = {}): CombatState {
    return {
        id: 's1', round: 1, order: list.map(c => c.id), turnIndex: 0, combatants: Object.fromEntries(list.map(c => [c.id, c])),
        rngSeed: 77, rngCursor: 0, eventSeq: 0, outcome: null,
        grid: { width: 8, height: 5, tiles: new Array(40).fill('floor') }, turnCount: 1,
        turn: { actorId: list[0].id, moveLeft: 6, actionUsed: false }, ...extra,
    };
}

const ev = (seq: number, type: string, data: Record<string, unknown>, actorId?: string, targetId?: string, text = `${type} ${seq}`): CombatEvent => ({
    seq, round: 1, turn: seq, type, data, text, ...(actorId ? { actorId } : {}), ...(targetId ? { targetId } : {}),
});

const pack = () => stateOf([
    fighter('pc', 'player', { name: 'Kira' }),
    fighter('d1', 'enemy', { name: 'Wild dog 1' }),
    fighter('d2', 'enemy', { name: 'Wild dog 2' }),
    fighter('b1', 'enemy', { name: 'Bandit' }),
]);

const range = { fromSeq: 1, toSeq: 2 };
const packLog = [ev(1, 'combat_started', {}), ev(2, 'attack', { hit: false }, 'd1', 'pc')];

describe('F2 parsing and sources', () => {
    it('reads an optional speech value per enemy and drops anything else', () => {
        const parsed = parseCombatArgs({
            combatants: [
                { name: 'Wild dog', speech: 'sounds' }, { name: 'Ooze', speech: ' SILENT ' }, { name: 'Bandit', speech: 'speaks' },
                { name: 'Odd', speech: 'mute' }, { name: 'Plain' },
            ],
            reason: 'r',
        });
        if (!parsed.ok) throw new Error('parse failed');
        expect(parsed.value.combatants.map(c => c.speech)).toEqual(['sounds', 'silent', 'speaks', undefined, undefined]);
    });

    it('lets a ledger NPC speak whatever the call says, then the compendium, then the call, then nothing', () => {
        const ledger = [{ id: 'npc-rex', name: 'Rex' }] as NPCEntry[];
        const parsed = parseCombatArgs({
            combatants: [
                { name: 'Rex', npcName: 'Rex', speech: 'sounds' },
                { name: 'Hound', species: 'Wild dog', speech: 'speaks' },
                { name: 'Wolf', speech: 'sounds' },
                { name: 'Thug' },
            ],
            reason: 'r',
        }, ledger);
        if (!parsed.ok) throw new Error('parse failed');
        const lookup = { modTables: { [ENEMY_COMPENDIUM_KEY]: [{ name: 'Wild dog', speech: 'sounds' }] }, settings: { moduleEnabled: undefined } };
        const specs = buildCombatantSpecs(parsed.value.combatants, lookup);
        expect(specs.map(s => s.speech)).toEqual(['speaks', 'sounds', 'sounds', undefined]);
    });

    it('lets a compendium entry say speech even when it has no stats, and ignores an invalid value', () => {
        const withSpeech = { modTables: { [ENEMY_COMPENDIUM_KEY]: [{ name: 'Gray ooze', speech: 'silent' }] }, settings: { moduleEnabled: undefined } };
        expect(compendiumFor({ name: 'Gray ooze', species: 'Gray ooze' }, withSpeech)).toEqual({ source: { kind: 'tier' }, speech: 'silent' });
        const bad = { modTables: { [ENEMY_COMPENDIUM_KEY]: [{ name: 'Gray ooze', speech: 'chatty' }] }, settings: { moduleEnabled: undefined } };
        expect(compendiumFor({ name: 'Gray ooze', species: 'Gray ooze' }, bad)).toEqual({ source: { kind: 'tier' } });
    });
});

describe('F2 narration', () => {
    it('writes an animal line, a silent line and a speaker line, each with a manner', () => {
        const state = stateOf([
            fighter('pc', 'player', { name: 'Kira' }),
            fighter('d1', 'enemy', { name: 'Wild dog 1' }),
            fighter('o1', 'enemy', { name: 'Gray ooze' }),
            fighter('b1', 'enemy', { name: 'Bandit' }),
        ]);
        const lines = voiceLines(state, [ev(1, 'combat_started', {})], { fromSeq: 1, toSeq: 1 });
        expect(lines[0]).toMatch(/^- Wild dog 1 \(enemy\) — animal: makes only sounds \(growls, barks, yelps\), never words; manner: .+/);
        expect(lines[1]).toMatch(/^- Gray ooze \(enemy\) — does not speak or cry out; manner: .+/);
        expect(lines[2]).toMatch(/^- Bandit \(enemy\) — manner: .+/);
        expect(ANIMAL_MANNERS).toContain(lines[0].split('manner: ')[1]);
        expect(SILENT_MANNERS).toContain(lines[1].split('manner: ')[1]);
    });

    it('draws animal manners from their own list of at least sixteen, distinct for identical animals', () => {
        expect(ANIMAL_MANNERS.length).toBeGreaterThanOrEqual(16);
        expect(ANIMAL_MANNERS.every(m => m.length <= 40)).toBe(true);
        expect(SILENT_MANNERS.length).toBeGreaterThanOrEqual(4);
        const four = stateOf([
            fighter('pc', 'player'),
            ...[1, 2, 3, 4].map(i => fighter(`d${i}`, 'enemy', { name: `Wild dog ${i}` })),
        ]);
        const manners = ['d1', 'd2', 'd3', 'd4'].map(id => fallbackManner(four, id));
        expect(new Set(manners).size).toBe(4);
        for (const m of manners) expect(ANIMAL_MANNERS).toContain(m);
    });

    it('keeps a manner supplied for a non-speaker, and honours a stored speech over the name', () => {
        const state = stateOf([
            fighter('pc', 'player'),
            fighter('d1', 'enemy', { name: 'Wild dog', manner: 'lame, but vicious' }),
            fighter('w1', 'enemy', { name: 'Wolf', speech: 'speaks', manner: 'refined, quiet' }),
        ]);
        const lines = voiceLines(state, [ev(1, 'combat_started', {})], { fromSeq: 1, toSeq: 1 });
        expect(lines[0]).toBe('- Wild dog (enemy) — animal: makes only sounds (growls, barks, yelps), never words; manner: lame, but vicious');
        expect(lines[1]).toBe('- Wolf (enemy) — manner: refined, quiet');
    });

    it('treats saved fights without the field by the keyword fallback, without touching them', () => {
        const saved = pack();
        expect('speech' in saved.combatants.d1).toBe(false);
        const lines = voiceLines(saved, packLog, range);
        expect(lines.filter(l => l.includes('animal: makes only sounds'))).toHaveLength(2);
        expect('speech' in saved.combatants.d1).toBe(false);
    });

    it('adds the directive sentence only when a non-speaker is in the Voices', () => {
        const sentence = 'never speak words, curse or reason; give them sound, movement and instinct instead';
        expect(beatDirective({ nonSpeakers: true })).toContain(sentence);
        expect(beatDirective({})).not.toContain(sentence);
        expect(beatDirective({ nonSpeakers: false })).not.toContain(sentence);
        const session = (state: CombatState, log: CombatEvent[]): CombatSession => ({ state, log, narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'x' });
        expect(directiveForRange(session(pack(), packLog), range, 'action', 'standard')).toContain(sentence);
        const people = stateOf([fighter('pc', 'player'), fighter('b1', 'enemy', { name: 'Bandit 1' }), fighter('b2', 'enemy', { name: 'Bandit 2' })]);
        expect(directiveForRange(session(people, packLog), range, 'action', 'standard')).not.toContain(sentence);
        expect(hasNonSpeaker(people, packLog, range)).toBe(false);
        expect(hasNonSpeaker(pack(), packLog, range)).toBe(true);
    });

    it('builds a beat block for two dogs and a bandit', () => {
        const state = pack();
        const log = [
            ev(1, 'combat_started', { combatants: [{ id: 'pc' }, { id: 'd1' }, { id: 'd2' }, { id: 'b1' }] }),
            ev(2, 'attack', { hit: false }, 'd1', 'pc'),
        ];
        const block = buildCombatBlock(state, log, range);
        const voices = block.slice(block.indexOf('Voices:'), block.indexOf('Events, in order:'));
        expect(voices).toContain('- Wild dog 1 (enemy) — animal: makes only sounds (growls, barks, yelps), never words; manner: ');
        expect(voices).toContain('- Wild dog 2 (enemy) — animal: makes only sounds (growls, barks, yelps), never words; manner: ');
        expect(voices).toMatch(/- Bandit \(enemy\) — manner: /);
    });
});

describe('F1 narration lines', () => {
    const state = stateOf([fighter('pc', 'player', { name: 'Kira' }), fighter('d2', 'enemy', { name: 'Wild dog 2' })]);

    it('says a shove moved the target, or plainly that it did not move', () => {
        const moved = ev(3, 'pushed', { kind: 'push', squares: 2, builtin: 'shove' }, 'pc', 'd2');
        const pinned = ev(3, 'pushed', { kind: 'push', squares: 0, builtin: 'shove', moves: [] }, 'pc', 'd2');
        expect(narrationLine(moved, state)).toBe('Kira shoves Wild dog 2 back.');
        expect(narrationLine(pinned, state)).toBe('Kira shoves Wild dog 2, but Wild dog 2 is pinned in place and does not move.');
    });

    it('does the same for a kit push, a pull and a stunt', () => {
        const kit = (squares: number, kind = 'push') => ev(3, 'pushed', { kind, squares, ability: 'Gust' }, 'pc', 'd2');
        expect(narrationLine(kit(2), state)).toBe('Wild dog 2 is thrown back.');
        expect(narrationLine(kit(0), state)).toBe('Wild dog 2 is pushed, but is pinned in place and does not move.');
        expect(narrationLine(kit(2, 'pull'), state)).toBe('Wild dog 2 is dragged toward Kira.');
        expect(narrationLine(kit(0, 'pull'), state)).toBe('Wild dog 2 is pulled, but is pinned in place and does not move.');
        expect(narrationLine(ev(3, 'pushed', { kind: 'push', squares: 0, builtin: 'stunt' }, 'pc', 'd2'), state)).toBe('Wild dog 2 is pinned in place and does not move.');
    });

    it('carries no numbers', () => {
        const line = narrationLine(ev(3, 'pushed', { kind: 'push', squares: 0, builtin: 'shove' }, 'pc', 'd2'), state);
        expect(line.replaceAll('Wild dog 2', '')).not.toMatch(/\d/);
    });
});

describe('F2 parley', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
        useAppStore.setState({ activeCampaignId: 'c1', combatSession: null, combatBusy: false });
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    const sessionOf = (enemies: Combatant[]): CombatSession => ({
        state: stateOf([fighter('pc', 'player', { name: 'Kira' }), ...enemies]),
        log: [], narratedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'x',
    });

    it('is blocked with a reason when only animals stand', () => {
        const dogs = sessionOf([fighter('d1', 'enemy', { name: 'Wild dog 1' }), fighter('d2', 'enemy', { name: 'Wild dog 2' })]);
        expect(canParley(dogs, false)).toBe(false);
        expect(parleyBlockedBySpeech(dogs, false)).toBe(true);
        const oozes = sessionOf([fighter('o1', 'enemy', { name: 'Gray ooze' })]);
        expect(parleyBlockedBySpeech(oozes, false)).toBe(true);
    });

    it('is open for a mixed group and for speakers only', () => {
        const mixed = sessionOf([fighter('d1', 'enemy', { name: 'Wild dog 1' }), fighter('b1', 'enemy', { name: 'Bandit' })]);
        expect(canParley(mixed, false)).toBe(true);
        expect(parleyBlockedBySpeech(mixed, false)).toBe(false);
        const people = sessionOf([fighter('b1', 'enemy', { name: 'Bandit' })]);
        expect(canParley(people, false)).toBe(true);
        const talkingWolf = sessionOf([fighter('w1', 'enemy', { name: 'Wolf', speech: 'speaks' })]);
        expect(canParley(talkingWolf, false)).toBe(true);
    });

    it('shows nothing extra when it is not the player\'s turn or the action is spent', () => {
        const dogs = sessionOf([fighter('d1', 'enemy', { name: 'Wild dog 1' })]);
        const spent: CombatSession = { ...dogs, state: { ...dogs.state, turn: { actorId: 'pc', moveLeft: 6, actionUsed: true } } };
        expect(parleyBlockedBySpeech(spent, false)).toBe(false);
        expect(parleyBlockedBySpeech(dogs, true)).toBe(false);
    });
});
