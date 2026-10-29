import type { NPCEntry } from '../../types';
import { createWitnessResolver, type WitnessResolver } from './witnessResolve';

/**
 * Engine-side parser for the scene header's `👥` (who is here) field — the
 * sibling of `parseLocationHeader` (locationHeader.ts). Zero LLM.
 *
 * The default ruleset asks for `👥 [Present] Rin, Mira` (defaultRules.ts:51),
 * but custom rulesets write the field their own way, and the old exact-label
 * regex matched none of the owner's campaigns (0 of ~1,600 header lines on
 * 2026-10-04), so the on-stage set was always empty. Accepted shapes:
 *   `👥 [Present] Rin, Mira`          (default ruleset)
 *   `👥 Present: Rin, Mira`           (labeled, no brackets)
 *   `👥 [**Rin**], [**Mira**]`        (bracketed, bold)
 *   `👥 [Headman **Lao Cheng**, grieving boy]`
 *   `👥 Nobody`                        (→ an empty list, not "no header")
 */
const PRESENT_HEADER_RE = /👥\s*([^|\n]*)/gu;
const NOBODY_RE = /^(?:nobody|no ?one|none|empty|alone|n\/a|-+|—|–)$/i;
// Placeholders for someone unidentified. They must not reach the resolver, whose
// one-word match would pin them on an NPC with a stray alias ("Name Unknown").
const PLACEHOLDER_RE = /^(?:unknown|someone|somebody|stranger|others?|various)$/i;

/** The `👥` names of a GM reply. `null` when the reply has no `👥` field at all;
 *  `[]` when the field says nobody is there. With several `👥` fields (a mid-reply
 *  scene shift) the LAST one wins: it says who is there where the scene ended. */
export function parsePresentHeader(content: string): string[] | null {
    const matches = [...content.matchAll(PRESENT_HEADER_RE)];
    if (matches.length === 0) return null;
    // Strip markup BEFORE the label: models bold it too ("👥 **Present:** [**Grey**], …").
    let raw = matches[matches.length - 1][1]
        .split(/📅|📍/u)[0]
        .replace(/\([^)]*\)/g, '')
        .replace(/[[\]*_`"«»]/g, '')
        .replace(/^\s*present\b\s*:?/i, '');
    raw = raw.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '').trim();
    if (!raw || NOBODY_RE.test(raw)) return [];
    return raw
        .split(/\s*(?:[,;&]|\band\b)\s*/i)
        .map(name => name.trim())
        .filter(name => name.length > 0 && name.length < 60 && !NOBODY_RE.test(name) && !PLACEHOLDER_RE.test(name));
}

/** The ledger NPCs a `👥` list names, in header order, each once. Descriptors that
 *  name nobody ("grieving boy", "several villagers") resolve to nothing. */
export function resolvePresentNpcs(
    names: readonly string[],
    ledger: readonly NPCEntry[],
    resolve: WitnessResolver = createWitnessResolver(ledger),
): NPCEntry[] {
    const out: NPCEntry[] = [];
    for (const name of names) {
        for (const npc of resolve(name)) {
            if (!out.includes(npc)) out.push(npc);
        }
    }
    return out;
}
