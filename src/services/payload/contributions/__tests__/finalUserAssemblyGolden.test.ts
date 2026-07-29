import { describe, it, expect } from 'vitest';
import type { AppSettings } from '../../../../types';
import { isThinkingEnabled } from '../../stable';
import { formatAskGmBrief } from '../../../ooc/askGmHandoff';
import { buildAbsoluteCommandBlock } from '../../../turn/absoluteCommand';
import { assembleContributions } from '../assemble';
import { createFinalUserRegistry, GM_REMINDER } from '../builtins';
import type { FinalUserModuleInput } from '../builtins';

/**
 * WO-P2-02 characterization guard.
 *
 * `buildPayload` used to assemble the final user message with a hand-written array plus four
 * inline precedence conditionals. That expression is reproduced verbatim below as `legacy()` —
 * the oracle — and compared against the registry-driven assembly across EVERY combination of
 * the flags that drove it (64 cases).
 *
 * If the migration changed the prompt by so much as one character, in any reachable
 * configuration, this fails. It also pins the debug-trace sequence, which the old code emitted
 * in a different source order (watchdog → director → absolute) than the new code sorts by
 * (director → watchdog → absolute); the two agree only because the Director Brief and the
 * watchdog nudge are mutually exclusive, and that is asserted here rather than assumed.
 */

// ─── the oracle: payloadBuilder.ts @ 08a5a08..HEAD, lines 193-291, verbatim ──────────────────
function legacy(input: FinalUserModuleInput): { text: string; traceSources: string[] } {
    const absoluteCommandBlock = buildAbsoluteCommandBlock(input.absoluteCommand);
    const hasAbsolute = absoluteCommandBlock !== '';

    const gmReminderActive = hasAbsolute ? '' : GM_REMINDER;

    const writerCotNudge = !isThinkingEnabled(input.settings)
        ? ''
        : hasAbsolute
            ? 'Work through the [WRITER REASONING FRAMEWORK] only where it does not conflict with [USER ABSOLUTE COMMAND]. Where they conflict, discard the framework step and follow the command.'
            : 'Work through the [WRITER REASONING FRAMEWORK] in your reasoning before writing.';

    const watchdogNudgeActive =
        input.watchdogNudge && !input.directorBrief && !hasAbsolute ? input.watchdogNudge : '';

    const directorBriefBlock = input.directorBrief ? `[DIRECTOR BRIEF]\n${input.directorBrief}` : '';

    const askGmBrief = formatAskGmBrief(input.nextTurnOocBrief);

    const text = [
        input.volatileBlock, writerCotNudge, directorBriefBlock, gmReminderActive,
        watchdogNudgeActive, askGmBrief, input.userMessage, absoluteCommandBlock,
    ].filter(Boolean).join('\n\n');

    // Legacy trace emission order, in source order.
    const traceSources: string[] = [];
    if (watchdogNudgeActive) traceSources.push('Watchdog');
    if (directorBriefBlock) traceSources.push('Director');
    if (absoluteCommandBlock) traceSources.push('Absolute Command');

    return { text, traceSources };
}

// ─── the migration under test ────────────────────────────────────────────────────────────────
function migrated(input: FinalUserModuleInput): { text: string; traceSources: string[] } {
    const assembled = assembleContributions(createFinalUserRegistry().collect(input));
    return { text: assembled.text, traceSources: assembled.traces.map((t) => t.source) };
}

// ─── settings fixtures ───────────────────────────────────────────────────────────────────────
const thinkingOn = {
    debugMode: true,
    contextLimit: 8192,
    activePresetId: 'preset_1',
    providers: [{ id: 'prov_a', modelName: 'anything', thinkingEffort: 'medium' }],
    presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
} as unknown as AppSettings;

const thinkingOff = { debugMode: true, contextLimit: 8192 } as unknown as AppSettings;

// ─── the matrix ──────────────────────────────────────────────────────────────────────────────
const AXES = {
    settings: [['thinking-on', thinkingOn], ['thinking-off', thinkingOff]] as const,
    directorBrief: [['brief', 'Press the confrontation.'], ['no-brief', undefined]] as const,
    watchdogNudge: [['nudge', '[STAGE NOTE] Kira has been agreeing too readily.'], ['no-nudge', undefined]] as const,
    absoluteCommand: [['command', 'Keep it under 200 words.'], ['no-command', undefined]] as const,
    nextTurnOocBrief: [['ooc', 'Focus on the sister subplot.'], ['no-ooc', undefined]] as const,
    volatileBlock: [['world', '[WORLD STATE]\nThe tavern is emptying.'], ['no-world', '']] as const,
};

interface Case { label: string; input: FinalUserModuleInput }

function matrix(): Case[] {
    const cases: Case[] = [];
    for (const [sName, settings] of AXES.settings) {
        for (const [dName, directorBrief] of AXES.directorBrief) {
            for (const [wName, watchdogNudge] of AXES.watchdogNudge) {
                for (const [aName, absoluteCommand] of AXES.absoluteCommand) {
                    for (const [oName, nextTurnOocBrief] of AXES.nextTurnOocBrief) {
                        for (const [vName, volatileBlock] of AXES.volatileBlock) {
                            cases.push({
                                label: [sName, dName, wName, aName, oName, vName].join(' · '),
                                input: {
                                    settings,
                                    userMessage: 'I push the door open.',
                                    volatileBlock,
                                    directorBrief,
                                    watchdogNudge,
                                    absoluteCommand,
                                    nextTurnOocBrief,
                                },
                            });
                        }
                    }
                }
            }
        }
    }
    return cases;
}

describe('WO-P2-02 — final user message is byte-identical after the registry migration', () => {
    const cases = matrix();

    it('covers all 64 flag combinations', () => {
        expect(cases).toHaveLength(64);
    });

    it.each(cases.map((c) => [c.label, c.input] as const))(
        'assembled text matches the legacy expression — %s',
        (_label, input) => {
            expect(migrated(input).text).toBe(legacy(input).text);
        },
    );

    it.each(cases.map((c) => [c.label, c.input] as const))(
        'debug traces match the legacy sequence — %s',
        (_label, input) => {
            expect(migrated(input).traceSources).toEqual(legacy(input).traceSources);
        },
    );

    it('the Director Brief and the watchdog nudge are never both traced (why the reorder is safe)', () => {
        for (const { input } of cases) {
            const sources = migrated(input).traceSources;
            expect(sources.includes('Director') && sources.includes('Watchdog')).toBe(false);
        }
    });
});

describe('WO-P2-02 — precedence rules survive as declared suppression', () => {
    const base: FinalUserModuleInput = {
        settings: thinkingOff,
        userMessage: 'I wait.',
        volatileBlock: '',
    };

    it('an Absolute Command removes GM_REMINDER and the watchdog nudge', () => {
        const assembled = assembleContributions(createFinalUserRegistry().collect({
            ...base, watchdogNudge: '[STAGE NOTE] x', absoluteCommand: 'Be terse.',
        }));

        expect(assembled.included).not.toContain('gm.reminder');
        expect(assembled.included).not.toContain('watchdog.nudge');
        expect(assembled.suppressed).toEqual(
            expect.arrayContaining([{ id: 'watchdog.nudge', by: 'absolute.command' }]),
        );
    });

    it('a Director Brief supersedes the watchdog nudge but leaves GM_REMINDER standing', () => {
        const assembled = assembleContributions(createFinalUserRegistry().collect({
            ...base, watchdogNudge: '[STAGE NOTE] x', directorBrief: 'Push harder.',
        }));

        expect(assembled.included).toContain('gm.reminder');
        expect(assembled.included).not.toContain('watchdog.nudge');
    });

    it('the player message and Absolute Command survive a hostile enablement map', () => {
        // Structural modules ignore the predicate — a corrupt settings entry must never be
        // able to delete the player's own input from the prompt.
        const registry = createFinalUserRegistry();
        const specs = registry.collect(
            { ...base, absoluteCommand: 'Be terse.' },
            { isEnabled: () => false },
        );

        const ids = specs.map((s) => s.id);
        expect(ids).toContain('user.message');
        expect(ids).toContain('absolute.command');
        expect(ids).not.toContain('gm.reminder');
    });

    it('every built-in is unbounded, which is what keeps the migration byte-identical', () => {
        const specs = createFinalUserRegistry().collect({ ...base, directorBrief: 'x' });
        expect(specs.every((s) => s.budget === undefined)).toBe(true);
    });
});
