import type { CreationSlot } from '../../types';

/**
 * WO-A2 §2.4 — tolerant parser for the AI-Guided interview output.
 *
 * The skeleton is fixed: line `N)` maps to slot `N+1` by construction. The
 * model never sees the field map and therefore cannot corrupt it — we parse
 * line numbers, not field bindings.
 *
 * Accepts `1.`, `1)`, `**1.**`, `Question 1:`. Ignores any preamble before
 * the first numbered line. Then validates: expected count, each non-empty,
 * each within a length bound.
 *
 * Returns `{ ok, lines, error }`. On failure, the caller's failure ladder
 * (§2.4) decides whether to retry or drop into Manual.
 */

const LINE_RE = /^(?:\*\*)?(?:Question\s*)?(\d+)(?:[.)]|:)\s*(.*)$/i;

export type ParseResult =
    | { ok: true; lines: string[] }
    | { ok: false; error: 'wrong-count' | 'empty-entry' | 'too-long' | 'no-lines'; detail?: string };

// Questions now carry inline lore-derived examples ("for instance, the Iron
// Ward, Old Kesh…"), so a reskinned line is legitimately longer than the bare
// stock wording. The prompt caps examples at ~500 chars; 800 leaves headroom
// before we treat a line as runaway output.
const MAX_LINE_LEN = 800;

/**
 * Parse a numbered-plain-text interview response into a slot-indexed array.
 *
 * @param raw        The raw LLM output.
 * @param expectedCount The expected number of lines (e.g. 4 for slots 2–5).
 * @param startSlot  The slot number the first line maps to (default 2 — slots 2–5 / 6–8).
 *                   Used only to interpret `Question N:` labels that reference
 *                   absolute slot numbers.
 */
export function parseInterviewLines(
    raw: string,
    expectedCount: number,
    startSlot = 2,
): ParseResult {
    if (!raw || !raw.trim()) return { ok: false, error: 'no-lines' };

    const rawLines = raw.split(/\r?\n/);
    const numbered: { slot: number; text: string }[] = [];

    for (const line of rawLines) {
        const m = line.match(LINE_RE);
        if (!m) continue;
        const num = parseInt(m[1], 10);
        const text = m[2].trim();
        // Two numbering conventions:
        //   (a) 1..N (relative)  → slot = startSlot + (num - 1)
        //   (b) absolute slot    → num itself (e.g. "Question 6:" for slot 6)
        // We accept both: if num is within [1, expectedCount] treat as relative;
        // if num is within [startSlot, startSlot + expectedCount - 1] treat as absolute.
        let slot: number;
        if (num >= 1 && num <= expectedCount) {
            slot = startSlot + (num - 1);
        } else if (num >= startSlot && num <= startSlot + expectedCount - 1) {
            slot = num;
        } else {
            // Out of range — skip rather than fail. Other lines may still parse.
            continue;
        }
        numbered.push({ slot, text });
    }

    if (numbered.length === 0) return { ok: false, error: 'no-lines' };

    // Build the output ordered by slot, then dedupe (first occurrence wins).
    const bySlot = new Map<number, string>();
    for (const { slot, text } of numbered) {
        if (!bySlot.has(slot) && text) bySlot.set(slot, text);
    }

    const lines: string[] = [];
    for (let i = 0; i < expectedCount; i++) {
        const slot = startSlot + i;
        const text = bySlot.get(slot);
        if (!text) return { ok: false, error: 'empty-entry', detail: `slot ${slot}` };
        if (text.length > MAX_LINE_LEN) return { ok: false, error: 'too-long', detail: `slot ${slot} (${text.length} chars)` };
        lines.push(text);
    }

    if (lines.length !== expectedCount) {
        return { ok: false, error: 'wrong-count', detail: `got ${lines.length}, expected ${expectedCount}` };
    }

    return { ok: true, lines };
}

/**
 * Map a parsed lines array (one per slot in the requested range) back onto a
 * `Partial<Record<CreationSlot, string>>` keyed by absolute slot number.
 */
export function linesToSlotMap(
    lines: string[],
    startSlot: CreationSlot,
): Partial<Record<CreationSlot, string>> {
    const out: Partial<Record<CreationSlot, string>> = {};
    for (let i = 0; i < lines.length; i++) {
        const slot = (startSlot + i) as CreationSlot;
        out[slot] = lines[i];
    }
    return out;
}