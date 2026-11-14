import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { combatTilesPlugin, scanCombatGlyphs } from '../../../../vite-plugins/combatTiles';
import { parseGlyphManifest } from '../glyphAvailability';
import { FORM_ICONS, EFFECT_ICONS, AUGMENT_ICONS } from '../glyphIcons';
import { AUGMENT_IDS, EFFECT_IDS, FORM_IDS } from '@narrative/engine';

const dirs: string[] = [];

function temp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ne-combat-glyphs-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('glyph art discovery', () => {
    it('is empty for a missing folder', () => {
        expect(scanCombatGlyphs(join(tmpdir(), 'ne-combat-glyphs-missing'))).toEqual([]);
    });

    it('lists lower-case png files only, sorted, with no names in source', () => {
        const dir = temp();
        for (const f of ['damage.png', 'amplify.png', 'Bad.png', 'note.txt', 'two-words.png']) writeFileSync(join(dir, f), '');
        mkdirSync(join(dir, 'sub'));
        expect(scanCombatGlyphs(dir)).toEqual(['amplify', 'damage', 'two-words']);
    });

    it('is defined next to the tile manifest, defaulting to the sibling glyphs folder', () => {
        const root = temp();
        mkdirSync(join(root, 'tiles'));
        mkdirSync(join(root, 'glyphs'));
        writeFileSync(join(root, 'glyphs', 'burst.png'), '');
        const hook = combatTilesPlugin(join(root, 'tiles')).config as unknown as () => { define: Record<string, string> };
        const define = hook().define;
        expect(parseGlyphManifest(JSON.parse(define.__COMBAT_GLYPHS__) as string).has('burst')).toBe(true);
        expect(Object.keys(define)).toContain('__COMBAT_TILES__');
    });

    it('has a default icon for every glyph id', () => {
        for (const id of FORM_IDS) expect(FORM_ICONS[id]).toBeDefined();
        for (const id of EFFECT_IDS) expect(EFFECT_ICONS[id]).toBeDefined();
        for (const id of AUGMENT_IDS) expect(AUGMENT_ICONS[id]).toBeDefined();
    });
});
