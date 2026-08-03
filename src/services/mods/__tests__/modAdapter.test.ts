import { describe, it, expect } from 'vitest';
import { evaluateWhen, modSpecId, modToContributionModule, renderTemplate } from '../modAdapter';
import type { ModFacts, ValidatedMod } from '../modTypes';
import { createContributionRegistry, DEFAULT_MOD_CONTRIBUTION_BUDGET } from '../../payload/contributions/registry';
import { assembleContributions } from '../../payload/contributions/assemble';
import type { FinalUserModuleInput } from '../../payload/contributions/builtins';

/**
 * Project 2 / WO-P2-04 — mod file → contribution module.
 *
 * Two properties carry the security of the whole mod layer and are pinned hardest here:
 *   1. every spec id is `mod.<modId>.<contributionId>`, so a mod can never impersonate a
 *      built-in id;
 *   2. `produce` is total — an unmatched condition yields `text: ''`, never a missing spec and
 *      never a throw, whatever the input looks like.
 */

const mod = (overrides: Partial<ValidatedMod> = {}): ValidatedMod => ({
    id: 'grimdark-tone',
    name: 'Grimdark Tone',
    version: '1.0.0',
    description: 'Harsher consequences.',
    file: 'grimdark.mod.json',
    contributions: [{ id: 'tone', order: 250, budget: 120, text: 'Tone: unforgiving.' }],
    ...overrides,
});

/** Only `facts` is read by the adapter; the rest of the input is irrelevant to it. */
const input = (facts?: ModFacts): FinalUserModuleInput =>
    ({ facts } as unknown as FinalUserModuleInput);

describe('modToContributionModule', () => {
    it('describes itself as a toggleable, enabled-by-default mod module', () => {
        const module = modToContributionModule(mod());

        expect(module.id).toBe('mod.grimdark-tone');
        expect(module.name).toBe('Grimdark Tone');
        expect(module.description).toBe('Harsher consequences.');
        expect(module.source).toBe('mod');
        expect(module.defaultEnabled).toBe(true);
        expect(module.toggleable).toBe(true);
    });

    it('namespaces every spec id under mod.<modId>.', () => {
        const module = modToContributionModule(mod({
            contributions: [
                { id: 'tone', order: 250, text: 'a' },
                // A contribution that tries to name itself after a built-in still lands namespaced.
                { id: 'reminder', order: 260, text: 'b' },
            ],
        }));

        expect(module.produce(input()).map((s) => s.id))
            .toEqual(['mod.grimdark-tone.tone', 'mod.grimdark-tone.reminder']);
        expect(modSpecId('a', 'b')).toBe('mod.a.b');
    });

    it('produces a fully-formed spec', () => {
        const spec = modToContributionModule(mod({
            contributions: [{ id: 'tone', order: 250, budget: 120, text: 'Tone: unforgiving.', suppresses: ['gm.reminder'] }],
        })).produce(input())[0];

        expect(spec).toMatchObject({
            id: 'mod.grimdark-tone.tone',
            slot: 'final-user',
            order: 250,
            budget: 120,
            text: 'Tone: unforgiving.',
            source: 'mod',
            suppresses: ['gm.reminder'],
        });
        expect(spec.trace?.source).toBe('Grimdark Tone');
    });

    it('leaves budget undefined when the file declared none, so the registry can default it', () => {
        const module = modToContributionModule(mod({
            contributions: [{ id: 'tone', order: 250, text: 'x' }],
        }));

        expect(module.produce(input())[0].budget).toBeUndefined();

        const registry = createContributionRegistry<FinalUserModuleInput>();
        registry.register(module);
        expect(registry.collect(input())[0].budget).toBe(DEFAULT_MOD_CONTRIBUTION_BUDGET);
    });

    it('omits suppresses entirely when the mod declares none', () => {
        expect(modToContributionModule(mod()).produce(input())[0].suppresses).toBeUndefined();
    });

    it('returns an inactive spec (empty text) rather than omitting it when `when` misses', () => {
        const module = modToContributionModule(mod({
            contributions: [{ id: 'tone', order: 250, text: 'Tone: unforgiving.', when: { inCombat: true } }],
        }));

        const specs = module.produce(input({ inCombat: false }));

        expect(specs).toHaveLength(1);
        expect(specs[0].id).toBe('mod.grimdark-tone.tone');
        expect(specs[0].text).toBe('');
        // The arbiter drops empty contributions, so an inactive mod suppresses nothing.
        expect(assembleContributions(specs).included).toEqual([]);
    });

    it('reaches the assembled prompt when its condition matches', () => {
        const registry = createContributionRegistry<FinalUserModuleInput>();
        registry.register(modToContributionModule(mod({
            contributions: [{
                id: 'tone',
                order: 250,
                text: '{{npcs}} will not fight fairly in {{location}}.',
                when: { sceneTag: ['tense'] },
            }],
        })));

        const specs = registry.collect(input({ sceneTags: ['tense'], onStageNpcNames: ['Kira', 'Bram'], location: 'Tavern' }));
        const assembled = assembleContributions(specs);

        expect(assembled.text).toBe('Kira, Bram will not fight fairly in Tavern.');
        expect(assembled.included).toEqual(['mod.grimdark-tone.tone']);
    });

    it('is total: no facts, null facts, or junk contributions never throw', () => {
        const module = modToContributionModule(mod({
            contributions: [{ id: 'tone', order: 250, text: 'x', when: { npcPresent: 'Kira' } }],
        }));

        expect(() => module.produce({} as unknown as FinalUserModuleInput)).not.toThrow();
        expect(() => module.produce({ facts: null } as unknown as FinalUserModuleInput)).not.toThrow();
        expect(() => module.produce({ facts: 'nope' } as unknown as FinalUserModuleInput)).not.toThrow();
        expect(module.produce(input({ onStageNpcNames: [null as unknown as string] }))[0].text).toBe('');

        const junk = modToContributionModule({ id: 'j', name: 'J', version: '1', description: '', file: 'j.mod.json' } as ValidatedMod);
        expect(junk.produce(input())).toEqual([]);
    });

    it('injects only exact ability name or alias matches from its own prompt index', () => {
        const module = modToContributionModule(mod({
            id: 'ability-compendium',
            contributions: [{
                id: 'mentioned-abilities', order: 150, text: 'Relevant abilities:',
                lookup: { table: 'prompt-index', termFields: ['terms'], textField: 'promptText', recentMessages: 2 },
            }],
        }));
        const promptText = 'Fireball: a controlled burst of flame.';
        const spec = module.produce({
            extensionTables: {
                'mod.ability-compendium.prompt-index': [
                    { terms: ['Fireball', 'Orb of Flame'], promptText },
                    { terms: ['Fly'], promptText: 'Fly: take to the air.' },
                ],
                'mod.some-other-mod.prompt-index': [
                    { terms: ['Fireball'], promptText: 'This must never leak.' },
                ],
            },
            recentPlay: ['The wizard prepares.', 'I cast Orb of Flame at the door.'],
        } as FinalUserModuleInput)[0];

        expect(spec.text).toBe(`Relevant abilities:\n\n${promptText}`);
        expect(spec.text).not.toContain('take to the air');
        expect(spec.text).not.toContain('never leak');
    });

    it('does not substring-match a short ability name inside an unrelated word', () => {
        const module = modToContributionModule(mod({
            contributions: [{
                id: 'mentioned', order: 150, text: 'Relevant:',
                lookup: { table: 'index', termFields: ['terms'], textField: 'promptText' },
            }],
        }));
        const spec = module.produce({
            extensionTables: { 'mod.grimdark-tone.index': [{ terms: ['Fly'], promptText: 'Matched.' }] },
            recentPlay: ['The flag flies above us.'],
        } as FinalUserModuleInput)[0];
        expect(spec.text).toBe('');
    });
});

describe('evaluateWhen', () => {
    const facts: ModFacts = {
        onStageNpcNames: ['Kira', 'Bram'],
        location: 'Tavern',
        inCombat: true,
        sceneTags: ['tense', 'night'],
    };

    it('matches when `when` is absent or empty', () => {
        expect(evaluateWhen(undefined, facts)).toBe(true);
        expect(evaluateWhen({}, facts)).toBe(true);
        expect(evaluateWhen(undefined, undefined)).toBe(true);
    });

    it('ANDs across keys — every present key must match', () => {
        expect(evaluateWhen({ location: 'Tavern', inCombat: true }, facts)).toBe(true);
        expect(evaluateWhen({ location: 'Tavern', inCombat: false }, facts)).toBe(false);
        expect(evaluateWhen({ location: 'Crypt', inCombat: true }, facts)).toBe(false);
    });

    it('ORs within a key — any array member may match', () => {
        expect(evaluateWhen({ location: ['Crypt', 'Tavern'] }, facts)).toBe(true);
        expect(evaluateWhen({ location: ['Crypt', 'Docks'] }, facts)).toBe(false);
        expect(evaluateWhen({ npcPresent: ['Nobody', 'Bram'] }, facts)).toBe(true);
        expect(evaluateWhen({ sceneTag: ['calm', 'night'] }, facts)).toBe(true);
    });

    it('matches strings case-insensitively and ignores surrounding whitespace', () => {
        expect(evaluateWhen({ npcPresent: 'kira' }, facts)).toBe(true);
        expect(evaluateWhen({ npcPresent: ' KIRA ' }, facts)).toBe(true);
        expect(evaluateWhen({ location: 'tavern' }, facts)).toBe(true);
        expect(evaluateWhen({ sceneTag: 'TENSE' }, facts)).toBe(true);
        expect(evaluateWhen({ npcPresent: 'Kir' }, facts)).toBe(false); // not a substring match
    });

    it('does NOT match when the fact it references is undefined', () => {
        expect(evaluateWhen({ npcPresent: 'Kira' }, {})).toBe(false);
        expect(evaluateWhen({ location: 'Tavern' }, {})).toBe(false);
        expect(evaluateWhen({ sceneTag: 'tense' }, {})).toBe(false);
        expect(evaluateWhen({ inCombat: true }, {})).toBe(false);
        // Including the negative form: `inCombat: false` is a claim about combat, and an
        // unknown combat state cannot satisfy it.
        expect(evaluateWhen({ inCombat: false }, {})).toBe(false);
        expect(evaluateWhen({ location: 'Tavern' }, undefined)).toBe(false);
        expect(evaluateWhen({ location: 'Tavern' }, { location: '  ' })).toBe(false);
    });

    it('matches inCombat only on exact boolean equality', () => {
        expect(evaluateWhen({ inCombat: true }, { inCombat: true })).toBe(true);
        expect(evaluateWhen({ inCombat: false }, { inCombat: false })).toBe(true);
        expect(evaluateWhen({ inCombat: false }, { inCombat: true })).toBe(false);
    });

    it('never matches an empty candidate list', () => {
        expect(evaluateWhen({ npcPresent: [] }, facts)).toBe(false);
        expect(evaluateWhen({ sceneTag: [] }, facts)).toBe(false);
    });
});

describe('renderTemplate', () => {
    const facts: ModFacts = { onStageNpcNames: ['Kira', 'Bram'], location: 'The Rusted Tankard' };

    it('substitutes the two known slots', () => {
        expect(renderTemplate('You are in {{location}}.', facts)).toBe('You are in The Rusted Tankard.');
        expect(renderTemplate('Present: {{npcs}}.', facts)).toBe('Present: Kira, Bram.');
        expect(renderTemplate('{{npcs}} @ {{location}}', facts)).toBe('Kira, Bram @ The Rusted Tankard');
    });

    it('substitutes every occurrence, and tolerates inner whitespace', () => {
        expect(renderTemplate('{{location}}/{{location}}', facts)).toBe('The Rusted Tankard/The Rusted Tankard');
        expect(renderTemplate('{{ location }}', facts)).toBe('The Rusted Tankard');
    });

    it('renders a missing fact as an empty string', () => {
        expect(renderTemplate('[{{location}}][{{npcs}}]', {})).toBe('[][]');
        expect(renderTemplate('[{{location}}][{{npcs}}]', undefined)).toBe('[][]');
    });

    it('leaves unknown slots verbatim so the author can see the typo', () => {
        expect(renderTemplate('{{npc.name}} and {{pc.hp}}', facts)).toBe('{{npc.name}} and {{pc.hp}}');
        expect(renderTemplate('{{LOCATION}}', facts)).toBe('{{LOCATION}}');
        expect(renderTemplate('{{}}', facts)).toBe('{{}}');
    });

    it('returns text without slots untouched', () => {
        expect(renderTemplate('Tone: unforgiving.', facts)).toBe('Tone: unforgiving.');
        expect(renderTemplate('', facts)).toBe('');
    });

    it('does not interpret anything beyond substitution', () => {
        expect(renderTemplate('{{location}} {{1+1}}', facts)).toBe('The Rusted Tankard {{1+1}}');
    });
});
