import type { AiTier } from '../../types';
import type { TierBlock } from './aiTier';

/**
 * Phase 7.3 — the mod-declared tier block registry.
 *
 * Mirrors `createPostTurnTrackRegistry` (`tracks/runner.ts`) and
 * `createContributionRegistry` (`payload/contributions/registry.ts`): a
 * generic, name-blind store that holds mod-declared tier entries and resolves
 * them through the same `tierAllows` contract built-in features use.
 *
 * Built-in tier features are NOT registered here. They live in the `MATRIX`
 * and `TIER_BLOCKS` constants in `aiTier.ts`. This registry holds ONLY
 * mod-declared entries — the ones a mod's manifest declares under
 * `tierEntries[]`. `tierAllows` consults `MATRIX` first (byte-identical for
 * the 27 built-in `TierFeature` ids) and falls through to this registry for
 * any other id. An id in neither source returns `false`, preserving the
 * characterization test's "unknown → false" contract.
 *
 * `listTierBlocks()` returns `[...TIER_BLOCKS, ...registry.list()]`, so the
 * block view renders mod entries alongside built-ins — the "default-as-plugin"
 * principle from the previous epic, applied to the tier matrix.
 */

/**
 * A mod-declared tier entry. Extends `TierBlock` (the metadata shape the
 * block view renders) with:
 *
 *   - `matrix` — the per-tier gate values. `tierAllows(tier, id)` returns
 *     `matrix[tier]`, exactly as it returns `MATRIX[tier][f]` for built-ins.
 *   - `cooldown` — an optional per-tier scene-gap throttle. Mirrors
 *     `ENEMY_DISCOVERY_COOLDOWN`. A mod's controller resolves it through
 *     `cooldownFor`; a mod that needs no throttle omits the field.
 *   - `modId` — provenance. The block view shows this under the entry's
 *     description so a user can see which mod contributed the feature.
 */
export interface ModTierEntry extends TierBlock {
    /** Per-tier gate values. `tierAllows(tier, id)` returns `matrix[tier]`. */
    readonly matrix: Record<AiTier, boolean>;
    /** Optional per-tier cooldown (scene gap). Mirrors `ENEMY_DISCOVERY_COOLDOWN`. */
    readonly cooldown?: Partial<Record<AiTier, number>>;
    /** Which mod declared this entry. Provenance for the block view. */
    readonly modId: string;
}

export interface TierBlockRegistry {
    /** Register a mod tier entry. Throws on duplicate id — always a packaging bug. */
    register(entry: ModTierEntry): void;
    /** Remove an entry by id. Returns whether it was present. */
    unregister(id: string): boolean;
    /** Remove every entry declared by `modId`. Used on mod disable/uninstall. */
    unregisterMod(modId: string): void;
    /** All registered mod tier entries, in registration order. For the block view. */
    list(): readonly ModTierEntry[];
    /** Look up a single entry by id. */
    get(id: string): ModTierEntry | undefined;
    /**
     * Resolve the tier gate for a mod-declared entry. Returns `false` for an
     * id that is not registered — the same "absent means disabled" contract
     * `tierAllows` uses for built-in features (the opposite of the "absent
     * means enabled" convention contributions/tracks use).
     */
    allows(tier: AiTier, id: string): boolean;
    /**
     * Resolve the per-tier cooldown for a mod-declared entry. Returns
     * `undefined` when the entry has no cooldown or is not registered.
     */
    cooldownFor(id: string, tier: AiTier): number | undefined;
    /** Drop all entries. Test/teardown only. */
    clear(): void;
}

export function createTierBlockRegistry(): TierBlockRegistry {
    const entries = new Map<string, ModTierEntry>();

    return {
        register(entry) {
            if (entries.has(entry.id)) {
                throw new Error(`[tier-blocks] duplicate mod tier entry id: ${entry.id}`);
            }
            entries.set(entry.id, entry);
        },

        unregister(id) {
            return entries.delete(id);
        },

        unregisterMod(modId) {
            for (const [id, entry] of entries) {
                if (entry.modId === modId) entries.delete(id);
            }
        },

        list() {
            return [...entries.values()];
        },

        get(id) {
            return entries.get(id);
        },

        allows(tier, id) {
            const entry = entries.get(id);
            if (!entry) return false;
            return entry.matrix[tier] ?? false;
        },

        cooldownFor(id, tier) {
            return entries.get(id)?.cooldown?.[tier];
        },

        clear() {
            entries.clear();
        },
    };
}
