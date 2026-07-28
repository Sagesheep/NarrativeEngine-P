import { describe, expect, it } from 'vitest';
import type { AbilityEntry, ChatMessage } from '../../../types';
import { createEmptyAbilityEntry } from '../abilitySchema';
import { buildRelevantAbilityBlock } from '../abilityPrompt';

const ability = (name: string, patch: Partial<AbilityEntry> = {}): AbilityEntry => ({
    ...createEmptyAbilityEntry({ now: 1, createId: () => name }),
    name,
    effect: 'Relocate through an existing flame.',
    costs: [{ resource: 'Aura', amount: '8', timing: 'On activation', condition: '' }],
    limitations: ['Cannot carry another person'],
    ...patch,
});

const history = (content: string): ChatMessage[] => [{
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: 1,
}];

describe('ability prompt selection', () => {
    it('matches exact names and comma-delimited aliases from recent play', () => {
        const output = buildRelevantAbilityBlock([
            ability('Ash Step', { aliases: 'Cinder Walk, Ember Passage' }),
            ability('Ward'),
        ], history('The room is quiet.'), 'I use Cinder Walk.', 1000);

        expect(output).toContain('ABILITY: Ash Step');
        expect(output).toContain('COSTS: Aura | 8 | On activation');
        expect(output).not.toContain('ABILITY: Ward');
    });

    it('does not substring-match names or include disabled definitions', () => {
        expect(buildRelevantAbilityBlock([ability('Ward')], [], 'I walk toward the garden.', 1000)).toBe('');
        expect(buildRelevantAbilityBlock([ability('Ash Step', { promptEnabled: false })], [], 'Use Ash Step.', 1000)).toBe('');
    });

    it('never exceeds its hard token budget', () => {
        const output = buildRelevantAbilityBlock([
            ability('Ash Step', { gmNotes: 'secret '.repeat(400) }),
        ], [], 'Use Ash Step.', 45);
        expect(output).toContain('ABILITY: Ash Step');
        expect(output).not.toContain('GM NOTES');
    });
});
