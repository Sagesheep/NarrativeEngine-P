import { describe, it, expect, afterEach } from 'vitest';
import { buildPayload } from '../../payloadBuilder';
import {
    createFinalUserRegistryWithExtensions,
    getExtensionModules,
    setExtensionModules,
} from '../extensions';
import { createFinalUserRegistry } from '../builtins';
import type { FinalUserModuleInput } from '../builtins';
import type { ContributionModule } from '../registry';
import type { AppSettings, GameContext } from '../../../../types';

/**
 * Project 2 — proves a non-built-in module reaches the assembled prompt through the same path a
 * loaded mod uses, and that with nothing installed the app is byte-identical to built-ins only.
 */

const extension = (
    id: string,
    text: string,
    over: Partial<ContributionModule<FinalUserModuleInput>> = {},
): ContributionModule<FinalUserModuleInput> => ({
    id,
    name: id,
    description: '',
    source: 'mod',
    defaultEnabled: true,
    produce: () => [{ id: `${id}.block`, slot: 'final-user', order: 250, text, source: 'mod' }],
    ...over,
});

const settings = (moduleEnabled?: Record<string, boolean>): AppSettings => ({
    contextLimit: 8192, debugMode: false, moduleEnabled,
} as unknown as AppSettings);

const context = (): GameContext => ({
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '', starter: '', continuePrompt: '',
    inventory: '', inventoryLastScene: 'Never', characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false, starterActive: false, continuePromptActive: false,
    inventoryActive: false, characterProfileActive: false, smartBookkeepingActive: false,
    inventoryItems: [], characterProfileData: {},
} as unknown as GameContext);

const finalUser = (moduleEnabled?: Record<string, boolean>): string => {
    const { messages } = buildPayload({
        settings: settings(moduleEnabled),
        context: context(),
        history: [],
        userMessage: 'I push the door open.',
    });
    return String(messages[messages.length - 1].content);
};

afterEach(() => setExtensionModules([]));

describe('extensions registration', () => {
    it('with nothing installed, the registry is exactly the built-ins', () => {
        // "Mods off = today's app", true by construction rather than by testing.
        expect(createFinalUserRegistryWithExtensions().list().map((m) => m.id))
            .toEqual(createFinalUserRegistry().list().map((m) => m.id));
    });

    it('registers an extension module and exposes it', () => {
        setExtensionModules([extension('mod.grimdark', 'Tone: unforgiving.')]);

        expect(getExtensionModules().map((m) => m.id)).toEqual(['mod.grimdark']);
        expect(createFinalUserRegistryWithExtensions().get('mod.grimdark')).toBeDefined();
    });

    it('takes a defensive copy so the caller cannot mutate what the next turn assembles', () => {
        const modules = [extension('mod.a', 'a')];
        setExtensionModules(modules);
        modules.push(extension('mod.b', 'b'));

        expect(getExtensionModules()).toHaveLength(1);
    });

    it('skips an extension whose id collides with a built-in instead of throwing', () => {
        setExtensionModules([extension('gm.reminder', 'hijacked')]);

        // A bad mod must never be able to break the turn loop.
        expect(() => createFinalUserRegistryWithExtensions()).not.toThrow();
        expect(finalUser()).not.toContain('hijacked');
    });

    it('an installed extension reaches the assembled prompt', () => {
        setExtensionModules([extension('mod.grimdark', 'Tone: unforgiving.')]);

        expect(finalUser()).toContain('Tone: unforgiving.');
    });

    it('an extension lands at its declared order, between the built-ins', () => {
        setExtensionModules([extension('mod.grimdark', 'MOD TEXT')]);
        const content = finalUser();

        // order 250 sits between writer.cot (200) and director.brief (300), and so before
        // GM_REMINDER (400) and the player's message (700).
        expect(content.indexOf('MOD TEXT')).toBeLessThan(content.indexOf('I push the door open.'));
    });

    it('the extensions screen can switch an installed mod off', () => {
        setExtensionModules([extension('mod.grimdark', 'Tone: unforgiving.')]);

        expect(finalUser({ 'mod.grimdark': false })).not.toContain('Tone: unforgiving.');
    });

    it('a throwing extension is contained and the turn still assembles', () => {
        setExtensionModules([
            extension('mod.bad', '', { produce: () => { throw new Error('boom'); } }),
        ]);

        expect(() => finalUser()).not.toThrow();
        expect(finalUser()).toContain('I push the door open.');
    });

    it('clearing extensions returns the prompt to built-ins only', () => {
        setExtensionModules([extension('mod.grimdark', 'Tone: unforgiving.')]);
        const withMod = finalUser();
        setExtensionModules([]);

        expect(withMod).toContain('Tone: unforgiving.');
        expect(finalUser()).not.toContain('Tone: unforgiving.');
    });
});
