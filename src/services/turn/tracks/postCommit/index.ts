import type { AppSettings } from '../../../../types';
import { createPostTurnTrackRegistry, enablementFromSettings } from '../runner';
import type { PostCommitTrackContext } from '../types';
import { eventExtractionTrack } from './eventExtractionTrack';
import { chapterSealTrack } from './chapterSealTrack';
import { profileScanTrack } from './profileScanTrack';
import { traitScanTrack } from './traitScanTrack';
import { inventoryScanTrack } from './inventoryScanTrack';
import { locationScanTrack } from './locationScanTrack';
import { pcDriftTrack } from './pcDriftTrack';

/** Stage C registry. Tracks are started fire-and-forget by the archive host. */
export const postCommitTracks = createPostTurnTrackRegistry<PostCommitTrackContext>();

postCommitTracks.register(eventExtractionTrack);
postCommitTracks.register(chapterSealTrack);
postCommitTracks.register(profileScanTrack);
postCommitTracks.register(traitScanTrack);
postCommitTracks.register(inventoryScanTrack);
postCommitTracks.register(locationScanTrack);
postCommitTracks.register(pcDriftTrack);

export function startPostCommitTracks(
    ctx: PostCommitTrackContext,
    settings: Pick<AppSettings, 'moduleEnabled'> | undefined,
): Promise<void>[] {
    return postCommitTracks.start(ctx, {
        isEnabled: enablementFromSettings(settings),
        onFault: (fault) => console.warn('[PostTurn] Track ' + fault.trackId + ' shouldRun failed:', fault.error),
    });
}

export type { PostCommitTrackContext } from '../types';
