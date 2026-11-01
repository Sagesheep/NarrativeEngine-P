import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../../types';
import { retireLegacyNpcFields, visualProfileToProse } from '../retireLegacyFields';

const row = (over: Record<string, unknown> = {}): NPCEntry => ({
    id: 'n', name: 'Sanna', aliases: '', appearance: '', faction: '', storyRelevance: '',
    status: 'Alive', voice: '', personality: '', exampleOutput: '',
    ...over,
} as unknown as NPCEntry);

const keys = (n: NPCEntry) => Object.keys(n);

describe('retireLegacyNpcFields', () => {
    it('is a no-op (returns false) on a current-schema NPC', () => {
        const n = row({ pcRelation: 1, wants: { short: ['x'], medium: [], long: 'y' } });
        const before = JSON.stringify(n);
        expect(retireLegacyNpcFields(n)).toBe(false);
        expect(JSON.stringify(n)).toBe(before);
    });

    it('maps affinity onto pcRelation and deletes it', () => {
        const n = row({ affinity: 80 });
        expect(retireLegacyNpcFields(n)).toBe(true);
        expect(n.pcRelation).toBe(2);
        expect(keys(n)).not.toContain('affinity');
    });

    it('never clobbers an existing pcRelation', () => {
        const n = row({ affinity: 5, pcRelation: 1 });
        retireLegacyNpcFields(n);
        expect(n.pcRelation).toBe(1);
    });

    it('gives a PC no pcRelation (it is the NPC->PC slot)', () => {
        const n = row({ affinity: 90, isPC: true });
        retireLegacyNpcFields(n);
        expect(n.pcRelation).toBeUndefined();
        expect(keys(n)).not.toContain('affinity');
    });

    it('fills an empty personality from disposition, otherwise drops disposition', () => {
        const empty = row({ disposition: 'wary of strangers' });
        retireLegacyNpcFields(empty);
        expect(empty.personality).toBe('wary of strangers');

        const authored = row({ disposition: 'wary', personality: 'cold, precise' });
        retireLegacyNpcFields(authored);
        expect(authored.personality).toBe('cold, precise');
        expect(keys(authored)).not.toContain('disposition');
    });

    it('ignores generic placeholder values', () => {
        const n = row({ disposition: 'Unknown', goals: '?' });
        retireLegacyNpcFields(n);
        expect(n.personality).toBe('');
        expect(n.wants).toBeUndefined();
    });

    it('folds drives and goals into empty wants tiers; coreWant wins over goals for long', () => {
        const n = row({
            goals: 'keep the agency solvent',
            drives: { coreWant: 'be seen as capable', sessionWant: 'repay the debt', sceneWant: 'read the letter' },
        });
        retireLegacyNpcFields(n);
        expect(n.wants).toEqual({ short: ['read the letter'], medium: ['repay the debt'], long: 'be seen as capable' });
        expect(keys(n)).not.toContain('drives');
        expect(keys(n)).not.toContain('goals');
    });

    it('never overwrites authored wants', () => {
        const n = row({
            goals: 'old goal',
            drives: { coreWant: 'old core', sessionWant: 'old session', sceneWant: 'old scene' },
            wants: { short: ['eat'], medium: ['win'], long: 'rule' },
        });
        retireLegacyNpcFields(n);
        expect(n.wants).toEqual({ short: ['eat'], medium: ['win'], long: 'rule' });
    });

    it('flattens array-shaped goals from older generator output', () => {
        const n = row({ goals: ['find the map', 'escape'] });
        retireLegacyNpcFields(n);
        expect(n.wants?.long).toBe('find the map; escape');
    });

    it('strips affinity from previousSnapshot', () => {
        const n = row({ pcRelation: 0, previousSnapshot: { personality: 'a', voice: 'b', affinity: 50 } });
        expect(retireLegacyNpcFields(n)).toBe(true);
        expect(n.previousSnapshot).toEqual({ personality: 'a', voice: 'b' });
    });

    it('renders the structured look as prose, identifying details first', () => {
        expect(visualProfileToProse({
            race: 'Elf', gender: 'female', ageRange: 'mid 20s', build: 'lean',
            hairStyle: 'silver braid', eyeColor: 'amber', distinctMarks: 'None', clothing: 'Unknown',
        })).toBe('Elf, female, mid 20s. Build: lean. Hair: silver braid. Eyes: amber.');
        expect(visualProfileToProse({ race: '', artStyle: 'Chibi' })).toBe('');
    });

    it('fills an empty appearance from visualProfile and moves artStyle', () => {
        const n = row({ visualProfile: { race: 'Orc', hairStyle: 'shaved', artStyle: 'Graphic Novel' } });
        retireLegacyNpcFields(n);
        expect(n.appearance).toBe('Orc. Hair: shaved.');
        expect(n.artStyle).toBe('Graphic Novel');
        expect(keys(n)).not.toContain('visualProfile');
    });

    it('keeps authored appearance first and appends the structured look after it', () => {
        const n = row({ appearance: 'A scarred veteran.', visualProfile: { eyeColor: 'grey' } });
        retireLegacyNpcFields(n);
        expect(n.appearance).toBe('A scarred veteran.\nEyes: grey.');
    });

    it('never overwrites a chosen artStyle', () => {
        const n = row({ artStyle: 'Chibi', visualProfile: { artStyle: 'Graphic Novel' } });
        retireLegacyNpcFields(n);
        expect(n.artStyle).toBe('Chibi');
    });

    it('is idempotent', () => {
        const n = row({ affinity: 30, disposition: 'gruff', goals: 'g' });
        retireLegacyNpcFields(n);
        const once = JSON.stringify(n);
        expect(retireLegacyNpcFields(n)).toBe(false);
        expect(JSON.stringify(n)).toBe(once);
    });
});
