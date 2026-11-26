import { createPostTurnTrackRegistry } from '../runner';
import type { PrologueTrackContext } from '../types';
import { autoProfileTrack } from './autoProfileTrack';
import { digestClearTrack } from './digestClearTrack';

/** Stage P registry. Tracks are added by the prologue migration work order. */
export const prologueTracks = createPostTurnTrackRegistry<PrologueTrackContext>();

prologueTracks.register(autoProfileTrack);
prologueTracks.register(digestClearTrack);

export function startPrologueTracks(ctx: PrologueTrackContext): Promise<void>[] {
    return prologueTracks.start(ctx);
}

export type { PrologueTrackContext } from '../types';

