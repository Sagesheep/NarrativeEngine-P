import { describe, it, expect } from 'vitest';
import { buildPayload } from '../../payloadBuilder';
import { GM_REMINDER } from '../builtins';
import type { AppSettings, GameContext } from '../../../../types';

/**
 * WO-P2-02 integration: proves that `settings.moduleEnabled` — the map the extensions screen
 * writes — actually reaches the assembled prompt, end to end through `buildPayload`.
 *
 * Enablement deliberately rides on `settings` rather than a dedicated `buildPayload` option,
 * because `settings` is already threaded to every call site. Wiring the extensions screen to
 * the prompt therefore required no changes to `turnStages.ts` or `useSceneContinue.ts`.
 */

const settings = (moduleEnabled?: Record<string, boolean>): AppSettings => ({
    contextLimit: 8192,
    debugMode: false,
    moduleEnabled,
} as unknown as AppSettings);

const context = (): GameContext => ({
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '', starter: '', continuePrompt: '',
    inventory: '', inventoryLastScene: 'Never', characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false, starterActive: false, continuePromptActive: false,
    inventoryActive: false, characterProfileActive: false, smartBookkeepingActive: false,
    inventoryItems: [], characterProfileData: {},
} as unknown as GameContext);

/** The final user message is always the last message buildPayload emits. */
const finalUser = (moduleEnabled?: Record<string, boolean>): string => {
    const { messages } = buildPayload({
        settings: settings(moduleEnabled),
        context: context(),
        history: [],
        userMessage: 'I push the door open.',
        watchdogNudge: '[STAGE NOTE] Kira has been agreeing too readily.',
    });
    return String(messages[messages.length - 1].content);
};

describe('WO-P2-02 — settings.moduleEnabled reaches the assembled prompt', () => {
    it('an absent map is exactly today\'s behaviour (everything on)', () => {
        const content = finalUser(undefined);

        expect(content).toContain(GM_REMINDER);
        expect(content).toContain('[STAGE NOTE]');
        expect(content).toContain('I push the door open.');
    });

    it('an empty map is also everything-on (absent key means enabled)', () => {
        expect(finalUser({})).toContain(GM_REMINDER);
    });

    it('disabling a module removes exactly that block and nothing else', () => {
        const content = finalUser({ 'gm.reminder': false });

        expect(content).not.toContain(GM_REMINDER);
        expect(content).toContain('[STAGE NOTE]');
        expect(content).toContain('I push the door open.');
    });

    it('explicit true is enabled', () => {
        expect(finalUser({ 'gm.reminder': true })).toContain(GM_REMINDER);
    });

    it('disabling several modules removes each of them', () => {
        const content = finalUser({ 'gm.reminder': false, 'watchdog.nudge': false });

        expect(content).not.toContain(GM_REMINDER);
        expect(content).not.toContain('[STAGE NOTE]');
        expect(content).toContain('I push the door open.');
    });

    it('a hostile map cannot delete the player\'s own message', () => {
        // Structural modules ignore enablement — see ContributionModule.toggleable.
        const content = finalUser({
            'user.message': false, 'gm.reminder': false, 'watchdog.nudge': false,
            'volatile.block': false, 'askgm.brief': false, 'absolute.command': false,
        });

        expect(content).toContain('I push the door open.');
    });

    it('an unknown module id in the map is harmless', () => {
        expect(finalUser({ 'mod.does.not.exist': false })).toContain(GM_REMINDER);
    });
});
