// Hydration iteration helper — Project 5 / WO-P5-03 Step 3.2.
//
// The campaign hydrator's `Promise.all` fan-out (campaignHydrator.ts:177)
// stays as-is for now: nothing is registered, so iterating descriptors yields
// nothing and the existing 14 hand-written loads are byte-identical.
//
// This helper exists so WO-P5-04 can swap a hand-written load for a
// descriptor-driven one without touching the hydrator's orchestration. It
// returns the list of loaders a registry declares, ready to spread into the
// `Promise.all`. The hydrator keeps owning the migration order
// (migrateLegacyContext, migratePCIntoContext, rebuildSceneStamps) — those
// consume loaded data sequentially and are NOT a table concern.

import type { TableDescriptor } from '@narrative/engine';

export interface HydratorEntry {
    name: string;
    load: (campaignId: string) => Promise<unknown>;
}

/**
 * Collects the declared hydrators from a registry, in registration order.
 * Only descriptors that declare `hydrator` (present) contribute. With no
 * descriptors this is the empty list — the hydrator's existing fan-out is
 * unchanged.
 *
 * The registry type comes from @narrative/engine (pure). The client passes
 * its own registry instance; this helper is a pure projection over it.
 */
export function collectHydrators(
    registry: { list(): readonly TableDescriptor[] },
): HydratorEntry[] {
    const out: HydratorEntry[] = [];
    for (const descriptor of registry.list()) {
        if (descriptor.hydrator && descriptor.hydrator.present === true) {
            out.push({ name: descriptor.name, load: descriptor.hydrator.value });
        }
    }
    return out;
}