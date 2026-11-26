import type { AppSettings } from '../../../types';
import { createPostTurnTrackRegistry, enablementFromSettings, type StartTracksOptions } from './runner';
import type { PostTurnTrackContext } from './types';
import { npcTrack } from './npcTrack';
import { pressureTrack } from './pressureTrack';

/**
 * Project 2 / WO-P2-03 — the built-in post-turn track registry.
 *
 * This file is the ONLY place that knows which tracks exist. Adding a track is a new file
 * next to this one plus one `register` line here; `postTurnPipeline.ts` never changes again.
 *
 * ── Registration order is behaviour, not style ──────────────────────────────────────────
 * The order below is the order these ran as inline `Promise.allSettled` elements before the
 * migration, and `runner.start` preserves it. Reordering these lines reorders the
 * synchronous prefix of every track. Do not sort them.
 *
 * `runArchiveTrack` and `runCombinedSeal` are deliberately NOT here. They are the durable
 * archive-commit path — not optional scans — and the pipeline consumes the archive track's
 * boolean verdict directly. The modularity gain does not justify the data-loss risk, so they
 * stay inline in `postTurnPipeline.ts` (WO-P2-03 scope note).
 *
 * Phase 8.3 — the `track.enemy-suggestion` track is gone. The enemy subsystem's
 * post-turn discovery scan left core with the rest of the enemy logic in Phase
 * 8.3; the enemies mod (8.5) ships its own discovery scan through `postTurn`
 * and `model:auxiliary` capabilities, which the loader already whitelists
 * (`mod.arc.compute` proves the path). No in-tree track; the mod IS the track.
 */
export const postTurnTracks = createPostTurnTrackRegistry<PostTurnTrackContext>();

postTurnTracks.register(npcTrack);
postTurnTracks.register(pressureTrack);
// WO-P5-12 §7 Step 3 — the Arc Engine tick is now an installed compute mod
// (`mods/arc.mod.json` + `mods/arc.compute.js`). `modBootstrap.ts` registers
// `mod.arc.compute` when the mod is installed, and unregisters it when the
// mod is removed. No in-tree arc track; the mod IS the track. This is the
// COMPUTE gate: delete `mods/arc.mod.json` and `mods/arc.compute.js` and the
// app runs without Arc — no orphan, no fault (Step 4 proves it).

/**
 * Start every enabled track, in registration order, and hand the in-flight promises back to
 * the caller to settle alongside the archive track. See `runner.ts` for the concurrency
 * contract — this does not await, and neither should it.
 */
export function startPostTurnTracks(
    ctx: PostTurnTrackContext,
    settings: Pick<AppSettings, 'moduleEnabled'> | undefined,
    options?: Omit<StartTracksOptions, 'isEnabled'>,
): Promise<void>[] {
    return postTurnTracks.start(ctx, {
        isEnabled: enablementFromSettings(settings),
        onFault: options?.onFault ?? ((fault) =>
            console.warn(`[PostTurn] Track ${fault.trackId} shouldRun failed:`, fault.error)),
    });
}

export type { PostTurnTrack, PostTurnTrackContext } from './types';
export type { PostTurnTrackFault, StartTracksOptions } from './runner';
export { createPostTurnTrackRegistry, enablementFromSettings } from './runner';
