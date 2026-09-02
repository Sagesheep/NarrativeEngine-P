import type { ValidatedMod } from './modTypes';
import { runSandbox, type SandboxHostOptions } from './sandbox/sandboxHost';
import {
    classifySandboxFault,
    sandboxFaultPolicy,
    type SandboxFaultPolicy,
} from './sandbox/sandboxFaults';
import { SANDBOX_DEADLINE_MS } from './sandbox/sandboxTypes';
import type { PostTurnTrack, PostTurnTrackContext } from '../turn/tracks/types';

export interface ComputeTrackOptions {
    /** Injectable Worker seam for tests; production uses the browser Worker factory. */
    sandboxOptions?: SandboxHostOptions;
    /** Injectable fault policy for unit tests; production uses the reload-scoped singleton. */
    sandboxPolicy?: SandboxFaultPolicy;
}

export function computeTrackId(modId: string): string {
    return 'mod.' + modId + '.compute';
}

/** Adapt one validated compute mod to the opaque post-turn track contract. */
export function modToComputeTrack(
    mod: ValidatedMod,
    options: ComputeTrackOptions = {},
): PostTurnTrack<PostTurnTrackContext> {
    if (!mod.compute || typeof mod.computeSource !== 'string') {
        throw new Error('[mods] compute track requires source for mod: ' + mod.id);
    }

    const { compute, computeSource } = mod;
    const policy = options.sandboxPolicy ?? sandboxFaultPolicy;
    return {
        id: computeTrackId(mod.id),
        name: mod.name + ' compute',
        description: 'Runs ' + mod.name + "'s postTurn compute hook in a browser Worker.",
        defaultEnabled: true,
        trigger: 'automatic',
        callsModel: compute.capabilities.some((capability) => capability.startsWith('model:')),
        shouldRun: (ctx) => Boolean(ctx.facade) && policy.canRun(mod.id, ctx.allMsgs),
        run: async (ctx) => {
            if (!ctx.facade) throw new Error('[sandbox] no host facade for compute mod: ' + mod.id);
            if (!policy.canRun(mod.id, ctx.allMsgs)) return;

            // Phase 4.0 / `API.md` §8.6 item 1 — build a `ModContext` per mod
            // and marshal *that* across the worker boundary, not the raw
            // `FacadeData`. The mod's identity is in scope here (`mod.id`,
            // `mod.name`, `mod.version`, `mod.folder`); `commitPoint` is
            // `'on-return'` for sandboxed compute (the journal applies
            // atomically on clean return). The bare-name own-table alias is
            // resolved by the host (`sandboxHost.ts`) using `mod.id`.
            //
            // `locationState` is read through `TurnCallbacks.getFreshLocationState()`
            // when the post-turn track context carries callbacks; without it,
            // `data.location.ledger` is `[]` (`API.md` §4.2). The track context
            // passes `callbacks` lazily — it may be undefined on the crash-
            // recovery path, where there is no live turn to read location from.
            const freshLocation = ctx.callbacks?.getFreshLocationState?.();
            const locationState = freshLocation && freshLocation.activeCampaignId
                ? {
                    currentPlaceId: freshLocation.context.currentPlaceId ?? null,
                    currentFeature: freshLocation.context.currentFeature ?? null,
                    ledger: freshLocation.locationLedger ?? [],
                    // WO 6.2 — carry the journey state through so native and
                    // sandbox mods see the same `data.location` shape.
                    travel: freshLocation.context.travel ?? null,
                    worldDay: freshLocation.context.worldDay,
                }
                : undefined;
            try {
                await runSandbox(computeSource, ctx.facade, compute.capabilities, {
                    ...options.sandboxOptions,
                    mod: { id: mod.id, name: mod.name, version: mod.version, folder: mod.folder },
                    locationState,
                });
                policy.recordSuccess(mod.id, ctx.allMsgs);
            } catch (error) {
                if (error instanceof Error && error.message === '[sandbox] run aborted') throw error;
                const kind = classifySandboxFault(error);
                policy.recordFault({
                    modId: mod.id,
                    modName: mod.name,
                    file: mod.file,
                    kind,
                    message: error instanceof Error ? error.message : String(error),
                    deadlineMs: options.sandboxOptions?.deadlineMs ?? SANDBOX_DEADLINE_MS,
                    turnKey: ctx.allMsgs,
                });
                throw error;
            }
        },
    };
}

export const createComputeTrack = modToComputeTrack;

