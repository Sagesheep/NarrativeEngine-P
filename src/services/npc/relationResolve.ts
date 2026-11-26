import type { NPCEntry, RelationGraph } from '../../types';

/**
 * WO-4 §3 — the canonical relation-key resolver.
 *
 * **The live bug (verified 2026-07-20):** three readers disagree about what a
 * `relations` key is. `update.ts` told the LLM it's an id; `world.ts` read by
 * name; `agencyCollision` read by id. The LLM only ever knows names, so stored
 * keys are overwhelmingly names — meaning the collision path read
 * `undefined → 0` for essentially every edge. **Off-screen NPCs have never once
 * tangled by relationship.**
 *
 * **The fix (per DESIGN-STAGING §2.6):** canonical key = name; legacy id keys
 * resolved forever by this resolver; **no data migration.** All three readers
 * route through here.
 *
 * This is also the identity resolver the ledger has needed generally —
 * `npcPressureTracker.ts`'s private `npcNamePatterns` duplicated the same alias
 * logic and now reads through `npcIdentityKeys` here.
 *
 * Pure module, no I/O. No data migration. No v3 branching.
 */

/**
 * Normalize a key for case- and space-insensitive comparison.
 * Collapses internal whitespace to single spaces and lowercases.
 */
function normalizeKey(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * All identity keys for an NPC: lowercased name + aliases (trimmed, deduped).
 * Used by the pressure tracker (`npcNamePatterns`) and as the alias-fallback
 * arm of the relation resolver.
 */
export function npcIdentityKeys(npc: NPCEntry): string[] {
    const keys: string[] = [npc.name.toLowerCase()];
    const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
    for (const alias of aliases) {
        if (!keys.includes(alias)) keys.push(alias);
    }
    return keys;
}

/**
 * Look up a key in a `relations` map, first exactly, then case- and
 * space-insensitively. Returns the stored number, or `undefined` when no
 * finite numeric value sits under that key.
 */
function lookupByKey(relations: RelationGraph, key: string): number | undefined {
    // 1. Exact match — preserves the existing `a.relations?.[b.name]` / `[b.id]`
    // fast path when the key is already canonical.
    if (Object.prototype.hasOwnProperty.call(relations, key)) {
        const v = relations[key];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    // 2. Case- and space-insensitive match (per WO-4 §6.3).
    const normalized = normalizeKey(key);
    for (const k in relations) {
        if (normalizeKey(k) === normalized) {
            const v = relations[k];
            if (typeof v === 'number' && Number.isFinite(v)) return v;
        }
    }
    return undefined;
}

/**
 * Resolve a single directed relation edge from `source` to `target`.
 *
 * Resolution order (per WO-4 §3 / DESIGN-STAGING §2.6):
 *   1. **canonical name** — `source.relations[target.name]` (case- and
 *      space-insensitive). The LLM only ever knows names, so this is where new
 *      edges live.
 *   2. **legacy id** — `source.relations[target.id]`. Edges written by the old
 *      `normalizeRelations` path (which canonicalised to ids) resolve here
 *      forever; no data migration.
 *   3. **alias** — each of `target.aliases`, case- and space-insensitive.
 *
 * Returns `undefined` for self-reference, absent edges, non-numeric values, and
 * unknown keys — so callers apply their own `?? 0` (or `?? pcFallback`) per
 * the work order's "including the `?? 0` fallbacks" rule. A present edge with
 * value `0` returns `0`, not `undefined`.
 */
export function resolveRelationTarget(source: NPCEntry, target: NPCEntry): number | undefined {
    if (source.id === target.id) return undefined;
    const relations = source.relations;
    if (!relations) return undefined;

    // 1. Canonical: by name (case- and space-insensitive).
    const byName = lookupByKey(relations, target.name);
    if (byName !== undefined) return byName;

    // 2. Legacy: by id (exact — ids are internal identifiers, not user-facing).
    if (Object.prototype.hasOwnProperty.call(relations, target.id)) {
        const v = relations[target.id];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
    }

    // 3. By alias (case- and space-insensitive).
    if (target.aliases) {
        const aliases = target.aliases.split(',').map(a => a.trim()).filter(Boolean);
        for (const alias of aliases) {
            const v = lookupByKey(relations, alias);
            if (v !== undefined) return v;
        }
    }

    return undefined;
}

/**
 * Resolve all directed edges from `source` to the NPCs in `targets`, including
 * zero-valued edges (so a stored `0` edge still reads as `0`, not "absent").
 * Self-edges are skipped. Returns `{ target, value }` pairs in `targets` order.
 *
 * The `value` is `0` when no edge resolves — the same default every reader fell
 * back to before. Use `resolveRelationTarget` directly when you need to
 * distinguish "absent" from "stored zero".
 *
 * Used by the payload renderer (`world.ts`) to surface on-stage NPC↔NPC
 * relations as a suppressible block, and available to any caller that needs
 * the full resolved edge set for a source NPC.
 */
export function resolveRelationEdges(
    source: NPCEntry,
    targets: readonly NPCEntry[],
): { target: NPCEntry; value: number }[] {
    const out: { target: NPCEntry; value: number }[] = [];
    for (const target of targets) {
        if (target.id === source.id) continue;
        const v = resolveRelationTarget(source, target);
        out.push({ target, value: v ?? 0 });
    }
    return out;
}