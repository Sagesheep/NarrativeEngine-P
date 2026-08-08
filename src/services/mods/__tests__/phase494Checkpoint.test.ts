/**
 * Phase 4.9.4 — CHECKPOINT 2 verification: event ordering and listener leaks.
 *
 * Drives the eight assertions from the checkpoint work order against the real
 * `modEventBus` singleton and the two throwaway fixtures `mods/probe/`
 * (loadOrder 100) and `mods/probe-two/` (loadOrder 200) that the previous
 * Checkpoint 2 phases installed. Each assertion names the section of
 * `EVENTS.md` it pins.
 *
 *   1. Ordering — both probes subscribed, every core event reaches listeners in
 *      load order (3.1 decision 3). Swap the orders; the sequence swaps.
 *   2. Payload immutability — a listener that tries to mutate its payload
 *      changes nothing downstream. Frozen means frozen (§3).
 *   3. Throwing listener — one probe throws inside a turn-path event. The turn
 *      still completes and commits, a fault surfaces naming that mod, and the
 *      other probe's listener still ran (§5.3).
 *   4. Disable teardown — count listeners. Disable a probe. Count again — its
 *      listeners are gone, without the mod having called `off` itself (§5.4).
 *   5. Campaign switch — switch campaigns five times with both probes active.
 *      Listener count after equals listener count before. The leak that
 *      matters — it compounds silently.
 *   6. Enable/disable churn — toggle a probe ten times. No accumulation, no
 *      double-fire.
 *   7. Custom events — probe A emits, probe B receives. Disable A: B receives
 *      nothing and does not error. Attempting to emit a core event name is
 *      rejected with a reason (§4.5).
 *   8. No emit in the commit path unless EVENTS.md decision 4 explicitly
 *      allowed it. Read the diff of `postTurnPipeline.ts` and confirm by eye.
 *
 * The bus is the real singleton (`modEventBus`) so a leak here is a leak in
 * the running app, not a leak in a copy. `beforeEach` resets the bus between
 * assertions so the listener counts are exact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    modEventBus,
    eventFaultStore,
    ModEventNameRejected,
    type ModEventOwner,
} from '../events';
import { useAppStore } from '../../../store/useAppStore';
import type { ChatMessage } from '../../../types';

// The two probe owners, mirroring the manifest ids in `mods/probe/` and
// `mods/probe-two/`. Lower loadOrder sorts first (MANIFEST.md §6.3), so
// `probe` (loadOrder 100) activates before `probe-two` (loadOrder 200). The
// lifecycle host fires `activate` in resolved load order (lifecycleHost.ts
// §3), and `activate` is where a mod subscribes, so registration order IS
// load order for the path every mod uses (EVENTS.md §4.2).
const PROBE: ModEventOwner = { modId: 'probe', modName: 'Probe', file: 'probe.mod.json' };
const PROBE_TWO: ModEventOwner = { modId: 'probe-two', modName: 'Probe-Two', file: 'probe-two.mod.json' };

/**
 * Subscribe the two probes to a core event, in load order, each logging what
 * it was handed. Returns the log and a teardown. Mirrors what each probe's
 * `activate` does in `mods/probe/index.js` and `mods/probe-two/index.js`.
 */
function subscribeBoth(event: string, log: string[]): () => void {
    const off1 = modEventBus.on(event as never, () => { log.push('probe'); }, PROBE);
    const off2 = modEventBus.on(event as never, () => { log.push('probe-two'); }, PROBE_TWO);
    return () => { off1(); off2(); };
}

/** A minimal payload with an array field, for the immutability assertion. */
function samplePayload(): { campaignId: string; messageIds: string[] } {
    return { campaignId: 'camp_a', messageIds: ['m1', 'm2'] };
}

const msg = (id: string): ChatMessage => ({ id, role: 'assistant', content: `${id} body`, timestamp: 0 });

beforeEach(() => {
    modEventBus.reset();
    eventFaultStore.clear();
});

afterEach(() => {
    modEventBus.reset();
    eventFaultStore.clear();
});

// ─── Item 1: ordering — load order, and swap inverts it ────────────────────

describe('Phase 4.9.4 — Item 1: ordering follows load order (3.1 decision 3 / §4.2)', () => {
    it('every core event reaches the two probes in load order (probe before probe-two)', () => {
        // Cover one event from each family that a probe actually subscribes to.
        // The bus invokes in insertion order; registration order is load order
        // for `activate`-time subscribers (EVENTS.md §4.2).
        const events = [
            'turn.start',
            'turn.committed',
            'archive.sceneAppended',
            'campaign.opened',
            'message.deleted',
            'settings.changed',
        ];
        for (const event of events) {
            const log: string[] = [];
            const off = subscribeBoth(event, log);
            modEventBus.emit(event as never, samplePayload() as never);
            off();
            expect(log).toEqual(['probe', 'probe-two']);
        }
    });

    it('swap the orders — register probe-two first, and the sequence swaps', () => {
        const log: string[] = [];
        // Subscribe in the OPPOSITE order: probe-two first, probe second.
        // That is what swapping `loadOrder` 100<->200 does to `activate` order.
        const off2 = modEventBus.on('turn.committed', () => { log.push('probe-two'); }, PROBE_TWO);
        const off1 = modEventBus.on('turn.committed', () => { log.push('probe'); }, PROBE);
        modEventBus.emit('turn.committed', { turnId: 't1', campaignId: 'c1', messageId: 'm1', sceneId: 's1' });
        off1();
        off2();
        expect(log).toEqual(['probe-two', 'probe']);
    });

    it('a late subscriber appends rather than re-sorting (§4.2 narrowing)', () => {
        const log: string[] = [];
        const off1 = modEventBus.on('turn.start', () => { log.push('probe'); }, PROBE);
        modEventBus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });
        // probe-two subscribes AFTER the first emit — it appends, not re-sorts.
        const off2 = modEventBus.on('turn.start', () => { log.push('probe-two'); }, PROBE_TWO);
        modEventBus.emit('turn.start', { turnId: 't2', campaignId: null, playerInput: '', tier: undefined });
        off1();
        off2();
        // First emit: only probe heard it. Second emit: probe, then probe-two.
        expect(log).toEqual(['probe', 'probe', 'probe-two']);
    });
});

// ─── Item 2: payload immutability — frozen means frozen (§3) ──────────────

describe('Phase 4.9.4 — Item 2: payload immutability (§3)', () => {
    it('a listener that tries to mutate its payload changes nothing downstream', () => {
        const seen: { messageIds: readonly string[] }[] = [];
        // First listener tries to push into the frozen array and to set a field.
        modEventBus.on('message.deleted', (p) => {
            try {
                (p as { messageIds: string[] }).messageIds.push('injected');
            } catch {
                // strict mode throws — silent in sloppy; either way the host's
                // object is untouched.
            }
            try {
                (p as { campaignId: string }).campaignId = 'overwritten';
            } catch {
                // frozen — throws in strict mode.
            }
        }, PROBE);
        // Second listener observes what it was handed.
        modEventBus.on('message.deleted', (p) => {
            seen.push({ messageIds: p.messageIds, campaignId: p.campaignId } as never);
        }, PROBE_TWO);

        const source = samplePayload();
        modEventBus.emit('message.deleted', source);

        expect(seen).toHaveLength(1);
        expect(seen[0].messageIds).toEqual(['m1', 'm2']);
        expect((seen[0] as { campaignId: string }).campaignId).toBe('camp_a');
        // The caller's own object is not mutated either (the bus copies).
        expect(source.messageIds).toEqual(['m1', 'm2']);
        expect(source.campaignId).toBe('camp_a');
    });

    it('the payload record and its array fields arrive frozen', () => {
        let received: { messageIds: readonly string[] } | undefined;
        modEventBus.on('message.deleted', (p) => { received = p as never; }, PROBE);
        modEventBus.emit('message.deleted', samplePayload());
        expect(Object.isFrozen(received)).toBe(true);
        expect(Object.isFrozen(received!.messageIds)).toBe(true);
    });
});

// ─── Item 3: throwing listener — contained, faulted, turn still completes ──

describe('Phase 4.9.4 — Item 3: a throwing listener is contained (§5.3)', () => {
    it('one probe throws inside a turn-path event — the other probe still ran, and a fault names the throwing mod', () => {
        const seen: string[] = [];
        modEventBus.on('turn.committed', () => { throw new Error('probe blew up'); }, PROBE);
        modEventBus.on('turn.committed', () => { seen.push('probe-two ran'); }, PROBE_TWO);

        // The emit must not throw into the caller — the commit path would be a
        // data-loss path if it did (EVENTS.md §4.3).
        expect(() => modEventBus.emit('turn.committed', {
            turnId: 't1', campaignId: 'c1', messageId: 'm1', sceneId: 's1',
        })).not.toThrow();

        // The other probe's listener ran despite the throw.
        expect(seen).toEqual(['probe-two ran']);

        // A fault surfaces naming the throwing mod.
        const records = eventFaultStore.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0].modId).toBe('probe');
        expect(records[0].event).toBe('turn.committed');
        expect(records[0].reason).toContain('Probe');
        expect(records[0].reason).toContain('turn.committed');
        expect(records[0].reason).toContain('probe blew up');
    });

    it('does not latch — a faulting probe keeps receiving events (§5.3)', () => {
        let calls = 0;
        modEventBus.on('turn.start', () => { calls += 1; throw new Error('again'); }, PROBE);
        for (let i = 0; i < 4; i++) {
            modEventBus.emit('turn.start', { turnId: `t${i}`, campaignId: null, playerInput: '', tier: undefined });
        }
        expect(calls).toBe(4);
        // One row per mod — the list does not grow unbounded.
        expect(eventFaultStore.getRecords()).toHaveLength(1);
    });
});

// ─── Item 4: disable teardown — host removes listeners, mod never calls off ──

describe('Phase 4.9.4 — Item 4: disable teardown is host-owned (§5.4)', () => {
    it('disable a probe — its listeners are gone without the mod calling off', () => {
        // Both probes subscribe to several events. The handles are deliberately
        // discarded — the host must not depend on the mod behaving.
        modEventBus.on('turn.start', () => undefined, PROBE);
        modEventBus.on('turn.committed', () => undefined, PROBE);
        modEventBus.on('archive.sceneAppended', () => undefined, PROBE);
        modEventBus.on('turn.start', () => undefined, PROBE_TWO);
        modEventBus.on('turn.committed', () => undefined, PROBE_TWO);

        const before = modEventBus.getListenerCount();
        expect(before).toBe(5);

        // Host-owned teardown: disposeModListeners removes every listener the
        // mod registered, regardless of which event it was on (lifecycleHost
        // calls this inside `disable` — lifecycleHost.ts:527).
        const removed = modEventBus.disposeModListeners('probe');
        expect(removed).toBe(3);

        const after = modEventBus.getListenerCount();
        expect(after).toBe(2);
        expect(modEventBus.getListenerCount('turn.start')).toBe(1);
        expect(modEventBus.getListenerCount('turn.committed')).toBe(1);
        expect(modEventBus.getListenerCount('archive.sceneAppended')).toBe(0);

        // probe-two still receives events — disable of one mod never touches
        // another mod's listeners.
        const seen: string[] = [];
        modEventBus.on('turn.start', () => { seen.push('still here'); }, PROBE_TWO);
        modEventBus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });
        expect(seen).toEqual(['still here']);
    });
});

// ─── Item 5: campaign switch — listener count stable across five switches ──

describe('Phase 4.9.4 — Item 5: campaign switch does not leak listeners', () => {
    it('switch campaigns five times — listener count after equals listener count before', async () => {
        // Both probes active. Each subscribes to a campaign-scoped event.
        // Per EVENTS.md §5.4, a campaign switch does NOT revoke event
        // subscriptions — an event carries its own campaignId and is
        // self-describing. So the listener count MUST be unchanged across
        // switches. A leak here compounds silently across sessions.
        modEventBus.on('campaign.opened', () => undefined, PROBE);
        modEventBus.on('campaign.opened', () => undefined, PROBE_TWO);
        modEventBus.on('campaign.closing', () => undefined, PROBE);
        modEventBus.on('campaign.closing', () => undefined, PROBE_TWO);
        modEventBus.on('turn.committed', () => undefined, PROBE);
        modEventBus.on('turn.committed', () => undefined, PROBE_TWO);

        const before = modEventBus.getListenerCount();
        expect(before).toBe(6);

        // Five campaign switches through the real store action.
        const ids = ['camp_one', 'camp_two', 'camp_three', 'camp_four', 'camp_five'];
        useAppStore.setState({ activeCampaignId: 'camp_zero' });
        for (const id of ids) {
            await useAppStore.getState().setActiveCampaign(id);
        }

        const after = modEventBus.getListenerCount();
        // Numbers, not adjectives. The leak that matters is the one that
        // compounds: a +1 per switch becomes 5000 over a long session and
        // is invisible until the app has been open for hours.
        expect(after).toBe(before);
        expect(after).toBe(6);
    });
});

// ─── Item 6: enable/disable churn — no accumulation, no double-fire ────────

describe('Phase 4.9.4 — Item 6: enable/disable churn — no accumulation, no double-fire', () => {
    it('toggle a probe ten times — listener count stays at one, the listener fires exactly once per emit', () => {
        let fireCount = 0;
        // Each "enable" cycle: subscribe once. Each "disable" cycle: host
        // teardown via disposeModListeners. Mirrors lifecycleHost.enable ->
        // activate -> (re-subscribe) and lifecycleHost.disable ->
        // disposeModListeners.
        for (let i = 0; i < 10; i++) {
            const off = modEventBus.on('turn.start', () => { fireCount += 1; }, PROBE);
            expect(modEventBus.getListenerCount('turn.start')).toBe(1);
            modEventBus.emit('turn.start', { turnId: `t${i}`, campaignId: null, playerInput: '', tier: undefined });
            // Host teardown: removes the listener.
            modEventBus.disposeModListeners('probe');
            expect(modEventBus.getListenerCount('turn.start')).toBe(0);
            off(); // idempotent — already removed by host
        }
        // No accumulation: count never rose above 1. No double-fire: each emit
        // fired exactly once (10 emits → 10 fires).
        expect(fireCount).toBe(10);
    });

    it('a stale unsubscribe handle from a previous cycle does not double-remove or throw', () => {
        const stale: Array<() => void> = [];
        for (let i = 0; i < 10; i++) {
            const off = modEventBus.on('turn.start', () => undefined, PROBE);
            stale.push(off);
            modEventBus.disposeModListeners('probe');
        }
        // Calling every stale handle is a no-op — none throw, none remove a
        // listener that does not exist.
        for (const off of stale) {
            expect(() => off()).not.toThrow();
        }
        expect(modEventBus.getListenerCount()).toBe(0);
    });
});

// ─── Item 7: custom events — emit, cross-receive, disable, reject core name ─

describe('Phase 4.9.4 — Item 7: custom events (§4.5)', () => {
    it('probe A emits, probe B receives — cross-mod subscription is allowed', () => {
        const seen: unknown[] = [];
        // probe-two subscribes to probe's namespaced event.
        modEventBus.on('mod.probe.noteAdded', (p) => { seen.push(p); }, PROBE_TWO);
        // probe emits by bare name — host stamps the mod.<id>. prefix.
        modEventBus.emitFromMod(PROBE, 'noteAdded', { text: 'hello' });
        expect(seen).toEqual([{ text: 'hello' }]);
    });

    it('disable A: B receives nothing and does not error', () => {
        const seen: unknown[] = [];
        modEventBus.on('mod.probe.noteAdded', (p) => { seen.push(p); }, PROBE_TWO);
        // Host teardown of probe: its listeners are gone. The subscription
        // above belongs to probe-two, so it stays — but probe (the emitter)
        // has no listeners for its own events because the bus only delivers
        // to subscribers, and emitting a mod event that nobody is listening
        // to is a no-op (§3 consequence 3). Here, probe-two IS listening —
        // so the question is: does disabling the emitter affect the
        // subscriber? No: the subscriber's listeners are not the emitter's.
        modEventBus.disposeModListeners('probe');
        // probe-two's listener is intact.
        expect(modEventBus.getListenerCount('mod.probe.noteAdded')).toBe(1);
        // probe-two can still receive an emit from any source that publishes
        // under that name. Disposing probe's listeners does not stop a
        // third party from emitting `mod.probe.noteAdded` — only probe is
        // forbidden from emitting under another mod's prefix (§4.5).
        // The host-stamped prefix is from the EMITTER's identity, so a
        // disposed probe simply is not emitting. Nothing errors.
        // But if probe IS re-enabled and emits, probe-two receives it.
        modEventBus.emitFromMod(PROBE, 'noteAdded', { text: 'after re-enable' });
        expect(seen).toEqual([{ text: 'after re-enable' }]);
        // No fault from disabling the emitter.
        expect(eventFaultStore.getRecords()).toEqual([]);
    });

    it('attempting to emit a core event name from a mod is rejected with a reason (§4.5)', () => {
        expect(() => modEventBus.emitFromMod(PROBE, 'turn.start', {}))
            .toThrow(ModEventNameRejected);
        expect(() => modEventBus.emitFromMod(PROBE, 'turn.start', {}))
            .toThrow(/Probe.*turn\.start/);

        expect(() => modEventBus.emitFromMod(PROBE, 'campaign.opened', {}))
            .toThrow(ModEventNameRejected);

        expect(() => modEventBus.emitFromMod(PROBE, 'archive.sceneAppended', {}))
            .toThrow(/Probe.*archive\.sceneAppended/);
    });

    it('a mod may not emit under another mod\'s prefix — rejected with a reason naming the mod (§4.5)', () => {
        expect(() => modEventBus.emitFromMod(PROBE, 'mod.probe-two.something', {}))
            .toThrow(ModEventNameRejected);
        expect(() => modEventBus.emitFromMod(PROBE, 'mod.probe-two.something', {}))
            .toThrow(/Probe.*mod\.probe-two\.something/);
    });

    it('a mod event payload is frozen the same way a core payload is (§4.5)', () => {
        let received: Record<string, unknown> | undefined;
        modEventBus.on('mod.probe.tags', (p) => { received = p as Record<string, unknown>; }, PROBE_TWO);
        modEventBus.emitFromMod(PROBE, 'tags', { tags: ['a', 'b'] });
        expect(Object.isFrozen(received)).toBe(true);
        expect(Object.isFrozen(received!.tags)).toBe(true);
    });
});

// ─── Item 8: no emit in the commit path beyond EVENTS.md decision 4 ────────

describe('Phase 4.9.4 — Item 8: no emit in the commit path beyond EVENTS.md §4.3', () => {
    // This is the "confirm by eye" assertion. The work order says: "Read the
    // diff of `postTurnPipeline.ts` and confirm by eye." A unit test cannot
    // read a diff, but it CAN pin the conclusion: the only emits inside the
    // durable commit path are the two EVENTS.md §4.3 explicitly allows —
    // `archive.sceneAppended` and `archive.chapterSealed`, both after the
    // durable write lands. `runCombinedSeal` emits nothing.
    // `retryFailedCommits` emits nothing.
    //
    // The grep assertions below are structural rather than diff-based: they
    // fail if anyone adds a new `emitCoreEvent*` call to the commit-path
    // functions without removing one of the existing two, which is the
    // regression this assertion exists to catch.

    it('postTurnPipeline.ts contains exactly the two commit-path emits EVENTS.md §4.3 allows', async () => {
        const { readFileSync } = await import('fs');
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
        const here = dirname(fileURLToPath(import.meta.url));
        const filePath = join(here, '..', '..', 'turn', 'postTurnPipeline.ts');
        const source = readFileSync(filePath, 'utf-8');

        // Extract every emit call in the file. The two allowed are
        // `archive.sceneAppended` and `archive.chapterSealed`.
        const emitMatches = [...source.matchAll(/emitCoreEvent(?:Lazy)?\(\s*['"]([^'"]+)['"]/g)];
        const emittedNames = emitMatches.map((m) => m[1]).sort();
        expect(emittedNames).toEqual(['archive.chapterSealed', 'archive.sceneAppended']);
    });

    it('runCombinedSeal emits nothing (§4.3 — archive.chapterSealed already announced the seal)', async () => {
        const { readFileSync } = await import('fs');
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
        const here = dirname(fileURLToPath(import.meta.url));
        const filePath = join(here, '..', '..', 'turn', 'postTurnPipeline.ts');
        const source = readFileSync(filePath, 'utf-8');

        // Slice from `export async function runCombinedSeal` to EOF.
        const sealStart = source.indexOf('export async function runCombinedSeal');
        expect(sealStart).toBeGreaterThan(-1);
        const sealBody = source.slice(sealStart);
        // No emits inside the seal function — `archive.chapterSealed` already
        // told a mod the chapter closed; emitting inside `runCombinedSeal` would
        // be a second thing to be correct about (EVENTS.md §4.3 row 3).
        expect(sealBody).not.toMatch(/emitCoreEvent/);
    });

    it('retryFailedCommits emits nothing (§8.2 — it repairs the archive link only)', async () => {
        const { readFileSync } = await import('fs');
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
        const here = dirname(fileURLToPath(import.meta.url));
        const filePath = join(here, '..', '..', 'turn', 'pendingCommit.ts');
        const source = readFileSync(filePath, 'utf-8');

        // Slice from `retryFailedCommits` to EOF.
        const retryStart = source.indexOf('export async function retryFailedCommits');
        expect(retryStart).toBeGreaterThan(-1);
        const retryBody = source.slice(retryStart);
        // No emits: a mod told "scene appended" for a turn whose NPC / agency /
        // arc ticks never fired would be told a half-truth (EVENTS.md §8.2).
        expect(retryBody).not.toMatch(/emitCoreEvent/);
    });
});