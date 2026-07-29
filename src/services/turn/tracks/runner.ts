import type { AppSettings } from '../../../types';
import type { PostTurnTrack } from './types';

/**
 * Project 2 / WO-P2-03 — the post-turn track runner.
 *
 * ┌─ THE NO-FEATURE-NAMES RULE ────────────────────────────────────────────────────────────┐
 * │ This module may know only `(id, toggleable, shouldRun, run)`. It may NEVER branch on    │
 * │ WHICH track it is holding. The moment `if (id === 'track.npc')` appears here, this file │
 * │ has become the god node the project exists to remove — the exact thing the four         │
 * │ hand-appended blocks in `postTurnPipeline.ts` had turned into.                          │
 * │                                                                                         │
 * │ Enforced, not merely asked for: `runner.test.ts` runs the same corpus twice — once with │
 * │ real ids and once with every id replaced by an opaque string — and asserts identical    │
 * │ execution order, identical skips, and identical containment.                            │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ── Concurrency contract (this is the load-bearing part) ────────────────────────────────
 * `start()` is NOT `await`ed and does NOT await anything itself. It walks its tracks in
 * registration order and *starts* each one, returning the in-flight promises in that same
 * order. That reproduces exactly what `runPostTurnPipeline` did when the tracks were inline
 * array elements of one `Promise.allSettled([...])`:
 *
 *   - each track's synchronous prefix (everything before its first `await`) runs eagerly,
 *     in registration order, before any of them yields;
 *   - the tracks then run concurrently;
 *   - the caller settles them together, so one rejecting can never abort a sibling.
 *
 * The caller MUST feed the returned promises into a `Promise.allSettled` (or equivalent).
 * A returned promise that nobody settles is an unhandled rejection waiting to happen.
 */

/** A track that threw from `shouldRun`. Surfaced so the UI can fail it safe with a reason. */
export interface PostTurnTrackFault {
    trackId: string;
    error: Error;
}

export interface StartTracksOptions {
    /**
     * Enablement predicate. Defaults to "every registered track is enabled". Wiring this to
     * persisted settings is the caller's job (see `enablementFromSettings`); the runner stays
     * storage-agnostic, exactly like `createContributionRegistry`.
     */
    isEnabled?: (trackId: string) => boolean;
    /** Called for each track whose `shouldRun` threw. The track is skipped; the turn continues. */
    onFault?: (fault: PostTurnTrackFault) => void;
}

export interface PostTurnTrackRegistry<Ctx> {
    /** Register a track. Throws on duplicate id — that is always a programming/packaging bug. */
    register(track: PostTurnTrack<Ctx>): void;
    /** Remove a track. Returns whether it was present. */
    unregister(trackId: string): boolean;
    /** All registered tracks, in registration order. For the extensions UI. */
    list(): readonly PostTurnTrack<Ctx>[];
    get(trackId: string): PostTurnTrack<Ctx> | undefined;
    /**
     * Start every enabled track whose `shouldRun` says yes, in registration order, and return
     * the in-flight promises in that order. See the concurrency contract above.
     */
    start(ctx: Ctx, options?: StartTracksOptions): Promise<void>[];
    /** Drop all tracks. Test/teardown only. */
    clear(): void;
}

/**
 * The enablement predicate the extensions screen drives, read off the same `moduleEnabled`
 * map the prompt-contribution registry uses (`payloadBuilder.ts:243`). An absent key means
 * enabled, so an empty or missing map is today's behaviour for every track.
 */
export function enablementFromSettings(
    settings: Pick<AppSettings, 'moduleEnabled'> | undefined,
): (trackId: string) => boolean {
    return (trackId: string) => settings?.moduleEnabled?.[trackId] !== false;
}

export function createPostTurnTrackRegistry<Ctx>(): PostTurnTrackRegistry<Ctx> {
    const tracks = new Map<string, PostTurnTrack<Ctx>>();

    return {
        register(track) {
            if (tracks.has(track.id)) {
                throw new Error(`[post-turn tracks] duplicate track id: ${track.id}`);
            }
            tracks.set(track.id, track);
        },

        unregister(trackId) {
            return tracks.delete(trackId);
        },

        list() {
            return [...tracks.values()];
        },

        get(trackId) {
            return tracks.get(trackId);
        },

        start(ctx, options) {
            const isEnabled = options?.isEnabled ?? (() => true);
            const started: Promise<void>[] = [];

            for (const track of tracks.values()) {
                // Structural tracks bypass the predicate entirely — see `toggleable`.
                if (track.toggleable !== false && !isEnabled(track.id)) continue;

                let wanted: boolean;
                try {
                    wanted = track.shouldRun(ctx);
                } catch (error) {
                    // Fail safe: a bad pre-check must never take down the turn or a sibling.
                    options?.onFault?.({
                        trackId: track.id,
                        error: error instanceof Error ? error : new Error(String(error)),
                    });
                    continue;
                }
                if (!wanted) continue;

                try {
                    started.push(track.run(ctx));
                } catch (error) {
                    // `run` is declared async, so this can only fire if a track is implemented
                    // as a sync-throwing function. Converting the throw into a rejected promise
                    // keeps the loop going (the next track still starts) and lets the caller's
                    // `allSettled` report it through the same path as an async rejection.
                    started.push(Promise.reject(error));
                }
            }

            return started;
        },

        clear() {
            tracks.clear();
        },
    };
}
