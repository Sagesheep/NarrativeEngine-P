import { describe, it, expect } from 'vitest';
import {
    ABSOLUTE_COMMAND_MAX_CHARS,
    clampAbsoluteCommand,
    buildAbsoluteCommandBlock,
} from '../absoluteCommand';

describe('Absolute Command v1 — pure module', () => {
    describe('clampAbsoluteCommand', () => {
        it('trims and collapses internal whitespace', () => {
            expect(clampAbsoluteCommand('  Elara   has   known him  ')).toBe('Elara has known him');
        });

        it('returns empty string for empty input', () => {
            expect(clampAbsoluteCommand('')).toBe('');
            expect(clampAbsoluteCommand('   ')).toBe('');
            expect(clampAbsoluteCommand('\n\t')).toBe('');
        });

        it('returns the trimmed string unchanged when under the cap', () => {
            const text = 'a'.repeat(ABSOLUTE_COMMAND_MAX_CHARS);
            expect(clampAbsoluteCommand(text)).toBe(text);
        });

        it('truncates with ellipsis when over the cap', () => {
            const text = 'a'.repeat(ABSOLUTE_COMMAND_MAX_CHARS + 50);
            const clamped = clampAbsoluteCommand(text);
            expect(clamped.length).toBe(ABSOLUTE_COMMAND_MAX_CHARS);
            expect(clamped.endsWith('...')).toBe(true);
        });

        it('mirrors ASK_GM_BRIEF_MAX_CHARS (800)', () => {
            expect(ABSOLUTE_COMMAND_MAX_CHARS).toBe(800);
        });
    });

    describe('buildAbsoluteCommandBlock', () => {
        it('returns empty string for undefined', () => {
            expect(buildAbsoluteCommandBlock(undefined)).toBe('');
        });

        it('returns empty string for empty input', () => {
            expect(buildAbsoluteCommandBlock('')).toBe('');
        });

        it('returns empty string for whitespace-only input', () => {
            expect(buildAbsoluteCommandBlock('   \n\t ')).toBe('');
        });

        it('emits the binding OOC block with the right header/footer', () => {
            const block = buildAbsoluteCommandBlock('Stop the hostility.');
            expect(block.startsWith('[USER ABSOLUTE COMMAND — OUT OF CHARACTER, BINDING]')).toBe(true);
            expect(block.endsWith('[END ABSOLUTE COMMAND]')).toBe(true);
        });

        it('substitutes the clamped text into the COMMAND: slot', () => {
            const block = buildAbsoluteCommandBlock('Elara has known him for years.');
            expect(block).toContain('COMMAND: Elara has known him for years.');
        });

        it('clamps overlong input before substitution', () => {
            const long = 'a'.repeat(ABSOLUTE_COMMAND_MAX_CHARS + 50);
            const block = buildAbsoluteCommandBlock(long);
            const clamped = 'a'.repeat(ABSOLUTE_COMMAND_MAX_CHARS - 3) + '...';
            expect(block).toContain(`COMMAND: ${clamped}`);
        });

        it('collapses whitespace in the substituted text', () => {
            const block = buildAbsoluteCommandBlock('Elara\n\nhas   known   him');
            expect(block).toContain('COMMAND: Elara has known him');
        });

        it('contains the outranking clause', () => {
            const block = buildAbsoluteCommandBlock('test');
            expect(block).toContain('outranks every other directive');
        });

        it('contains the silent-application clause', () => {
            const block = buildAbsoluteCommandBlock('test');
            expect(block).toContain('Apply it silently and write the scene');
        });

        it('contains the for-this-turn scope clause', () => {
            const block = buildAbsoluteCommandBlock('test');
            expect(block).toContain('For this turn it outranks');
        });
    });
});