import type { ValidatedMod } from './modTypes';
import { runSandbox, type SandboxHostOptions } from './sandbox/sandboxHost';
import type { PostTurnTrack, PostTurnTrackContext } from '../turn/tracks/types';

export interface ComputeTrackOptions {
    /** Injectable Worker seam for tests; production uses the browser Worker factory. */
    sandboxOptions?: SandboxHostOptions;
}

export function computeTrackId(modId: string): string {
    return `mod.${modId}.compute`;
}

/** Adapt one validated compute mod to the opaque post-turn track contract. */
export function modToComputeTrack(
    mod: ValidatedMod,
    options: ComputeTrackOptions = {},
): PostTurnTrack<PostTurnTrackContext> {
    if (!mod.compute || typeof mod.computeSource !== 'string') {
        throw new Error(`[mods] compute track requires source for mod: ${mod.id}`);
    }

    const { compute, computeSource } = mod;
    return {
        id: computeTrackId(mod.id),
        name: `${mod.name} compute`,
        description: `Runs ${mod.name}'s postTurn compute hook in a browser Worker.`,
        defaultEnabled: true,
        trigger: 'automatic',
        callsModel: false,
        shouldRun: (ctx) => Boolean(ctx.facade),
        run: async (ctx) => {
            if (!ctx.facade) throw new Error(`[sandbox] no host facade for compute mod: ${mod.id}`);
            await runSandbox(computeSource, ctx.facade, compute.capabilities, options.sandboxOptions);
        },
    };
}

export const createComputeTrack = modToComputeTrack;

