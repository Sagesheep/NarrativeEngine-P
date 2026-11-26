import type { NPCEntry } from '../../types';
import { npcIdentityKeys } from './relationResolve';
import { findLedgerMatches } from './npcManualResolve';

/**
 * Archive witness lists hold display names, never ledger ids: the server
 * heuristic (`server/lib/nlp.js`), the LLM witness pass and the seal
 * correction all write names. Readers that compared them against NPC ids
 * matched nothing, so every witnessed scene was treated as unwitnessed.
 * Anything that needs ids (on-stage checks) or canonical names (labels)
 * resolves witnesses through here.
 *
 * Resolution order, per witness:
 *   1. a ledger id (legacy and test data) → that NPC;
 *   2. an exact name or alias, case- and space-insensitive → every NPC
 *      carrying it (duplicate ledger entries for one person both match);
 *   3. a first- or last-word match ("Rin" → "Rin Holmes"), only when exactly
 *      one NPC fits. "Holmes" with two Holmeses resolves to nothing.
 * Unknown names ("The Voice", heuristic noise such as place names) resolve to
 * nothing.
 *
 * Pure, no I/O. Results are cached per resolver, so build one per turn.
 */
export type WitnessResolver = (witness: string) => readonly NPCEntry[];

function normalize(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

export function createWitnessResolver(ledger: readonly NPCEntry[]): WitnessResolver {
    const named = ledger.filter(n => typeof n.name === 'string' && n.name.trim() !== '');
    const byId = new Map(named.map(n => [n.id, n]));
    const byKey = new Map<string, NPCEntry[]>();
    for (const npc of named) {
        for (const key of npcIdentityKeys(npc)) {
            const k = normalize(key);
            const list = byKey.get(k) ?? [];
            if (!list.includes(npc)) list.push(npc);
            byKey.set(k, list);
        }
    }
    const cache = new Map<string, readonly NPCEntry[]>();
    return witness => {
        if (typeof witness !== 'string') return [];
        const raw = normalize(witness);
        if (!raw) return [];
        const cached = cache.get(raw);
        if (cached) return cached;
        let out: readonly NPCEntry[];
        const idHit = byId.get(raw);
        if (idHit) {
            out = [idHit];
        } else {
            const exact = byKey.get(raw.toLowerCase());
            if (exact) {
                out = exact;
            } else {
                const partial = findLedgerMatches(raw, named);
                out = partial.length === 1 ? partial : [];
            }
        }
        cache.set(raw, out);
        return out;
    };
}

/** Ledger ids of a scene's resolvable witnesses. */
export function witnessIds(witnesses: readonly string[] | undefined, resolve: WitnessResolver): Set<string> {
    const ids = new Set<string>();
    for (const w of witnesses ?? []) {
        for (const npc of resolve(w)) ids.add(npc.id);
    }
    return ids;
}

/** Canonical ledger names of a scene's resolvable witnesses, de-duplicated, in witness order. */
export function witnessNames(witnesses: readonly string[] | undefined, resolve: WitnessResolver): string[] {
    const names: string[] = [];
    for (const w of witnesses ?? []) {
        for (const npc of resolve(w)) {
            if (!names.includes(npc.name)) names.push(npc.name);
        }
    }
    return names;
}
