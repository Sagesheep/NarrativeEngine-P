import { fetchMods } from './modClient';
import { modToContributionModule } from './modAdapter';
import type { ModFault, ValidatedMod } from './modTypes';
import { setExtensionModules } from '../payload/contributions/extensions';

/**
 * Project 2 — loads installed mods and registers them as contribution modules.
 *
 * This is the only place the mod layer meets the payload layer, and it pushes rather than pulls
 * (see `contributions/extensions.ts`). Call `refreshMods()` at app start and again whenever the
 * user installs, edits, or removes a mod file — the server reads disk per request, so no restart
 * is needed on either side.
 */

let lastResult: { mods: readonly ValidatedMod[]; faults: readonly ModFault[] } = {
    mods: [],
    faults: [],
};

/**
 * Fetch the installed mods and register them.
 *
 * NEVER THROWS. A failure to reach the server, or a malformed response, leaves the previously
 * registered modules in place and is reported as a fault — an unreachable mods endpoint must not
 * be able to stop the app from running turns.
 */
export async function refreshMods(): Promise<{
    mods: readonly ValidatedMod[];
    faults: readonly ModFault[];
}> {
    try {
        const { mods, faults } = await fetchMods();
        setExtensionModules(mods.map(modToContributionModule));
        lastResult = { mods, faults };
    } catch (error) {
        lastResult = {
            mods: lastResult.mods,
            faults: [
                ...lastResult.faults.filter((f) => f.file !== '<loader>'),
                {
                    file: '<loader>',
                    reason: `Could not load mods: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
    return lastResult;
}

/** The last known load result, without re-fetching. For the extensions screen. */
export function getLastModLoad(): { mods: readonly ValidatedMod[]; faults: readonly ModFault[] } {
    return lastResult;
}
