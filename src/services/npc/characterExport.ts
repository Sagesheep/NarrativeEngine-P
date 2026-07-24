import type { PlayerCharacter } from '../../types';

/**
 * Pure helpers for Character Ledger export — factored out of
 * `CharacterLedgerModal.tsx` so the filename sanitization and array shaping
 * can be unit tested without mounting the component.
 */

/** Strip characters that are unsafe in a filename, collapsing whitespace to underscores. */
export function sanitizeFilenamePart(raw: string): string {
    return raw.trim().replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/[-_]+/g, '_').replace(/^[-_]+|[-_]+$/g, '') || 'character';
}

/** `character_export_<sanitized-name>_<YYYY-MM-DD>.json` */
export function buildCharacterExportFilename(name: string, date: Date = new Date()): string {
    return `character_export_${sanitizeFilenamePart(name)}_${date.toISOString().slice(0, 10)}.json`;
}

/**
 * Shape a PC into the same single-element JSON array format the NPC ledger
 * exports, minus its portrait (data-URI images bloat the file and aren't
 * meant to round-trip). Array form keeps it cross-compatible: a character
 * export can be re-imported as an NPC and vice versa.
 */
export function buildCharacterExportData(pc: PlayerCharacter): Partial<PlayerCharacter>[] {
    const { portrait: _p, ...rest } = pc;
    return [rest];
}
