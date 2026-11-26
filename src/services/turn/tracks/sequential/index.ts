import { createPostTurnTrackRegistry, enablementFromSettings } from '../runner';
import type { SequentialTrackContext } from '../types';
import { onStageTrack } from './onStageTrack';
import { locationHeaderTrack } from './locationHeaderTrack';
import { agencyTrack } from './agencyTrack';
import { repressionTrack } from './repressionTrack';

/** Stage B registry. Registration order is execution order. */
export const sequentialTracks = createPostTurnTrackRegistry<SequentialTrackContext>();

sequentialTracks.register(onStageTrack);
sequentialTracks.register(locationHeaderTrack);
sequentialTracks.register(agencyTrack);
sequentialTracks.register(repressionTrack);

export function startSequentialTracks(ctx: SequentialTrackContext): Promise<void>[] {
    return sequentialTracks.start(ctx, {
        isEnabled: enablementFromSettings(ctx.settings),
        onFault: (fault) => console.warn('[PostTurn] Track ' + fault.trackId + ' shouldRun failed:', fault.error),
    });
}

export type { SequentialTrackContext } from '../types';
