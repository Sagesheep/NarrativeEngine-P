import { describe, it, expect } from 'vitest';
import { queryTraits, formatTraitsForContext, type SelectedTraits } from '../retrieval/semanticMemory';
import type { CharacterProfileState, CharacterTrait } from '../../types';

function makeTrait(partial: Partial<CharacterTrait>): CharacterTrait {
    return {
        id: 't_' + Math.random().toString(36).slice(2, 8),
        subject: 'PC',
        category: 'party_facts',
        text: 'a fact',
        importance: 5,
        eventTags: [],
        sceneEstablished: '',
        superseded: false,
        source: 'llm',
        ...partial,
    };
}

describe('WO-G: queryTraits', () => {
    it('returns empty when no traits', () => {
        expect(queryTraits([], 'hello', [], [])).toEqual({ core: [], extended: [] });
    });

    it('core floor always injects top N by importance regardless of entity match or tags', () => {
        const traits: CharacterTrait[] = [
            makeTrait({ id: 'a', text: 'low', importance: 2 }),
            makeTrait({ id: 'b', text: 'high', importance: 9 }),
            makeTrait({ id: 'c', text: 'mid', importance: 5 }),
        ];
        const { core } = queryTraits(traits, 'unrelated', [], [], undefined, 400, 5);
        expect(core).toHaveLength(3);
        expect(core[0].id).toBe('b'); // highest importance first
    });

    it('extended tier filters by planner eventTypes when trait has tags', () => {
        const traits: CharacterTrait[] = [
            // Core floor (5 traits, importance 10..6) — all bypass tag filter.
            makeTrait({ id: 'c1', importance: 10, eventTags: ['combat'] }),
            makeTrait({ id: 'c2', importance: 9, eventTags: ['travel'] }),
            makeTrait({ id: 'c3', importance: 8 }),
            makeTrait({ id: 'c4', importance: 7 }),
            makeTrait({ id: 'c5', importance: 6 }),
            // Extended candidates (importance 5 so they're below the core floor):
            makeTrait({ id: 'e1', importance: 5, eventTags: ['combat'], text: 'wields a Sword' }),
            makeTrait({ id: 'e2', importance: 5, eventTags: ['travel'], text: 'lives far away' }),
        ];
        // User message mentions 'Sword' (capitalized) so e1 gets an entity-match score.
        // Planner says scene is 'combat'. e1 (combat tag ∩ planner) keeps its score;
        // e2 (travel tag, no intersect) is demoted to 0 and dropped.
        const { core, extended } = queryTraits(
            traits, 'I swing my Sword at the dragon', [{ content: 'Sword' }], [],
            ['combat'], 400, 5,
        );
        expect(core).toHaveLength(5);
        const allInjected = [...core, ...extended];
        expect(allInjected.map(t => t.id)).toContain('e1');
        expect(allInjected.map(t => t.id)).not.toContain('e2');
    });

    it('untagged traits bypass the tag filter (fault tolerance)', () => {
        const traits: CharacterTrait[] = [
            makeTrait({ id: 'c1', importance: 10 }),
            makeTrait({ id: 'c2', importance: 9 }),
            makeTrait({ id: 'c3', importance: 8 }),
            makeTrait({ id: 'c4', importance: 7 }),
            makeTrait({ id: 'c5', importance: 6 }),
            // Untagged, importance 5, but text mentions a capitalized entity for score.
            makeTrait({ id: 'e1', importance: 5, eventTags: [], text: 'knows the Dragonlord' }),
        ];
        const { extended } = queryTraits(traits, 'The Dragonlord attacks', [{ content: 'Dragonlord' }], [], ['combat'], 400, 5);
        expect(extended.map(t => t.id)).toContain('e1');
    });

    it('empty plannerEventTypes degrades to best-by-score (no tag filtering)', () => {
        const traits: CharacterTrait[] = [
            makeTrait({ id: 'c1', importance: 10 }),
            makeTrait({ id: 'c2', importance: 9 }),
            makeTrait({ id: 'c3', importance: 8 }),
            makeTrait({ id: 'c4', importance: 7 }),
            makeTrait({ id: 'c5', importance: 6 }),
            // Capitalized 'Sword' → entity match on the trait text 'wields a Sword'.
            makeTrait({ id: 'e1', importance: 5, eventTags: ['combat'], text: 'wields a Sword' }),
        ];
        const { extended } = queryTraits(traits, 'I swing at the dragon', [{ content: 'Sword' }], [], undefined, 400, 5);
        // No planner tags → e1 is scored by entity match (contains 'sword')
        expect(extended.map(t => t.id)).toContain('e1');
    });

    it('superseded traits are never selected', () => {
        const traits: CharacterTrait[] = [
            makeTrait({ id: 's1', importance: 10, superseded: true, text: 'old' }),
            makeTrait({ id: 'a1', importance: 5, text: 'current' }),
        ];
        const { core, extended } = queryTraits(traits, 'test', [], [], undefined, 400, 5);
        const all = [...core, ...extended];
        expect(all.map(t => t.id)).not.toContain('s1');
    });

    it('extended tier respects token budget', () => {
        const traits: CharacterTrait[] = [];
        for (let i = 0; i < 5; i++) traits.push(makeTrait({ id: `c${i}`, importance: 10 - i }));
        // Many extended candidates with high importance but tiny budget.
        for (let i = 0; i < 20; i++) traits.push(makeTrait({ id: `e${i}`, importance: 8, text: 'x'.repeat(50) }));
        const { extended } = queryTraits(traits, 'x'.repeat(50), [], [], undefined, 50, 5);
        // Budget 50 tokens — at most 1-2 extended traits fit.
        expect(extended.length).toBeLessThanOrEqual(2);
    });
});

describe('WO-G: formatTraitsForContext', () => {
    it('emits identity line when identity fields present', () => {
        const profile: CharacterProfileState = {
            identity: { name: 'Gareth', race: 'Human', class: 'Fighter', level: 5 },
            activeTraits: [],
        };
        const text = formatTraitsForContext(profile, { core: [], extended: [] });
        expect(text).toContain('Gareth');
        expect(text).toContain('Human');
        expect(text).toContain('Fighter');
        expect(text).toContain('Level 5');
        expect(text).toContain('[CHARACTER PROFILE]');
        expect(text).toContain('[END CHARACTER PROFILE]');
    });

    it('lists core traits under Core: and extended under Scene-relevant:', () => {
        const profile: CharacterProfileState = { identity: {}, activeTraits: [] };
        const selected: SelectedTraits = {
            core: [makeTrait({ id: 'a', text: 'core fact', importance: 8, category: 'party_facts' })],
            extended: [makeTrait({ id: 'b', text: 'scene fact', importance: 5, eventTags: ['combat'], category: 'party_facts' })],
        };
        const text = formatTraitsForContext(profile, selected);
        expect(text).toContain('Core:');
        expect(text).toContain('core fact');
        expect(text).toContain('Scene-relevant:');
        expect(text).toContain('scene fact');
    });
});