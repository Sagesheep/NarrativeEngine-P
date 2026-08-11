/**
 * Phase 9.2 — the mod API generation.
 *
 * One integer, shared by the loader (which rejects a mod from the future) and
 * the client (which publishes it on `ctx.api.apiVersion`). It is deliberately
 * NOT the app version: the app version moves for reasons that have nothing to
 * do with the mod surface, and a mod author should not have to re-read a
 * changelog every time a provider is added.
 *
 * The rule this number carries (`COMPAT.md`, `docs/MODDING.md` §"Compatibility
 * and the frozen surface"):
 *
 *   • Inside a generation the public surface is **additive only**. Nothing
 *     listed as frozen is removed, renamed, or re-signatured.
 *   • A breaking change bumps this number. **The bump is the announcement** —
 *     there is no deprecation window and no compatibility shim. Mods follow
 *     the app.
 *   • A mod declaring a HIGHER generation than the host is refused at load,
 *     naming both numbers. It was written against a surface this app does not
 *     have.
 *   • A mod declaring a LOWER generation loads, with a visible notice. It was
 *     written against a surface that has since changed; it may work, and the
 *     host does not pretend to know.
 *   • `apiVersion` absent means generation 1 — every mod written before this
 *     field existed is a generation-1 mod, which is exactly what it is.
 */

/** The generation of the mod API this build implements. */
export const MOD_API_VERSION = 1;

/**
 * Generation an `apiVersion`-less manifest is treated as. Not `MOD_API_VERSION`:
 * a manifest that declares nothing was written against generation 1, and
 * silently promoting it to the current generation would erase the one signal
 * the mismatch check exists to read.
 */
export const DEFAULT_MOD_API_VERSION = 1;
