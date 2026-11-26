import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payloadBuilder';
import type { AppSettings, GameContext } from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';

// ── Fixtures ────────────────────────────────────────────────────────────────

const baseContext = (): GameContext => ({
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
    starter: '', continuePrompt: '', inventory: '', inventoryLastScene: 'Never',
    characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false,
    starterActive: false, continuePromptActive: false,
    inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: true, encounterEngineActive: true,
    worldEngineActive: true, diceFairnessActive: true,
    sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '',
    notebook: [], notebookActive: true,
} as unknown as GameContext);

const baseSettings = (): AppSettings => ({
    debugMode: true,
    contextLimit: 8192,
} as unknown as AppSettings);

/** Thinking-enabled settings (so the CoT nudge rides in the final user message). */
const thinkingSettings = (): AppSettings => ({
    ...baseSettings(),
    activePresetId: 'preset_reasoning',
    providers: [{ id: 'prov_reasoning', modelName: 'anything', thinkingEffort: 'medium' }],
    presets: [{ id: 'preset_reasoning', storyAIProviderId: 'prov_reasoning' }],
} as unknown as AppSettings);

/** Thinking-off settings (CoT nudge collapses to ''). */
const thinkingOffSettings = (): AppSettings => ({
    ...baseSettings(),
    activePresetId: 'preset_normal',
    providers: [{ id: 'prov_normal', modelName: 'gpt-4o', thinkingEffort: 'off' }],
    presets: [{ id: 'preset_normal', storyAIProviderId: 'prov_normal' }],
} as unknown as AppSettings);

function finalUserContent(messages: OpenAIMessage[]): string {
    const last = messages[messages.length - 1];
    return last && last.role === 'user' && typeof last.content === 'string' ? last.content : '';
}

const USER_MESSAGE = 'I greet Elara warmly.';
const COMMAND_TEXT = 'Elara has known him for years — stop writing her as hostile.';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Absolute Command v1 — buildPayload integration (WO §5.5)', () => {
    describe('invariant 1 — byte identity when absent', () => {
        it('absoluteCommand undefined produces the same final user content as the pre-WO payload (thinking off)', () => {
            const without = buildPayload({
                settings: thinkingOffSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
            });
            const withUndefined = buildPayload({
                settings: thinkingOffSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: undefined,
            });
            expect(finalUserContent(withUndefined.messages)).toBe(finalUserContent(without.messages));
        });

        it('absoluteCommand undefined produces the same final user content as the pre-WO payload (thinking on)', () => {
            const without = buildPayload({
                settings: thinkingSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
            });
            const withUndefined = buildPayload({
                settings: thinkingSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: undefined,
            });
            expect(finalUserContent(withUndefined.messages)).toBe(finalUserContent(without.messages));
        });

        it('absoluteCommand empty string is treated as absent (byte-identical to undefined)', () => {
            const withUndefined = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: undefined,
            });
            const withEmpty = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: '',
            });
            expect(finalUserContent(withEmpty.messages)).toBe(finalUserContent(withUndefined.messages));
        });

        it('absoluteCommand whitespace-only is treated as absent', () => {
            const withUndefined = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: undefined,
            });
            const withWs = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: '   \n\t ',
            });
            expect(finalUserContent(withWs.messages)).toBe(finalUserContent(withUndefined.messages));
        });
    });

    describe('invariant 2 — suppression when present', () => {
        it('GM_REMINDER is omitted when absoluteCommand is present', () => {
            const result = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: COMMAND_TEXT,
            });
            const content = finalUserContent(result.messages);
            expect(content).not.toContain('[GM REMINDER:');
        });

        it('watchdog nudge is omitted when absoluteCommand is present', () => {
            const result = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                watchdogNudge: 'WATCHDOG_SHOULD_BE_SUPPRESSED',
                absoluteCommand: COMMAND_TEXT,
            });
            const content = finalUserContent(result.messages);
            expect(content).not.toContain('WATCHDOG_SHOULD_BE_SUPPRESSED');
        });

        it('watchdog nudge is omitted when absoluteCommand is present even if directorBrief is also passed', () => {
            // buildPayload is called from three sites and must be correct standalone.
            // The WO §5.5 belt-and-braces gate only suppresses the watchdog nudge
            // when hasAbsolute; the Director block itself is suppressed at the
            // orchestrator stage (§5.3), not here. This test pins that contract:
            // the watchdog is suppressed, the Director block is NOT (it would
            // emit if a caller passed both — the orchestrator simply never does).
            const result = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                watchdogNudge: 'WATCHDOG_SHOULD_BE_SUPPRESSED',
                directorBrief: 'BRIEF_TEXT',
                absoluteCommand: COMMAND_TEXT,
            });
            const content = finalUserContent(result.messages);
            expect(content).not.toContain('WATCHDOG_SHOULD_BE_SUPPRESSED');
            expect(content).toContain('[DIRECTOR BRIEF]');
            expect(content).toContain('BRIEF_TEXT');
        });

        it('directorBrief is omitted from the final user content when not passed (orchestrator skips Director under absolute command)', () => {
            // Mirrors the real orchestrator path: §5.3 skips runDirectorStage,
            // so directorBrief arrives as undefined and the block collapses.
            const result = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: COMMAND_TEXT,
            });
            const content = finalUserContent(result.messages);
            expect(content).not.toContain('[DIRECTOR BRIEF]');
        });
    });

    describe('ordering — the command block is the final segment', () => {
        it('absoluteCommandBlock is placed AFTER userMessage (maximum recency)', () => {
            const result = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: COMMAND_TEXT,
            });
            const content = finalUserContent(result.messages);
            const userMsgIdx = content.indexOf(USER_MESSAGE);
            const commandIdx = content.indexOf('[USER ABSOLUTE COMMAND');
            expect(userMsgIdx).toBeGreaterThanOrEqual(0);
            expect(commandIdx).toBeGreaterThan(userMsgIdx);
            // The block is the last segment — content ends with the command's footer.
            expect(content.endsWith('[END ABSOLUTE COMMAND]')).toBe(true);
        });
    });

    describe('CoT nudge swap (thinking mode only)', () => {
        it('under absolute command + thinking on, subordinates the framework (not flat invocation)', () => {
            const result = buildPayload({
                settings: thinkingSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: COMMAND_TEXT,
            });
            const content = finalUserContent(result.messages);
            expect(content).not.toContain('Work through the [WRITER REASONING FRAMEWORK] in your reasoning before writing.');
            expect(content).toContain('Work through the [WRITER REASONING FRAMEWORK] only where it does not conflict with [USER ABSOLUTE COMMAND].');
            expect(content).toContain('Where they conflict, discard the framework step and follow the command.');
        });

        it('under absolute command + thinking off, no CoT nudge at all (byte-identical to no-command)', () => {
            const result = buildPayload({
                settings: thinkingOffSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: COMMAND_TEXT,
            });
            const content = finalUserContent(result.messages);
            expect(content).not.toContain('Work through the [WRITER REASONING FRAMEWORK]');
        });
    });

    describe('WRITER_COT stays in the cached stable prefix (WO §2 — never conditionally removed)', () => {
        it('the WRITER_COT framework text still appears in the system message under an absolute command (thinking on)', () => {
            const result = buildPayload({
                settings: thinkingSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: COMMAND_TEXT,
            });
            const systemMsg = result.messages.find(m => m.role === 'system');
            expect(systemMsg).toBeDefined();
            const sysContent = typeof systemMsg!.content === 'string' ? systemMsg!.content : '';
            expect(sysContent).toContain('[WRITER REASONING FRAMEWORK]');
            expect(sysContent).toContain('Step 1 — Deconstruct');
            expect(sysContent).toContain('Step 6 — Final audit');
        });
    });

    describe('trace row (debug mode)', () => {
        it('records an Absolute Command trace when the block is present', () => {
            const result = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
                absoluteCommand: COMMAND_TEXT,
            });
            const trace = (result.trace ?? []).find(t => t.source === 'Absolute Command');
            expect(trace).toBeDefined();
            expect(trace!.classification).toBe('world_context');
            expect(trace!.position).toBe('user');
            expect(trace!.included).toBe(true);
            expect(trace!.preview).toContain('[USER ABSOLUTE COMMAND');
        });

        it('records no Absolute Command trace when the block is absent', () => {
            const result = buildPayload({
                settings: baseSettings(), context: baseContext(), history: [], userMessage: USER_MESSAGE,
            });
            const trace = (result.trace ?? []).find(t => t.source === 'Absolute Command');
            expect(trace).toBeUndefined();
        });
    });
});