/**
 * Phase 8.3 — the mod-facing OOC section registry.
 *
 * Mirrors `macroRegistry.ts` (Phase 5.1): a per-mod API over the open
 * `oocSections` registry (`sections.ts`) so a mod can register Ask-GM
 * sections through `ctx.oocSections.register(...)` with host-owned
 * namespacing and host-owned teardown on `disable`.
 *
 * **Why this exists (Phase 8.3 D2).** When the enemy subsystem leaves
 * core, its Ask-GM sections leave with it. The OOC brief is a SECOND
 * prompt-assembly path the contribution registry never reached, and
 * Phase 7.5's `oocSections` registry was always going to need a
 * mod-facing wrapper the day a subsystem that owns sections leaves.
 * That day is 8.3, and this module is that wrapper.
 *
 * Design notes, carried from the macro registry:
 *
 *   • **Namespacing.** A mod's section id is qualified to
 *     `mod.<modId>.<id>` exactly like macros and contributions. A mod
 *     may not register the bare id `'enemy'` and shadow a built-in —
 *     the host rewrites it to `mod.<modId>.enemy`, so two mods and a
 *     built-in can all coexist without collision.
 *   • **Native-tier only.** Registration needs a closure (the `build`
 *     function); a closure needs a module; a module is `native.js`.
 *     The sandbox binding does not construct a `ModOocSectionsApi`
 *     and a call from sandbox code is a `TypeError`, the same shape
 *     `ctx.macros`/`ctx.facts`/`ctx.mounts` take.
 *   • **Never throws.** Shadow / duplicate / revoked / bad-args
 *     registration records a fault and returns a no-op `unregister`.
 *     A throwing `build` is already contained by `oocSections.collect`
 *     (`sections.ts`); this registry adds the mod-attribution layer.
 *   • **Teardown is host-owned.** `disableModOocSections` removes
 *     every section the mod registered, at the same call site that
 *     already disposes subscriptions, event listeners, mounts, macros,
 *     interceptors, facts and budget claims.
 */
import type { ModFault } from '../mods/modTypes';
import { oocSections, type OocSection } from './sections';

/** The id prefix that marks a mod-owned OOC section. */
const MOD_PREFIX = 'mod.';

/** The qualified id for a mod-owned OOC section: `mod.<modId>.<id>`. */
export function qualifyOocSectionId(modId: string, id: string): string {
    return `${MOD_PREFIX}${modId}.${id}`;
}

/** A narrow mod view the registry needs to attribute a registration. */
export interface OocSectionRegistryMod {
    readonly id: string;
    readonly name: string;
}

/** Phase 8.3 — OOC section fault kinds, in the shape the other registries use. */
export type OocSectionFaultKind = 'duplicate' | 'bad-args' | 'revoked';

export interface OocSectionFaultRecord extends ModFault {
    readonly modId: string;
    readonly kind: OocSectionFaultKind;
    /** The section id, qualified or bare. Absent for `revoked`. */
    readonly id?: string;
}

export interface OocSectionFaultStore {
    add(record: OocSectionFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly OocSectionFaultRecord[];
    subscribe(listener: () => void): () => void;
    /** Remove every record for one mod — called on disable so a re-enable starts clean. */
    clearMod(modId: string): void;
    clear(): void;
}

export function createOocSectionFaultStore(): OocSectionFaultStore {
    const records = new Map<string, OocSectionFaultRecord>();
    const listeners = new Set<() => void>();
    const notify = (): void => {
        for (const listener of [...listeners]) {
            try { listener(); } catch { /* diagnostics must not break a turn */ }
        }
    };
    return {
        add(record) {
            records.set(record.modId, { ...record });
            notify();
        },
        getFaults() {
            return [...records.values()].map(({ file, reason }) => ({ file, reason }));
        },
        getRecords() {
            return [...records.values()].map((record) => ({ ...record }));
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        clearMod(modId) {
            if (records.delete(modId)) notify();
        },
        clear() {
            records.clear();
            notify();
        },
    };
}

export const oocSectionFaultStore = createOocSectionFaultStore();

export function formatOocSectionFaultReason(input: {
    readonly modName: string;
    readonly kind: OocSectionFaultKind;
    readonly id?: string;
    readonly message?: string;
}): string {
    const where = `${input.modName}: ooc section`;
    const named = input.id ? ` "${input.id}"` : '';
    switch (input.kind) {
        case 'duplicate':
            return `${where}${named} registered the same id twice`;
        case 'bad-args':
            return `${where}${named} invalid (${input.message ?? 'bad args'})`;
        case 'revoked':
            return `${input.modName}: ooc section registration attempted after disable${named}`;
    }
}

/** Per-mod maps of bare id → registered section. Keyed by mod id, then bare id. */
const byMod = new Map<string, Map<string, { qualifiedId: string; section: OocSection }>>();

/** The set of mods whose lease has been revoked (disabled). */
const revokedMods = new Set<string>();

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isOocSection(value: unknown): value is OocSection {
    return typeof value === 'object' && value !== null
        && typeof (value as { id?: unknown }).id === 'string'
        && typeof (value as { order?: unknown }).order === 'number'
        && typeof (value as { build?: unknown }).build === 'function';
}

/**
 * Phase 8.3 — register a mod's OOC section. The host qualifies the id to
 * `mod.<modId>.<id>`, so two mods cannot collide and a mod cannot shadow
 * a built-in section id. The `section.id` field is rewritten before it
 * reaches the open registry, so the mod authors its section with a bare
 * id and the host owns the namespace.
 *
 * Never throws: a duplicate / bad-args / revoked registration records a
 * fault and returns a no-op `unregister`. Throwing inside `activate`
 * would count a strike against the mod and latch its hooks off after
 * three (`lifecycleHost.ts`), the same posture mounts/macros take.
 */
export function registerModOocSection(
    mod: OocSectionRegistryMod,
    section: OocSection,
    options: { faultFile?: string } = {},
): () => void {
    const faultFile = options.faultFile ?? `mod:${mod.id}`;
    const bareId = section?.id;

    if (revokedMods.has(mod.id)) {
        oocSectionFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'revoked',
            id: isNonEmptyString(bareId) ? bareId : undefined,
            reason: formatOocSectionFaultReason({ modName: mod.name, kind: 'revoked', id: isNonEmptyString(bareId) ? bareId : undefined }),
        });
        return () => undefined;
    }

    if (!isNonEmptyString(bareId) || !isOocSection(section)) {
        oocSectionFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'bad-args',
            id: isNonEmptyString(bareId) ? bareId : undefined,
            reason: formatOocSectionFaultReason({ modName: mod.name, kind: 'bad-args', id: isNonEmptyString(bareId) ? bareId : undefined, message: 'invalid section' }),
        });
        return () => undefined;
    }

    const qualifiedId = qualifyOocSectionId(mod.id, bareId);
    let modMap = byMod.get(mod.id);
    if (!modMap) {
        modMap = new Map();
        byMod.set(mod.id, modMap);
    }

    if (modMap.has(bareId) || oocSections.get(qualifiedId) !== undefined) {
        oocSectionFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'duplicate',
            id: bareId,
            reason: formatOocSectionFaultReason({ modName: mod.name, kind: 'duplicate', id: bareId }),
        });
        return () => undefined;
    }

    // Rewrite the id to the qualified form before registering with the open
    // registry, so the open registry's duplicate check is on the namespaced
    // id and a built-in id (`'enemy'`) can never collide with a mod's
    // bare id of the same spelling.
    const namespacedSection: OocSection = { ...section, id: qualifiedId };
    oocSections.register(namespacedSection);
    modMap.set(bareId, { qualifiedId, section: namespacedSection });

    return () => unregisterModOocSection(mod.id, bareId);
}

/** Remove one section. Called by the returned `unregister()` and by `disableModOocSections`. */
export function unregisterModOocSection(modId: string, bareId: string): void {
    const modMap = byMod.get(modId);
    if (modMap === undefined) return;
    const entry = modMap.get(bareId);
    if (entry === undefined) return;
    oocSections.unregister(entry.qualifiedId);
    modMap.delete(bareId);
    if (modMap.size === 0) byMod.delete(modId);
}

/** The registered section ids for a mod, in registration order. Diagnostics and tests. */
export function listModOocSections(modId: string): readonly string[] {
    const modMap = byMod.get(modId);
    if (modMap === undefined) return [];
    return [...modMap.values()].map((entry) => entry.qualifiedId);
}

/** Phase 8.3 — host-owned teardown. `disable` removes every section the mod registered. */
export function disableModOocSections(modId: string): void {
    revokedMods.add(modId);
    const modMap = byMod.get(modId);
    if (modMap === undefined) return;
    for (const bareId of [...modMap.keys()]) {
        unregisterModOocSection(modId, bareId);
    }
    oocSectionFaultStore.clearMod(modId);
}

/** Allow a mod to register again after a re-enable. Mirrors `enableModMacros`. */
export function enableModOocSections(modId: string): void {
    revokedMods.delete(modId);
}

/** `lifecycleHost.reset()` — clear ALL mod sections. Test/teardown only. */
export function clearAllModOocSections(): void {
    for (const modId of [...byMod.keys()]) {
        const modMap = byMod.get(modId);
        if (modMap === undefined) continue;
        for (const bareId of [...modMap.keys()]) {
            unregisterModOocSection(modId, bareId);
        }
    }
    byMod.clear();
    revokedMods.clear();
    oocSectionFaultStore.clear();
}

/** Test helper: whether a mod's lease is revoked. */
export function isModOocSectionsRevoked(modId: string): boolean {
    return revokedMods.has(modId);
}

/**
 * Phase 8.3 — the per-mod `ctx.oocSections` API. One method (`register`),
 * per-mod so the host owns the qualification (`mod.<modId>.<id>`) and the
 * teardown on `disable`. Native-tier only: registration needs a closure
 * (the `build` function), a closure needs a module, and a module is
 * `native.js` — same ruling mounts/macros/events/interceptors/facts/
 * budgets made. The returned object is frozen; a mod cannot reassign
 * its method. A faulted registration returns a no-op `unregister`.
 */
export interface ModOocSectionsApi {
    /**
     * Register an Ask-GM section. The id is qualified to
     * `mod.<modId>.<id>` by the host, so two mods cannot collide and a
     * mod cannot shadow a built-in section. The `section.id` the mod
     * authors is rewritten before it reaches the open registry; a mod
     * passes a bare id and the host owns the namespace.
     *
     * Never throws: a duplicate / bad-args / revoked registration
     * records a fault and returns a no-op `unregister`.
     */
    register(section: OocSection): () => void;
}

export interface ModOocSectionsApiOptions {
    readonly mod: OocSectionRegistryMod;
    /** The fault-store file label. Default `mod:<id>`. */
    readonly faultFile?: string;
}

export function buildModOocSectionsApi(options: ModOocSectionsApiOptions): ModOocSectionsApi {
    const { mod, faultFile } = options;
    return Object.freeze({
        register(section: OocSection): () => void {
            return registerModOocSection(mod, section, { faultFile });
        },
    });
}