import { describe, it, expect } from 'vitest';
import {
    applyAction, buildMoraleBook, buildPcCombatant, canSpeak, checkParley, createCombat, currentTurn, inferSpeech, normalizeSpeech, resolveSpeaker,
    SILENT_KEYWORDS, SOUNDS_KEYWORDS, speechOf,
} from '../index';
import type { CombatEvent, CombatState, Combatant, Speech } from '../index';
import { arena, caster, foe } from './glyphFixtures';

const infer = (name: string, extra: Partial<Combatant> = {}): Speech => inferSpeech({ name, ...extra });

describe('the keyword table', () => {
    it('holds at least sixty words', () => {
        expect(SOUNDS_KEYWORDS.length + SILENT_KEYWORDS.length).toBeGreaterThanOrEqual(60);
        for (const word of ['dog', 'wolf', 'bear', 'boar', 'rat', 'spider', 'snake', 'hound', 'beast', 'bat', 'crow', 'shark']) expect(SOUNDS_KEYWORDS).toContain(word);
        for (const word of ['slime', 'ooze', 'golem', 'construct', 'turret', 'drone', 'skeleton', 'zombie', 'swarm', 'elemental']) expect(SILENT_KEYWORDS).toContain(word);
    });

    it('marks animals as sounds and mindless things as silent, whatever the case', () => {
        expect(infer('Wild dog 2')).toBe('sounds');
        expect(infer('GIANT SPIDER')).toBe('sounds');
        expect(infer('Dire Wolf')).toBe('sounds');
        expect(infer('Gelatinous Ooze')).toBe('silent');
        expect(infer('Clockwork Golem')).toBe('silent');
        expect(infer('Sentry Turret')).toBe('silent');
        expect(infer('Skeleton')).toBe('silent');
    });

    it('is plural tolerant, including irregular plurals', () => {
        expect(infer('Dogs')).toBe('sounds');
        expect(infer('Wolves')).toBe('sounds');
        expect(infer('Foxes')).toBe('sounds');
        expect(infer('Bees')).toBe('sounds');
        expect(infer('Mice')).toBe('sounds');
        expect(infer('Rats')).toBe('sounds');
        expect(infer('Oozes')).toBe('silent');
        expect(infer('Zombies')).toBe('silent');
        expect(infer('Mimics')).toBe('silent');
    });

    it('matches whole words only', () => {
        expect(infer('Ratcatcher')).toBe('speaks');
        expect(infer('Doghouse Keeper')).toBe('speaks');
        expect(infer('Batman')).toBe('speaks');
        expect(infer('Giant')).toBe('speaks');
        expect(infer('Bandit')).toBe('speaks');
        expect(infer('Mechanic')).toBe('speaks');
        expect(infer('Slimeball Sam')).toBe('speaks');
    });

    it('lets a silent word beat an animal word, and a named species speak for itself', () => {
        expect(infer('Skeleton hound')).toBe('silent');
        expect(infer('Zombie dog')).toBe('silent');
        expect(infer('Wolf', { species: 'human' })).toBe('speaks');
    });

    it('reads the species before the look and the look last', () => {
        expect(infer('Pet', { species: 'wolf' })).toBe('sounds');
        expect(infer('Hunter\'s companion', { look: 'a large grey wolf with a scarred ear' })).toBe('sounds');
        expect(infer('Thing', { look: 'a dripping green ooze' })).toBe('silent');
    });

    it('does not take a worn pelt or a trophy in the look for an animal', () => {
        expect(infer('Bandit', { look: 'scarred, wolf pelt cloak' })).toBe('speaks');
        expect(infer('Raider', { look: 'bear skin over the shoulders, axe' })).toBe('speaks');
        expect(infer('Raider', { look: 'bear teeth necklace' })).toBe('speaks');
    });

    it('treats a ledger NPC and the player as speakers even with an animal name', () => {
        expect(speechOf({ name: 'Rat', side: 'enemy', npcId: 'n1' })).toBe('speaks');
        expect(speechOf({ name: 'Wolf', side: 'player' })).toBe('speaks');
        expect(speechOf({ name: 'Wolf', side: 'enemy' })).toBe('sounds');
    });
});

describe('precedence in the engine', () => {
    it('uses the stored value over the keyword guess, and the guess when nothing is stored', () => {
        expect(speechOf({ name: 'Wolf', side: 'enemy', speech: 'speaks' })).toBe('speaks');
        expect(speechOf({ name: 'Bandit', side: 'enemy', speech: 'silent' })).toBe('silent');
        expect(speechOf({ name: 'Wild dog', side: 'enemy' })).toBe('sounds');
        expect(canSpeak({ name: 'Wild dog', side: 'enemy' })).toBe(false);
    });

    it('normalises only the three values', () => {
        expect(normalizeSpeech(' Sounds ')).toBe('sounds');
        expect(normalizeSpeech('mute')).toBeUndefined();
        expect(normalizeSpeech(3)).toBeUndefined();
    });

    it('createCombat stores a speech value only when the spec carries one', () => {
        const pc = buildPcCombatant({ name: 'Kira', sheet: { abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } });
        const made = createCombat({
            id: 'c', combatants: [
                { name: 'Wild dog', side: 'enemy', tier: 'grunt', speech: 'sounds' },
                { name: 'Bandit', side: 'enemy', tier: 'grunt' },
            ],
        }, pc, 3).state;
        expect(Object.values(made.combatants).find(c => c.name === 'Wild dog')?.speech).toBe('sounds');
        expect('speech' in (Object.values(made.combatants).find(c => c.name === 'Bandit') as Combatant)).toBe(false);
    });
});

function parleyState(enemies: Combatant[], extra: Partial<CombatState> = {}): CombatState {
    const s = arena([caster([], { x: 2, y: 2 }, { initiative: 20 }), ...enemies], extra);
    return { ...s, morale: buildMoraleBook(s) };
}

const act = (s: CombatState, intent: 'ceasefire' | 'surrender_demand' = 'ceasefire') =>
    applyAction(s, { type: 'parley', actorId: 'pc', intent, rating: 'easy' });

function winning(make: (seed: number) => CombatState, pass: (s: CombatState) => boolean): CombatState {
    for (let seed = 1; seed < 3000; seed++) {
        const s = make(seed);
        if (pass(act(s, 'surrender_demand').state)) return s;
    }
    throw new Error('no seed');
}

describe('parley and speech', () => {
    const dogs = () => [foe('d1', { x: 6, y: 2 }, { name: 'Wild dog 1' }), foe('d2', { x: 6, y: 3 }, { name: 'Wild dog 2' })];

    it('is refused when only non-speakers stand, with a reason of its own', () => {
        const s = parleyState(dogs());
        const check = checkParley(s, 'pc', currentTurn(s));
        expect(check).toEqual({ ok: false, reason: 'no_speaker' });
        const r = act(s);
        expect(r.events[0].type).toBe('rejected');
        expect(r.events[0].text).toContain('no speaker');
        const oozes = parleyState([foe('o', { x: 6, y: 2 }, { name: 'Gray ooze' })]);
        expect(checkParley(oozes, 'pc', currentTurn(oozes)).reason).toBe('no_speaker');
    });

    it('is allowed with a mixed group and addresses the speakers', () => {
        const s = parleyState([...dogs(), foe('b', { x: 6, y: 4 }, { name: 'Bandit' })]);
        expect(checkParley(s, 'pc', currentTurn(s)).ok).toBe(true);
        expect(resolveSpeaker(s)?.id).toBe('b');
        expect(resolveSpeaker(s, 'Wild dog 1')?.id).toBe('b');
        expect(resolveSpeaker(s, 'd2')?.id).toBe('b');
        const r = act(s);
        expect(r.events.find(e => e.type === 'parley')?.targetId).toBe('b');
    });

    it('is allowed when every enemy speaks, and for a stored speaks value on an animal name', () => {
        const people = parleyState([foe('b', { x: 6, y: 2 }, { name: 'Bandit' })]);
        expect(checkParley(people, 'pc', currentTurn(people)).ok).toBe(true);
        const talkingWolf = parleyState([foe('w', { x: 6, y: 2 }, { name: 'Wolf', speech: 'speaks' })]);
        expect(checkParley(talkingWolf, 'pc', currentTurn(talkingWolf)).ok).toBe(true);
    });

    it('lets a fallen speaker leave only the animals, and then refuses', () => {
        const s = parleyState([...dogs(), foe('b', { x: 6, y: 4 }, { name: 'Bandit', status: 'down', hp: 0 })]);
        expect(checkParley(s, 'pc', currentTurn(s)).reason).toBe('no_speaker');
    });

    it('makes only the speakers yield on a successful surrender demand', () => {
        const make = (seed: number) => ({ ...parleyState([...dogs(), foe('b', { x: 6, y: 4 }, { name: 'Bandit' })]), rngSeed: seed, rngCursor: 0 });
        const s = winning(make, after => after.outcome === 'victory');
        const after = act(s, 'surrender_demand');
        const events: CombatEvent[] = after.events;
        expect(after.state.combatants.b.status).toBe('surrendered');
        expect(after.state.combatants.d1.status).toBe('up');
        expect(after.state.combatants.d2.status).toBe('up');
        expect(events.filter(e => e.type === 'surrendered').map(e => e.targetId)).toEqual(['b']);
    });
});
