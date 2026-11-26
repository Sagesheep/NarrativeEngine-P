import type { HexAxis } from '../../../types';
import { RUNG_LABELS, RUNG_MIN, RUNG_MAX } from './agencyConstants';

// Export type HexAxis just in case it's needed as an export or for the caller's convenience.
export type { HexAxis };

const RELATION_WORDS = [
    'Arch-enemy', // -3
    'Hostile',    // -2
    'Cold',       // -1
    'Neutral',    // 0
    'Friendly',   // +1
    'Close',      // +2
    'Devoted'     // +3
];

const HEX_WORDS: Record<HexAxis, readonly string[]> = {
    drive: ['Listless', 'Apathetic', 'Idle', 'Steady', 'Motivated', 'Driven', 'Relentless'],
    diligence: ['Negligent', 'Lazy', 'Lax', 'Reliable', 'Diligent', 'Meticulous', 'Exacting'],
    boldness: ['Timid', 'Cautious', 'Wary', 'Measured', 'Bold', 'Daring', 'Reckless'],
    warmth: ['Frigid', 'Cold', 'Aloof', 'Even', 'Warm', 'Affable', 'Effusive'],
    empathy: ['Callous', 'Hard', 'Detached', 'Fair', 'Kind', 'Compassionate', 'Selfless'],
    composure: ['Volatile', 'Excitable', 'Tense', 'Calm', 'Composed', 'Serene', 'Unflappable']
};

/**
 * Maps a stored relation value (scale -3..+3) to a human-readable word.
 * Clamps out-of-range values: v < -3 is treated as -3, v > 3 is treated as +3.
 */
export function relationBand(v: number): string {
    const clamped = Math.max(-3, Math.min(3, Math.round(v)));
    return RELATION_WORDS[clamped + 3];
}

/**
 * Maps a personality hexagon axis value (scale -3..+3) to a human-readable word.
 * Clamps out-of-range values: v < -3 is treated as -3, v > 3 is treated as +3.
 */
export function hexBand(axis: HexAxis, v: number): string {
    const clamped = Math.max(-3, Math.min(3, Math.round(v)));
    const words = HEX_WORDS[axis];
    return words[clamped + 3];
}

/**
 * Deterministic seed map (no LLM) used by lazy migration to re-home an NPC's 0..100
 * affinity onto the dedicated -3..+3 pcRelation slot. Boundaries per Phase-2 contract §01:
 * <=15 -3, <=30 -2, <=45 -1, 46..55 0, <=70 +1, <=85 +2, >85 +3. NaN/undefined → Neutral (0).
 */
export function affinityToPcRelation(affinity: number): number {
    const a = Number.isFinite(affinity) ? affinity : 50;
    if (a <= 15) return -3;
    if (a <= 30) return -2;
    if (a <= 45) return -1;
    if (a <= 55) return 0;
    if (a <= 70) return 1;
    if (a <= 85) return 2;
    return 3;
}

/**
 * Returns a comma-joined list of the 6 band words for the personality hexagon.
 */
export function describeHex(hex: Record<HexAxis, number>): string {
    const axes: HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
    return axes.map(axis => hexBand(axis, hex[axis])).join(', ');
}

// ── Phase 4 word-bands (SHIFT surfacing) ──────────────────────────────────────
// Engine numbers NEVER reach a payload — these are the ONLY hex/rung surfacing. Player-facing text
// uses word-bands; the raw integer arrow is for the DEBUG view only (callers may keep it separately).

/**
 * Maps a power-rung integer (RUNG_MIN..RUNG_MAX) to its label. Clamps out-of-range values.
 */
export function formatRungBand(rung: number): string {
    const clamped = Math.max(RUNG_MIN, Math.min(RUNG_MAX, Math.round(rung)));
    return RUNG_LABELS[clamped];
}

/**
 * A personality-hex drift, as a word-band SHIFT line (e.g. "SHIFT: boldness Bold → Daring").
 * Returns '' when the band word is unchanged (a sub-band move not worth surfacing).
 */
export function formatHexShift(axis: HexAxis, from: number, to: number): string {
    const fromWord = hexBand(axis, from);
    const toWord = hexBand(axis, to);
    if (fromWord === toWord) return '';
    return `SHIFT: ${axis} ${fromWord} → ${toWord}`;
}

/**
 * A power-rung change, as a word-band SHIFT line (e.g. "SHIFT: Skilled → Expert").
 * Returns '' when the label is unchanged.
 */
export function formatRungShift(from: number, to: number): string {
    const fromWord = formatRungBand(from);
    const toWord = formatRungBand(to);
    if (fromWord === toWord) return '';
    return `SHIFT: ${fromWord} → ${toWord}`;
}
