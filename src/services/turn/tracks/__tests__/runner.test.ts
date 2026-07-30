import { describe, it, expect, vi } from 'vitest';
import { createPostTurnTrackRegistry, enablementFromSettings } from '../runner';
import type { PostTurnTrack } from '../types';

/**
 * WO-P2-03 — runner semantics.
 *
 * The three properties that make this a safe replacement for the inline
 * `Promise.allSettled([...])` in `runPostTurnPipeline`:
 *   1. start order == registration order, and every track's synchronous prefix runs
 *      before any of them yields (this is what the array literal used to guarantee);
 *   2. a throwing track is contained — siblings still start, the caller still settles;
 *   3. the runner never branches on WHICH track it holds (opaque-id test).
 */

type Ctx = { log: string[] };

function track(id: string, over: Partial<PostTurnTrack<Ctx>> = {}): PostTurnTrack<Ctx> {
    return {
        id,
        name: id,
        description: id,
        defaultEnabled: true,
        shouldRun: () => true,
        run: async (ctx) => { ctx.log.push(`run:${id}`); },
        ...over,
    };
}

describe('createPostTurnTrackRegistry — registration', () => {
    it('lists tracks in registration order', () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        reg.register(track('b'));
        reg.register(track('c'));
        expect(reg.list().map(t => t.id)).toEqual(['a', 'b', 'c']);
    });

    it('throws on a duplicate id', () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        expect(() => reg.register(track('a'))).toThrow(/duplicate track id: a/);
    });

    it('unregister removes the track and reports whether it was present', () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        expect(reg.unregister('a')).toBe(true);
        expect(reg.unregister('a')).toBe(false);
        expect(reg.get('a')).toBeUndefined();
    });
});

describe('createPostTurnTrackRegistry — execution order and concurrency', () => {
    it('starts tracks in registration order', async () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        reg.register(track('b'));
        reg.register(track('c'));

        const ctx: Ctx = { log: [] };
        await Promise.allSettled(reg.start(ctx));

        expect(ctx.log).toEqual(['run:a', 'run:b', 'run:c']);
    });

    it('runs every track\'s synchronous prefix before any of them yields', async () => {
        // This is the property the inline array literal gave us: each `async function`
        // executes up to its first `await` eagerly, in order, before the first suspension.
        const reg = createPostTurnTrackRegistry<Ctx>();
        const sync = (id: string) => track(id, {
            run: async (ctx) => {
                ctx.log.push(`sync:${id}`);
                await Promise.resolve();
                ctx.log.push(`async:${id}`);
            },
        });
        reg.register(sync('a'));
        reg.register(sync('b'));
        reg.register(sync('c'));

        const ctx: Ctx = { log: [] };
        const promises = reg.start(ctx);
        // Nothing has been awaited yet — all three synchronous prefixes already ran.
        expect(ctx.log).toEqual(['sync:a', 'sync:b', 'sync:c']);

        await Promise.allSettled(promises);
        expect(ctx.log).toEqual(['sync:a', 'sync:b', 'sync:c', 'async:a', 'async:b', 'async:c']);
    });

    it('returns one promise per started track, in order', () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        reg.register(track('b', { shouldRun: () => false }));
        reg.register(track('c'));

        const started = reg.start({ log: [] });
        expect(started).toHaveLength(2);
    });

    it('does not await — start returns before any track settles', async () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        let release!: () => void;
        reg.register(track('slow', {
            run: async (ctx) => {
                await new Promise<void>(r => { release = r; });
                ctx.log.push('run:slow');
            },
        }));

        const ctx: Ctx = { log: [] };
        const started = reg.start(ctx);
        expect(ctx.log).toEqual([]);
        release();
        await Promise.allSettled(started);
        expect(ctx.log).toEqual(['run:slow']);
    });
});

describe('createPostTurnTrackRegistry — containment', () => {
    it('an async-rejecting track does not stop its siblings starting', async () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        reg.register(track('boom', { run: async () => { throw new Error('boom'); } }));
        reg.register(track('c'));

        const ctx: Ctx = { log: [] };
        const results = await Promise.allSettled(reg.start(ctx));

        expect(ctx.log).toEqual(['run:a', 'run:c']);
        expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });

    it('a SYNCHRONOUSLY throwing run is converted to a rejected promise, not propagated', async () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        // A hand-written track object may return a non-promise / throw synchronously.
        reg.register(track('boom', { run: (() => { throw new Error('sync boom'); }) as never }));
        reg.register(track('c'));

        const ctx: Ctx = { log: [] };
        // The critical assertion: `start` itself must not throw.
        const started = reg.start(ctx);
        const results = await Promise.allSettled(started);

        expect(ctx.log).toEqual(['run:a', 'run:c']);
        expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    });

    it('a throwing shouldRun is reported as a fault and skips only that track', () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        const onFault = vi.fn();
        reg.register(track('a'));
        reg.register(track('boom', { shouldRun: () => { throw new Error('nope'); } }));
        reg.register(track('c'));

        const ctx: Ctx = { log: [] };
        const started = reg.start(ctx, { onFault });

        expect(started).toHaveLength(2);
        expect(ctx.log).toEqual(['run:a', 'run:c']);
        expect(onFault).toHaveBeenCalledTimes(1);
        expect(onFault.mock.calls[0][0].trackId).toBe('boom');
        expect(onFault.mock.calls[0][0].error).toBeInstanceOf(Error);
    });
});

describe('createPostTurnTrackRegistry — enablement', () => {
    it('skips a disabled track and runs the rest', async () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        reg.register(track('b'));
        reg.register(track('c'));

        const ctx: Ctx = { log: [] };
        await Promise.allSettled(reg.start(ctx, { isEnabled: (id) => id !== 'b' }));

        expect(ctx.log).toEqual(['run:a', 'run:c']);
    });

    it('a non-toggleable track ignores the enablement predicate entirely', async () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('structural', { toggleable: false }));
        reg.register(track('optional'));

        const ctx: Ctx = { log: [] };
        await Promise.allSettled(reg.start(ctx, { isEnabled: () => false }));

        expect(ctx.log).toEqual(['run:structural']);
    });

    it('shouldRun still gates a non-toggleable track', async () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('structural', { toggleable: false, shouldRun: () => false }));

        const ctx: Ctx = { log: [] };
        await Promise.allSettled(reg.start(ctx, { isEnabled: () => false }));

        expect(ctx.log).toEqual([]);
    });

    it('every track is enabled when no predicate is supplied', async () => {
        const reg = createPostTurnTrackRegistry<Ctx>();
        reg.register(track('a'));
        reg.register(track('b'));

        const ctx: Ctx = { log: [] };
        await Promise.allSettled(reg.start(ctx));

        expect(ctx.log).toEqual(['run:a', 'run:b']);
    });
});

describe('enablementFromSettings — the moduleEnabled map', () => {
    it('an absent key means enabled (today\'s behaviour for every track)', () => {
        expect(enablementFromSettings(undefined)('track.npc')).toBe(true);
        expect(enablementFromSettings({})('track.npc')).toBe(true);
        expect(enablementFromSettings({ moduleEnabled: {} })('track.npc')).toBe(true);
    });

    it('only an explicit false disables', () => {
        expect(enablementFromSettings({ moduleEnabled: { 'track.npc': false } })('track.npc')).toBe(false);
        expect(enablementFromSettings({ moduleEnabled: { 'track.npc': true } })('track.npc')).toBe(true);
        // An unrelated key never affects another track.
        expect(enablementFromSettings({ moduleEnabled: { 'track.other': false } })('track.npc')).toBe(true);
    });
});

describe('THE NO-FEATURE-NAMES RULE — opaque-id test', () => {
    /**
     * Runs the same corpus twice: once with the real built-in ids, once with every id
     * replaced by an opaque string. If the runner ever grows `if (id === 'track.npc')`,
     * the two runs diverge and this fails.
     */
    const REAL_IDS = ['track.npc', 'track.enemy-suggestion', 'track.pressure'];
    const OPAQUE_IDS = ['x0', 'x1', 'x2'];

    function runCorpus(ids: string[], disabledIndex: number, faultIndex: number, throwIndex: number) {
        const reg = createPostTurnTrackRegistry<Ctx>();
        const faults: number[] = [];
        ids.forEach((id, i) => {
            reg.register(track(id, {
                // index 0 is structural, so the disabled predicate must not touch it
                toggleable: i === 0 ? false : undefined,
                shouldRun: i === faultIndex ? () => { throw new Error('fault'); } : () => true,
                run: i === throwIndex
                    ? async () => { throw new Error('boom'); }
                    : async (ctx) => { ctx.log.push(`run:${i}`); },
            }));
        });

        const ctx: Ctx = { log: [] };
        const started = reg.start(ctx, {
            isEnabled: (id) => id !== ids[disabledIndex],
            onFault: (f) => faults.push(ids.indexOf(f.trackId)),
        });
        return { ctx, started, faults, order: reg.list().map(t => ids.indexOf(t.id)) };
    }

    it('produces identical behaviour with real ids and with opaque ids', async () => {
        for (const disabledIndex of [0, 1, 2]) {
            for (const faultIndex of [-1, 1]) {
                for (const throwIndex of [-1, 2]) {
                    const real = runCorpus(REAL_IDS, disabledIndex, faultIndex, throwIndex);
                    const opaque = runCorpus(OPAQUE_IDS, disabledIndex, faultIndex, throwIndex);

                    const realResults = await Promise.allSettled(real.started);
                    const opaqueResults = await Promise.allSettled(opaque.started);

                    expect(opaque.order).toEqual(real.order);
                    expect(opaque.faults).toEqual(real.faults);
                    expect(opaque.ctx.log).toEqual(real.ctx.log);
                    expect(opaqueResults.map(r => r.status)).toEqual(realResults.map(r => r.status));
                }
            }
        }
    });
});
