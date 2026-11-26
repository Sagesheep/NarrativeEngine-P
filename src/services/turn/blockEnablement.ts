import type { AiTier } from '../../types';
import { MATRIX, type TierFeature } from './aiTier';
import { getBuiltinTokenCap } from '../payload/contributions/builtins';

/**
 * WORKORDER-P5-01 §4 Step 2 — the single enablement resolver.
 *
 * One predicate behind the two enablement systems that used to be parallel:
 * the tier matrix (`aiTier.ts`) and the module toggles (`settings.moduleEnabled`).
 * After this work order a tier is a named preset of switch positions rather than
 * a separate mechanism.
 *
 * Resolution order, exactly:
 *   1. An EXPLICIT entry in `moduleEnabled` for `blockId` wins — `true` or `false`.
 *   2. Otherwise fall back to the tier preset (the `MATRIX` in `aiTier.ts`).
 *   3. Unknown id → `false`... with the asymmetry below.
 *
 * ── The asymmetry (preserve it) ────────────────────────────────────────────
 * The existing `moduleEnabled` convention is "absent means enabled" for the
 * prompt contributions and post-turn tracks (see `payloadBuilder.ts:243` and
 * `tracks/runner.ts:75`). Contributions and tracks are NOT in the tier matrix,
 * so a matrix miss for them must still resolve to ENABLED — not `false`. Encode
 * this as: matrix miss + no explicit entry → enabled for ids not in
 * `TierFeature`, and the matrix value for ids that are.
 *
 * Net behaviour for the three callers:
 *   - `tierAllows(tier, f)` — passes `moduleEnabled: undefined`. The resolver
 *     looks up the matrix only, which is byte-identical to today's body.
 *   - `payloadBuilder` / `tracks/runner` — pass real `moduleEnabled`. For their
 *     ids (not in `TierFeature`) an absent key resolves to enabled, matching
 *     the old `moduleEnabled?.[id] !== false` inline check exactly.
 */
export function isBlockEnabled(
    blockId: string,
    tier: AiTier | undefined,
    moduleEnabled: Record<string, boolean> | undefined,
): boolean {
    const explicit = moduleEnabled?.[blockId];
    if (explicit !== undefined) return explicit;

    const preset = MATRIX[tier ?? 'pro'];
    if (preset && (blockId in preset)) {
        return preset[blockId as TierFeature];
    }

    return true;
}
/** Resolve a module-owned utility call cap from persisted settings. */
export function blockTokenCap(
    blockId: string,
    declaredDefault: number,
    moduleTokens: Record<string, number> | undefined,
): number {
    const declaration = getBuiltinTokenCap(blockId);
    const min = declaration?.min ?? 0;
    const max = declaration?.max ?? Number.POSITIVE_INFINITY;
    const fallback = Number.isFinite(declaredDefault) && declaredDefault > 0
        ? Math.min(max, Math.max(min, declaredDefault))
        : min;
    const persisted = moduleTokens?.[blockId];
    if (typeof persisted !== "number" || !Number.isFinite(persisted) || persisted <= 0) return fallback;
    return Math.min(max, Math.max(min, persisted));
}
