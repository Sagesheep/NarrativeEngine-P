import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PromptOverride } from '../../../types';
import {
    fillTemplate, getPromptTemplate, hashPromptText, isOverrideStale, listPrompts, missingPlaceholders,
    normalizePromptOverrides, placeholdersIn, renderPrompt, setPromptOverrideSource, unknownPlaceholders,
    withOverride, withoutOverride,
} from '../promptRegistry';
import { defaultPromptText } from '../promptCatalog';

let overrides: Record<string, PromptOverride> | undefined;
setPromptOverrideSource(() => overrides);
afterEach(() => { overrides = undefined; });

describe('prompt catalog', () => {
    it('has unique ids and declares every placeholder its text uses', () => {
        const ids = listPrompts().map(def => def.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const def of listPrompts()) {
            expect(Object.keys(def.placeholders).sort(), def.id).toEqual(placeholdersIn(def.text).sort());
        }
    });

    it('every prompt is rendered somewhere in the app', () => {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                if (statSync(full).isDirectory()) { if (name !== '__tests__' && name !== 'prompts') walk(full); }
                else if (/\.tsx?$/.test(name)) files.push(readFileSync(full, 'utf8'));
            }
        };
        walk(join(__dirname, '..', '..', '..'));
        const source = files.join('\n');
        const unused = listPrompts().filter(def => !source.includes(`'${def.id}'`)).map(def => def.id);
        expect(unused).toEqual([]);
    });
});

describe('renderPrompt', () => {
    it('renders the built-in text when the campaign has no override', () => {
        expect(renderPrompt('memory.importance', { context: 'C', userText: 'U', gmText: 'G' }))
            .toBe(fillTemplate(defaultPromptText('memory.importance'), { context: 'C', userText: 'U', gmText: 'G' }));
        expect(renderPrompt('turn.swipe-line')).toBe(defaultPromptText('turn.swipe-line'));
    });

    it('uses the campaign override, filled with the same values', () => {
        overrides = { 'memory.importance': { text: 'Rate {{userText}} / {{gmText}}', baseHash: '' } };
        expect(renderPrompt('memory.importance', { context: 'C', userText: 'U', gmText: 'G' })).toBe('Rate U / G');
    });

    it('ignores a blank override', () => {
        overrides = { 'turn.swipe-line': { text: '   ', baseHash: '' } };
        expect(getPromptTemplate('turn.swipe-line')).toBe(defaultPromptText('turn.swipe-line'));
    });

    it('fills in one pass: values stay literal and are never re-scanned', () => {
        expect(fillTemplate('{{a}} {{b}} {{a}}', { a: '{{b}} $& $1', b: 'B' })).toBe('{{b}} $& $1 B {{b}} $& $1');
        expect(fillTemplate('{{unknown}} {"json": {"x": 1}}', {})).toBe('{{unknown}} {"json": {"x": 1}}');
    });
});

describe('override helpers', () => {
    it('editing back to the built-in text removes the override', () => {
        const base = defaultPromptText('turn.swipe-line');
        const edited = withOverride(undefined, 'turn.swipe-line', 'custom', 5);
        expect(edited).toEqual({ 'turn.swipe-line': { text: 'custom', baseHash: hashPromptText(base), updatedAt: 5 } });
        expect(withOverride(edited, 'turn.swipe-line', base)).toBeUndefined();
        expect(withoutOverride(edited, 'turn.swipe-line')).toBeUndefined();
    });

    it('notices when the built-in text changed after the override was written', () => {
        const fresh = withOverride(undefined, 'turn.swipe-line', 'custom')!['turn.swipe-line'];
        expect(isOverrideStale('turn.swipe-line', fresh)).toBe(false);
        expect(isOverrideStale('turn.swipe-line', { ...fresh, baseHash: 'deadbeef' })).toBe(true);
    });

    it('reports dropped and unknown placeholders', () => {
        expect(missingPlaceholders('memory.importance', 'Rate {{userText}} {{extra}}')).toEqual(['context', 'gmText']);
        expect(unknownPlaceholders('memory.importance', 'Rate {{userText}} {{extra}}')).toEqual(['extra']);
    });

    it('normalizes saved data: drops unknown ids, blank text and junk', () => {
        expect(normalizePromptOverrides({
            'turn.swipe-line': { text: 'x', baseHash: 'h', updatedAt: 1 },
            'no.such-prompt': { text: 'x', baseHash: 'h' },
            'turn.recommender': { text: '' },
            'turn.director': 'nope',
        })).toEqual({ 'turn.swipe-line': { text: 'x', baseHash: 'h', updatedAt: 1 } });
        expect(normalizePromptOverrides([])).toBeUndefined();
    });
});
