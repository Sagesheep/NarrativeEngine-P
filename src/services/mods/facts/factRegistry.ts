/**
 * Phase 5.4 — the fact publication registry.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 5.4 -
 * Mods publish facts - Medium-mid.md`. This module owns the store, the
 * namespacing + claim rule (§2 item 2), the conflict resolution by
 * `loading_order` (§2 item 3), the publisher containment (§3), and the
 * host-owned teardown on `disable` (same site mounts/macros/interceptors
 * already use).
 *
 * Design notes carried from Phase 5.4:
 *
 *   • **Namespacing.** A mod's own fact is namespaced the way macros are:
 *     the host qualifies `name` to `mod.<modId>.<name>`. A mod may not
 *     publish `inCombat` directly — it must `claims: 'inCombat'` and the
 *     host must have opened the name. The claim is what prevents the
 *     footgun the spec calls out: "the naive version, where any mod can
 *     set `inCombat`, is a footgun" (§2 item 2).
 *   • **Conflict.** Two mods claim the same core fact. The one earlier in
 *     `loading_order` wins; the later one is surfaced as a `conflict`
 *     fault and its value is NOT used. "Surface it rather than silently
 *     picking one" (§2 item 3) — both mods are named in the fault so
 *     the user can see who collided.
 *   • **Native-tier only.** Registration needs a closure (the
 *     publisher); a closure needs a module; a module is `native.js`.
 *   • **Never throws.** Shadow / conflict / revoked / bad-args
 *     registration records a fault and returns a no-op `unregister`.
 *   • **Teardown is host-owned.** `disableModFacts` removes every
 *     publisher the mod registered, at the same call site that already
 *     disposes subscriptions, event listeners, mounts, macros and
 *     interceptors.
 *   • **Publisher containment.** `runFactPublishers` runs every
 *     registered publisher for the turn. A throwing publisher is
 *     contained: the fact yields no value (no match) plus a surfaced
 *     fault. The turn never breaks.
 *   • **Absence stays false.** The merge in `runFactPublishers` only
 *     sets facts that were actually published. An unknown fact still
 *     means no match (`modAdapter.ts:evaluateWhen` is unchanged).
 *   • **Zero mods → facts behave exactly as today.** `runFactPublishers`
 *     returns an empty overlay when no publishers are registered, and
 *     `payloadBuilder` merges an empty overlay as a no-op.
 */
import type { ModFacts } from '../modTypes';
import type { FactPublicationResult, FactPublisher, FactRegistryMod, ModFactsApi } from './factTypes';
import { CLAIMABLE_CORE_FACT_SET, CORE_FACT_NAME_SET } from './factTypes';
import { factFaultStore, formatFactFaultReason } from './factFaults';

/** The id prefix that marks a mod-owned fact. */
const MOD_PREFIX = 'mod.';

/** The qualified name for a mod-owned (namespaced) fact: `mod.<modId>.<name>`. */
export function qualifyFactName(modId: string, name: string): string {
    return `${MOD_PREFIX}${modId}.${name}`;
}

interface RegisteredPublisher {
    readonly modId: string;
    readonly modName: string;
    readonly loadIndex: number;
    /** The bare name the mod registered (the key in `byMod`). */
    readonly bareName: string;
    /** The core fact name this publisher claims, or `undefined` for a namespaced mod fact. */
    readonly claim: string | undefined;
    readonly publisher: FactPublisher;
}

/** Per-mod maps of bare name → registered publisher. Keyed by mod id, then bare name. */
const byMod = new Map<string, Map<string, RegisteredPublisher>>();

/** The flat lookup for publication: every registered publisher, in run order. */
const publishers: RegisteredPublisher[] = [];

/** Claims on core facts: core fact name → the mod id that owns the claim. */
const claims = new Map<string, string>();

/** The set of mods whose lease has been revoked (disabled). */
const revokedMods = new Set<string>();

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isPublisher(value: unknown): value is FactPublisher {
    return typeof value === 'function';
}

/** Remove a publisher from the flat array by (modId, bareName). */
function removeFromFlatArray(modId: string, bareName: string): void {
    for (let i = publishers.length - 1; i >= 0; i--) {
        if (publishers[i].modId === modId && publishers[i].bareName === bareName) {
            publishers.splice(i, 1);
            break;
        }
    }
}

/** Remove one publisher. Called by the returned `unregister()` and by `disableModFacts`. */
function unregisterModFact(modId: string, bareName: string): void {
    const modMap = byMod.get(modId);
    if (modMap === undefined) return;
    const record = modMap.get(bareName);
    if (record === undefined) return;
    modMap.delete(bareName);
    if (record.claim !== undefined) {
        // Only clear the claim if THIS mod owned it.
        if (claims.get(record.claim) === modId) {
            claims.delete(record.claim);
        }
    }
    removeFromFlatArray(modId, bareName);
    if (modMap.size === 0) byMod.delete(modId);
}

/**
 * Phase 5.4 §2.1 — register a mod's fact publisher.
 *
 * The host qualifies the name. For a namespaced mod fact the qualified
 * form is `mod.<modId>.<name>` and the host does not merge it into the
 * core facts (it is available for future expansion). For a CLAIMED core
 * fact the bare name (`inCombat`) is used and the host merges the
 * publisher's value into the facts overlay.
 *
 * Never throws: a shadow / conflict / revoked / bad-args registration
 * records a fault and returns a no-op `unregister`.
 */
export function registerModFact(
    mod: FactRegistryMod,
    name: string,
    publisher: FactPublisher,
    options: { faultFile?: string; claims?: string } = {},
): () => void {
    const faultFile = options.faultFile ?? `mod:${mod.id}`;
    const loadIndex = typeof mod.loadIndex === 'number' && Number.isFinite(mod.loadIndex) ? mod.loadIndex : 0;

    // Bad args — programming bug; record a fault and no-op.
    if (!isNonEmptyString(name) || !isPublisher(publisher)) {
        factFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'duplicate',
            name: isNonEmptyString(name) ? name : undefined,
            reason: formatFactFaultReason({
                modName: mod.name,
                kind: 'duplicate',
                name: isNonEmptyString(name) ? name : undefined,
                message: 'invalid name or publisher',
            }),
        });
        return () => undefined;
    }

    // Revoked lease — no-op plus fault.
    if (revokedMods.has(mod.id)) {
        factFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'revoked',
            name,
            reason: formatFactFaultReason({ modName: mod.name, kind: 'revoked', name }),
        });
        return () => undefined;
    }

    const claim = options.claims;

    // If the mod claims a core fact, validate the claim.
    if (claim !== undefined) {
        if (!isNonEmptyString(claim)) {
            factFaultStore.add({
                modId: mod.id,
                file: faultFile,
                kind: 'shadow',
                name,
                reason: formatFactFaultReason({ modName: mod.name, kind: 'shadow', name }),
            });
            return () => undefined;
        }
        // The claim must be a core fact name the host has opened.
        if (!CLAIMABLE_CORE_FACT_SET.has(claim)) {
            factFaultStore.add({
                modId: mod.id,
                file: faultFile,
                kind: 'shadow',
                name: claim,
                reason: formatFactFaultReason({ modName: mod.name, kind: 'shadow', name: claim }),
            });
            return () => undefined;
        }
        // The `name` argument for a claim must match the claimed core
        // fact — registering `ctx.facts.register('mood', fn, { claims: 'inCombat' })`
        // is incoherent. The name IS the core fact when claiming.
        if (name !== claim) {
            factFaultStore.add({
                modId: mod.id,
                file: faultFile,
                kind: 'shadow',
                name,
                reason: formatFactFaultReason({
                    modName: mod.name,
                    kind: 'shadow',
                    name,
                    message: `name "${name}" does not match claim "${claim}"`,
                }),
            });
            return () => undefined;
        }
    } else {
        // No claim: the mod may not register a core fact name directly.
        // `inCombat` as a bare name without a claim is the footgun.
        if (CORE_FACT_NAME_SET.has(name)) {
            factFaultStore.add({
                modId: mod.id,
                file: faultFile,
                kind: 'shadow',
                name,
                reason: formatFactFaultReason({ modName: mod.name, kind: 'shadow', name }),
            });
            return () => undefined;
        }
    }

    // Conflict check: has another mod already claimed this core fact?
    if (claim !== undefined) {
        const existingClaimer = claims.get(claim);
        if (existingClaimer !== undefined && existingClaimer !== mod.id) {
            // Conflict. The existing claimer (earlier in loading_order,
            // because it registered first) wins. The new one is surfaced.
            const existingEntry = publishers.find((p) => p.modId === existingClaimer && p.claim === claim);
            const winnerName = existingEntry?.modName ?? existingClaimer;
            factFaultStore.add({
                modId: mod.id,
                file: faultFile,
                kind: 'conflict',
                name: claim,
                reason: formatFactFaultReason({
                    modName: mod.name,
                    kind: 'conflict',
                    name: claim,
                    winner: winnerName,
                }),
            });
            return () => undefined;
        }
    }

    // Duplicate-id check within the mod. Name both — do not silently
    // first-win. A re-registration with the same name overwrites the
    // publisher (the mod is replacing it) but the fault is surfaced.
    const modMap = byMod.get(mod.id);
    if (modMap !== undefined && modMap.has(name)) {
        factFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'duplicate',
            name,
            reason: formatFactFaultReason({ modName: mod.name, kind: 'duplicate', name }),
        });
        // Remove the old entry from the flat array before overwriting.
        removeFromFlatArray(mod.id, name);
    }

    const record: RegisteredPublisher = {
        modId: mod.id,
        modName: mod.name,
        loadIndex,
        bareName: name,
        claim,
        publisher,
    };

    if (modMap === undefined) {
        const fresh = new Map<string, RegisteredPublisher>();
        fresh.set(name, record);
        byMod.set(mod.id, fresh);
    } else {
        modMap.set(name, record);
    }

    publishers.push(record);

    if (claim !== undefined) {
        claims.set(claim, mod.id);
    }

    let removed = false;
    return () => {
        if (removed) return;
        removed = true;
        unregisterModFact(mod.id, name);
    };
}

/**
 * Phase 5.4 §3 — run every registered publisher for this turn.
 *
 * Publishers run in resolved `loading_order` (the loader's resolved
 * order), ties broken on mod id ascending — the same discipline
 * interceptors and mounts use. A throwing publisher is contained: the
 * fact yields no value (no match) plus a surfaced fault. The turn never
 * breaks.
 *
 * Returns `undefined` when no publishers are registered — the zero-mod
 * path, which means `payloadBuilder` merges nothing and facts behave
 * exactly as today.
 */
export function runFactPublishers(): FactPublicationResult | undefined {
    if (publishers.length === 0) return undefined;

    // Sort a copy by (loadIndex, modId) — the flat array is insertion-
    // ordered, so a sort here is cheap and cannot go stale mid-run.
    const ordered = [...publishers].sort((a, b) =>
        a.loadIndex !== b.loadIndex ? a.loadIndex - b.loadIndex : a.modId.localeCompare(b.modId));

    const facts: Partial<ModFacts> = {};
    const conflicts: { name: string; winner: string; loser: string }[] = [];

    for (const entry of ordered) {
        // A mod disabled mid-run does not get to publish.
        if (revokedMods.has(entry.modId)) {
            factFaultStore.add({
                modId: entry.modId,
                file: `mod:${entry.modId}`,
                kind: 'revoked',
                name: entry.bareName,
                reason: formatFactFaultReason({ modName: entry.modName, kind: 'revoked', name: entry.bareName }),
            });
            continue;
        }

        let value: unknown;
        try {
            value = entry.publisher();
        } catch (error) {
            factFaultStore.add({
                modId: entry.modId,
                file: `mod:${entry.modId}`,
                kind: 'threw',
                name: entry.bareName,
                reason: formatFactFaultReason({
                    modName: entry.modName,
                    kind: 'threw',
                    name: entry.bareName,
                    message: error instanceof Error ? error.message : String(error),
                }),
            });
            // A throwing publisher yields no fact — no match.
            continue;
        }

        // Only claimed core facts are merged into the overlay. Namespaced
        // mod facts (`mod.<modId>.<name>`) are not read by `evaluateWhen`
        // today — they are available for future expansion.
        if (entry.claim !== undefined) {
            // Type-check the value against the core fact's expected type.
            // An ill-typed value is a fault and yields no fact.
            if (!isValidFactValue(entry.claim, value)) {
                factFaultStore.add({
                    modId: entry.modId,
                    file: `mod:${entry.modId}`,
                    kind: 'threw',
                    name: entry.claim,
                    reason: formatFactFaultReason({
                        modName: entry.modName,
                        kind: 'threw',
                        name: entry.claim,
                        message: `published ${typeof value} for "${entry.claim}" (expected ${factTypeDescription(entry.claim)})`,
                    }),
                });
                continue;
            }
            (facts as Record<string, unknown>)[entry.claim] = value;
        }
    }

    // Surface any known conflicts (the loser was already faulted at
    // registration time; this collects them for the result).
    // The conflicts list is derived from the fault store so it stays in
    // sync — the registry rejected the losing registration, so the only
    // record of the conflict is the fault.
    const conflictRecords = factFaultStore.getRecords().filter((r) => r.kind === 'conflict');
    for (const r of conflictRecords) {
        if (r.name) {
            const winnerId = claims.get(r.name);
            const winnerEntry = winnerId ? publishers.find((p) => p.modId === winnerId && p.claim === r.name) : undefined;
            conflicts.push({
                name: r.name,
                winner: winnerEntry?.modName ?? winnerId ?? 'unknown',
                loser: r.modId,
            });
        }
    }

    return { facts, conflicts };
}

/** Check the published value matches the core fact's expected type. */
function isValidFactValue(factName: string, value: unknown): boolean {
    if (value === undefined) return true; // "no opinion this turn" is valid
    switch (factName) {
        case 'inCombat':
            return typeof value === 'boolean';
        case 'location':
            return typeof value === 'string';
        case 'sceneTags':
        case 'onStageNpcNames':
            return Array.isArray(value) && value.every((v) => typeof v === 'string');
        default:
            return true;
    }
}

/** Human-readable type description for fault messages. */
function factTypeDescription(factName: string): string {
    switch (factName) {
        case 'inCombat': return 'boolean';
        case 'location': return 'string';
        case 'sceneTags':
        case 'onStageNpcNames': return 'string[]';
        default: return 'unknown';
    }
}

/**
 * Whether any mod has registered a fact publisher.
 *
 * The turn path calls this BEFORE awaiting anything, so a zero-publisher
 * app pays not even a microtask — the same discipline `hasPromptInterceptors`
 * uses.
 */
export function hasFactPublishers(): boolean {
    return publishers.length > 0;
}

/** The registered bare names for a mod, in insertion order. Diagnostics and tests. */
export function listModFacts(modId: string): readonly string[] {
    const modMap = byMod.get(modId);
    return modMap ? [...modMap.keys()] : [];
}

/** Test helper: whether a mod has claimed a core fact. */
export function hasFactClaim(modId: string, factName: string): boolean {
    return claims.get(factName) === modId;
}

/** Test helper: whether a mod's lease is revoked. */
export function isModFactsRevoked(modId: string): boolean {
    return revokedMods.has(modId);
}

/**
 * Phase 5.4 §3 — host-owned teardown. `disable` removes every publisher
 * the mod registered, at the same call site that already disposes
 * subscriptions, event listeners, mounts, macros and interceptors. The
 * mod is never trusted to call `unregister()`.
 *
 * Clears the mod's fault record too, so a re-enable starts clean.
 */
export function disableModFacts(modId: string): number {
    revokedMods.add(modId);
    const modMap = byMod.get(modId);
    if (modMap === undefined) {
        factFaultStore.clearMod(modId);
        return 0;
    }
    let removed = 0;
    for (const name of [...modMap.keys()]) {
        const record = modMap.get(name);
        if (record?.claim !== undefined && claims.get(record.claim) === modId) {
            claims.delete(record.claim);
        }
        removed++;
    }
    // Remove all of this mod's entries from the flat array.
    for (let i = publishers.length - 1; i >= 0; i--) {
        if (publishers[i].modId === modId) {
            publishers.splice(i, 1);
        }
    }
    byMod.delete(modId);
    factFaultStore.clearMod(modId);
    return removed;
}

/**
 * Allow a mod to register again after a re-enable. Mirrors
 * `enableModMacros` / `enableModInterceptors`.
 */
export function enableModFacts(modId: string): void {
    revokedMods.delete(modId);
}

/**
 * `lifecycleHost.reset()` — clear ALL fact publishers. Test/teardown only.
 */
export function clearAllModFacts(): void {
    byMod.clear();
    publishers.length = 0;
    claims.clear();
    revokedMods.clear();
    factFaultStore.clear();
}

/**
 * Phase 5.4 §2.1 — build the `ctx.facts` API for one mod. The returned
 * object is frozen; a mod cannot reassign its methods. Mirrors
 * `buildModMacrosApi` (Phase 5.1).
 */
export function buildModFactsApi(mod: FactRegistryMod, options: { faultFile?: string } = {}): ModFactsApi {
    const faultFile = options.faultFile ?? `mod:${mod.id}`;
    return Object.freeze({
        register: (name: string, publisher: FactPublisher, opts?: { claims?: string }): () => void =>
            registerModFact(mod, name, publisher, { faultFile, claims: opts?.claims }),
    });
}

/**
 * Re-export the fault kinds for tests that want to assert on them.
 */
export type { FactFaultKind } from './factTypes';