// `promptAddenda` — mod-supplied steering text for the Continuity Director and
// the Context Recommender. Text only; the loader checks the target names, the
// type, and the per-target length cap.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMods } from '../lib/modLoader.js';

let dir;

const write = (folder, manifest) => {
    const modFolder = path.join(dir, folder);
    fs.mkdirSync(modFolder, { recursive: true });
    fs.writeFileSync(path.join(modFolder, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
};

const base = { id: 'steer', name: 'Steer', version: '1.0.0' };

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-addenda-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('promptAddenda manifest field', () => {
    it('accepts director and recommender text on its own, trimmed', () => {
        write('steer', { ...base, promptAddenda: { director: '  Watch faction loyalty.  ', recommender: 'Prefer faction lore.' } });
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].promptAddenda).toEqual({ director: 'Watch faction loyalty.', recommender: 'Prefer faction lore.' });
    });

    it('defaults to an empty object when absent', () => {
        write('steer', { ...base, contributions: [{ id: 'a', order: 1, text: 'x' }] });
        const { mods } = loadMods(dir, '1.0.4');
        expect(mods[0].promptAddenda).toEqual({});
    });

    it('rejects an unknown target', () => {
        write('steer', { ...base, promptAddenda: { writer: 'no' } });
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(mods).toEqual([]);
        expect(faults[0].reason).toMatch(/unknown target "writer"/);
    });

    it('rejects non-string and empty text', () => {
        write('steer', { ...base, promptAddenda: { director: 42 } });
        expect(loadMods(dir, '1.0.4').faults[0].reason).toMatch(/promptAddenda.director must be a non-empty string/);
        fs.rmSync(path.join(dir, 'steer'), { recursive: true });
        write('steer', { ...base, promptAddenda: { director: '   ' } });
        expect(loadMods(dir, '1.0.4').faults[0].reason).toMatch(/non-empty string/);
    });

    it('rejects text over 1200 characters', () => {
        write('steer', { ...base, promptAddenda: { recommender: 'x'.repeat(1201) } });
        expect(loadMods(dir, '1.0.4').faults[0].reason).toMatch(/1201 characters — the limit is 1200/);
    });

    it('rejects a non-object value', () => {
        write('steer', { ...base, promptAddenda: 'text' });
        expect(loadMods(dir, '1.0.4').faults[0].reason).toMatch(/promptAddenda must be an object/);
    });
});
