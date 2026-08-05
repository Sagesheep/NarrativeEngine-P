// Phase 3.2 — the bus's own contract.
//
// Every assertion here is a sentence from `EVENTS.md` turned into a test. The
// section numbers in the `it` titles are the citations; if one of these fails,
// the fix is the code, not the test — the names and the semantics are frozen by
// Phase 9.2.

import { describe, it, expect, beforeEach } from 'vitest';
import { createModEventBus, ModEventNameRejected, type ModEventOwner } from '../eventBus';
import { createEventFaultStore, formatEventFaultReason } from '../eventFaults';
import { CORE_EVENT_NAMES, STICKY_EVENT_NAMES, isCoreEventName } from '../modEvents';

const owner = (id: string): ModEventOwner => ({ modId: id, modName: id.toUpperCase(), file: `${id}.mod.json` });

describe('Phase 3.2 — the mod event bus', () => {
    let faults = createEventFaultStore();
    let bus = createModEventBus({ faultStore: faults });

    beforeEach(() => {
        faults = createEventFaultStore();
        bus = createModEventBus({ faultStore: faults });
    });

    describe('§4.2 ordering — registration order, deterministic', () => {
        it('invokes listeners in insertion order', () => {
            const seen: string[] = [];
            bus.on('turn.start', () => { seen.push('first'); }, owner('a'));
            bus.on('turn.start', () => { seen.push('second'); }, owner('b'));
            bus.on('turn.start', () => { seen.push('third'); }, owner('c'));

            bus.emit('turn.start', { turnId: 't1', campaignId: 'c1', playerInput: 'go', tier: 'pro' });

            expect(seen).toEqual(['first', 'second', 'third']);
        });

        it('a late subscriber appends rather than re-sorting', () => {
            const seen: string[] = [];
            bus.on('turn.start', () => { seen.push('early'); }, owner('a'));
            bus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });
            bus.on('turn.start', () => { seen.push('late'); }, owner('b'));
            bus.emit('turn.start', { turnId: 't2', campaignId: null, playerInput: '', tier: undefined });

            expect(seen).toEqual(['early', 'early', 'late']);
        });

        it('a listener that subscribes during delivery does not receive that emit', () => {
            const seen: string[] = [];
            bus.on('turn.start', () => {
                seen.push('outer');
                bus.on('turn.start', () => { seen.push('inner'); }, owner('b'));
            }, owner('a'));

            bus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });
            expect(seen).toEqual(['outer']);

            bus.emit('turn.start', { turnId: 't2', campaignId: null, playerInput: '', tier: undefined });
            expect(seen).toEqual(['outer', 'outer', 'inner']);
        });
    });

    describe('§3 the payload rule', () => {
        it('freezes the record and its array-valued fields', () => {
            let received: { changedKeys: readonly string[] } | undefined;
            bus.on('settings.changed', (payload) => { received = payload; }, owner('a'));

            bus.emit('settings.changed', { changedKeys: ['aiTier', 'theme'] });

            expect(Object.isFrozen(received)).toBe(true);
            expect(Object.isFrozen(received!.changedKeys)).toBe(true);
        });

        it('a listener cannot write to host state through a payload', () => {
            const source = { changedKeys: ['aiTier'] };
            bus.on('settings.changed', (payload) => {
                // A mod trying to mutate what it was handed. Silent no-op in
                // sloppy mode, TypeError in strict — either way the host's own
                // object is untouched, which is the invariant.
                try { (payload as { changedKeys: string[] }).changedKeys.push('providers'); } catch { /* strict mode */ }
            }, owner('a'));

            bus.emit('settings.changed', source);
            expect(source.changedKeys).toEqual(['aiTier']);
        });

        it('emit copies, so the caller\'s object is never frozen out from under it', () => {
            const source = { changedKeys: ['aiTier'] };
            bus.on('settings.changed', () => undefined, owner('a'));
            bus.emit('settings.changed', source);
            expect(Object.isFrozen(source)).toBe(false);
        });

        it('zero listeners costs nothing — no listener, no delivery, no retention', () => {
            // Non-sticky: nothing retained, so a later subscriber learns nothing.
            bus.emit('turn.generated', {
                turnId: 't1', campaignId: 'c1', messageId: 'm1', text: 'hi', sceneStakes: 'calm',
            });
            const seen: unknown[] = [];
            bus.on('turn.generated', (p) => { seen.push(p); }, owner('a'));
            expect(seen).toEqual([]);
            expect(bus.getRetained('turn.generated' as never)).toBeUndefined();
        });
    });

    describe('§4.4 sticky events', () => {
        it('names exactly two', () => {
            expect([...STICKY_EVENT_NAMES]).toEqual(['app.ready', 'campaign.opened']);
        });

        it('replays campaign.opened to a late subscriber with replayed: true', () => {
            bus.emit('campaign.opened', { campaignId: 'camp_7' });

            const seen: Array<{ campaignId: string; replayed?: true }> = [];
            bus.on('campaign.opened', (p) => { seen.push(p); }, owner('a'));

            expect(seen).toEqual([{ campaignId: 'camp_7', replayed: true }]);
        });

        it('does not mark the live handout as replayed', () => {
            const seen: Array<{ campaignId: string; replayed?: true }> = [];
            bus.on('campaign.opened', (p) => { seen.push(p); }, owner('a'));
            bus.emit('campaign.opened', { campaignId: 'camp_7' });
            expect(seen).toEqual([{ campaignId: 'camp_7' }]);
        });

        it('retains even with zero listeners — that is the whole point of replay', () => {
            bus.emit('app.ready', { modIds: ['arc'], faultCount: 0 });
            const seen: unknown[] = [];
            bus.on('app.ready', (p) => { seen.push(p); }, owner('a'));
            expect(seen).toEqual([{ modIds: ['arc'], faultCount: 0, replayed: true }]);
        });

        it('retains only the LAST payload', () => {
            bus.emit('campaign.opened', { campaignId: 'first' });
            bus.emit('campaign.opened', { campaignId: 'second' });
            const seen: Array<{ campaignId: string }> = [];
            bus.on('campaign.opened', (p) => { seen.push(p); }, owner('a'));
            expect(seen.map(p => p.campaignId)).toEqual(['second']);
        });

        it('every other event is fire-and-forget', () => {
            for (const name of CORE_EVENT_NAMES) {
                if (STICKY_EVENT_NAMES.includes(name)) continue;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                bus.emit(name as any, {} as any);
                expect(bus.getRetained(name)).toBeUndefined();
            }
        });
    });

    describe('§4.1 observational', () => {
        it('ignores a listener\'s return value, including a promise', () => {
            const seen: string[] = [];
            bus.on('turn.start', () => { seen.push('first'); return false; }, owner('a'));
            bus.on('turn.start', async () => { seen.push('second'); }, owner('b'));
            bus.on('turn.start', () => { seen.push('third'); }, owner('c'));

            bus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });

            // A `false` return did not stop propagation; a promise was not awaited.
            expect(seen).toEqual(['first', 'second', 'third']);
        });
    });

    describe('§5.3 fault containment', () => {
        it('a throwing listener is caught, the emit continues, and the fault names the mod', () => {
            const seen: string[] = [];
            bus.on('archive.sceneAppended', () => { throw new Error('boom'); }, owner('bad'));
            bus.on('archive.sceneAppended', () => { seen.push('after'); }, owner('good'));

            expect(() => bus.emit('archive.sceneAppended', {
                campaignId: 'c1', sceneId: 's1', messageId: 'm1',
            })).not.toThrow();

            expect(seen).toEqual(['after']);
            const records = faults.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0].modId).toBe('bad');
            expect(records[0].event).toBe('archive.sceneAppended');
            expect(records[0].reason).toBe(formatEventFaultReason({
                modName: 'BAD', event: 'archive.sceneAppended', message: 'boom',
            }));
        });

        it('projects into the Extensions fault list shape', () => {
            bus.on('turn.start', () => { throw new Error('nope'); }, owner('bad'));
            bus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });
            expect(faults.getFaults()).toEqual([
                { file: 'bad.mod.json', reason: 'BAD: listener for "turn.start" threw (nope)' },
            ]);
        });

        it('does not latch — a mod that throws every turn keeps receiving events (§5.3)', () => {
            let calls = 0;
            bus.on('turn.start', () => { calls += 1; throw new Error('again'); }, owner('bad'));
            for (let i = 0; i < 5; i++) {
                bus.emit('turn.start', { turnId: `t${i}`, campaignId: null, playerInput: '', tier: undefined });
            }
            expect(calls).toBe(5);
            // One row per mod, latest fault wins — the list does not grow unbounded.
            expect(faults.getRecords()).toHaveLength(1);
        });

        it('a throwing listener on a REPLAYED sticky event is contained too', () => {
            bus.emit('campaign.opened', { campaignId: 'c1' });
            expect(() => bus.on('campaign.opened', () => { throw new Error('replay boom'); }, owner('bad')))
                .not.toThrow();
            expect(faults.getRecords()[0].event).toBe('campaign.opened');
        });
    });

    describe('§5.4 teardown is host-owned', () => {
        it('disposeModListeners removes every listener a mod registered', () => {
            const seen: string[] = [];
            bus.on('turn.start', () => { seen.push('a1'); }, owner('a'));
            bus.on('turn.generated', () => { seen.push('a2'); }, owner('a'));
            bus.on('turn.start', () => { seen.push('b1'); }, owner('b'));

            expect(bus.getListenerCount()).toBe(3);
            expect(bus.disposeModListeners('a')).toBe(2);
            expect(bus.getListenerCount()).toBe(1);

            bus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });
            bus.emit('turn.generated', { turnId: 't1', campaignId: null, messageId: 'm', text: '', sceneStakes: 'calm' });
            expect(seen).toEqual(['b1']);
        });

        it('the mod is never trusted to call off — a mod that leaks its handle is still torn down', () => {
            // No unsubscribe handle is kept. The host still finds it by owner.
            bus.on('message.deleted', () => undefined, owner('leaky'));
            expect(bus.getListenerCount('message.deleted')).toBe(1);
            bus.disposeModListeners('leaky');
            expect(bus.getListenerCount('message.deleted')).toBe(0);
        });

        it('the returned unsubscribe handle also works, and is idempotent', () => {
            const off = bus.on('turn.start', () => undefined, owner('a'));
            off();
            off();
            expect(bus.getListenerCount('turn.start')).toBe(0);
        });

        it('reset drops listeners and retained sticky payloads', () => {
            bus.on('turn.start', () => undefined, owner('a'));
            bus.emit('app.ready', { modIds: [], faultCount: 0 });
            bus.reset();
            expect(bus.getListenerCount()).toBe(0);
            expect(bus.getRetained('app.ready')).toBeUndefined();
        });
    });

    describe('§4.5 custom events', () => {
        it('stamps the mod prefix from the context identity, not the argument', () => {
            const seen: unknown[] = [];
            bus.on('mod.arc.threadOpened', (p) => { seen.push(p); }, owner('other'));
            bus.emitFromMod(owner('arc'), 'threadOpened', { threadId: 'th_1' });
            expect(seen).toEqual([{ threadId: 'th_1' }]);
        });

        it('accepts the fully-qualified own name as an alias', () => {
            const seen: unknown[] = [];
            bus.on('mod.arc.threadOpened', (p) => { seen.push(p); }, owner('x'));
            bus.emitFromMod(owner('arc'), 'mod.arc.threadOpened', { threadId: 'th_2' });
            expect(seen).toEqual([{ threadId: 'th_2' }]);
        });

        it('allows cross-mod subscription — the emitter chose to publish', () => {
            const seen: unknown[] = [];
            bus.on('mod.arc.threadOpened', (p) => { seen.push(p); }, owner('skilltree'));
            bus.emitFromMod(owner('arc'), 'threadOpened', { threadId: 'th_3' });
            expect(seen).toHaveLength(1);
        });

        it('rejects a core name, naming the mod and the name', () => {
            expect(() => bus.emitFromMod(owner('arc'), 'turn.start', {}))
                .toThrow(ModEventNameRejected);
            expect(() => bus.emitFromMod(owner('arc'), 'turn.start', {}))
                .toThrow(/ARC.*turn\.start/);
        });

        it('rejects another mod\'s prefix, naming the mod and the name', () => {
            expect(() => bus.emitFromMod(owner('arc'), 'mod.skilltree.nodeUnlocked', {}))
                .toThrow(/ARC.*mod\.skilltree\.nodeUnlocked/);
        });

        it('freezes a mod event payload the same way', () => {
            let received: Record<string, unknown> | undefined;
            bus.on('mod.arc.threadOpened', (p) => { received = p as Record<string, unknown>; }, owner('x'));
            bus.emitFromMod(owner('arc'), 'threadOpened', { tags: ['a', 'b'] });
            expect(Object.isFrozen(received)).toBe(true);
            expect(Object.isFrozen(received!.tags)).toBe(true);
        });

        it('declines wildcards — there is no subscription that catches a family', () => {
            const seen: unknown[] = [];
            // Subscribing to a wildcard registers a listener for the literal
            // string "turn.*", which nothing ever emits. No magic, by design.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            bus.on('turn.*' as any, (p: unknown) => { seen.push(p); }, owner('a'));
            bus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });
            expect(seen).toEqual([]);
        });
    });

    describe('§2 the grammar', () => {
        it('names exactly twenty core events, none beginning with "mod."', () => {
            expect(CORE_EVENT_NAMES).toHaveLength(20);
            expect(CORE_EVENT_NAMES.filter(n => n.startsWith('mod.'))).toEqual([]);
            expect(new Set(CORE_EVENT_NAMES).size).toBe(20);
        });

        it('covers the six families', () => {
            const families = new Set(CORE_EVENT_NAMES.map(n => n.split('.')[0]));
            expect([...families].sort()).toEqual(
                ['app', 'archive', 'campaign', 'message', 'settings', 'turn'],
            );
        });

        it('isCoreEventName is the impersonation check, with no allow-list', () => {
            expect(isCoreEventName('turn.start')).toBe(true);
            expect(isCoreEventName('mod.arc.threadOpened')).toBe(false);
            expect(isCoreEventName('turn.somethingElse')).toBe(false);
        });
    });
});
