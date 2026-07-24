import { describe, it, expect } from 'vitest';
import { sanitizeFilenamePart, buildCharacterExportFilename, buildCharacterExportData } from '../characterExport';
import type { PlayerCharacter } from '../../../types';

describe('sanitizeFilenamePart', () => {
    it('replaces unsafe characters with underscores', () => {
        expect(sanitizeFilenamePart('Sir Reginald / "The Bold"!')).toBe('Sir_Reginald_The_Bold');
    });

    it('collapses repeated separators and trims edges', () => {
        expect(sanitizeFilenamePart('  ---Weird***Name---  ')).toBe('Weird_Name');
    });

    it('falls back to "character" when nothing survives sanitization', () => {
        expect(sanitizeFilenamePart('///???')).toBe('character');
    });
});

describe('buildCharacterExportFilename', () => {
    it('builds a deterministic filename with a sanitized name and ISO date', () => {
        const date = new Date('2026-07-24T12:00:00Z');
        expect(buildCharacterExportFilename('John Roleplay', date)).toBe('character_export_John_Roleplay_2026-07-24.json');
    });
});

describe('buildCharacterExportData', () => {
    it('wraps the PC in a single-element array and strips the portrait', () => {
        const pc = {
            id: 'pc-1',
            name: 'John Roleplay',
            portrait: 'data:image/png;base64,AAAA',
            appearance: 'Lean, wiry',
        } as unknown as PlayerCharacter;

        const result = buildCharacterExportData(pc);
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('portrait');
        expect(result[0]).toMatchObject({ id: 'pc-1', name: 'John Roleplay', appearance: 'Lean, wiry' });
    });
});
