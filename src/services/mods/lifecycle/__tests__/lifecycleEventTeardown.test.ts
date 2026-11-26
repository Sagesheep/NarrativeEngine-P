/**
 * Phase 3.2 / `EVENTS.md` §5.4 — teardown is host-owned.
 *
 * > Every subscription is attributed to the mod whose context created it, and
 * > **the host removes them on disable — the mod is never trusted to call
 * > `off`.**
 *
 * 3.2 adds the event bus to the call site Phase 2.4 already established
 * (`disposeModSubscriptions` inside `disable`, `disposeAllModSubscriptions`
 * inside `reset`). Phase 4.9.4 will try deliberately to leak one; this pins the
 * mechanism it will be attacking.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createLifecycleHost } from '../lifecycleHost';
import { createLifecycleFaultStore } from '../lifecycleFaults';
import { makeInMemoryStateStore, makeRecordingMod, recordingLoader } from '../lifecycleFixtures';
import type { LifecycleFaultStore } from '../lifecycleTypes';
import { modEventBus, eventFaultStore } from '../../events';
import type { ModEventOwner } from '../../events';

const ownerFor = (id: string): ModEventOwner => ({ modId: id, modName: id, file: `${id}.mod.json` });

describe('Phase 3.2 — event listener teardown', () => {
    let faultStore: LifecycleFaultStore;

    beforeEach(() => {
        faultStore = createLifecycleFaultStore();
        modEventBus.reset();
        eventFaultStore.clear();
    });

    afterEach(() => {
        modEventBus.reset();
        eventFaultStore.clear();
    });

    it('disable removes every listener the mod registered, even without an off handle', async () => {
        const rec = makeRecordingMod({ id: 'alpha' });
        const host = createLifecycleHost({
            loadHooks: recordingLoader([rec]),
            stateStore: makeInMemoryStateStore(),
            faultStore,
        });

        // What a mod does in `activate`. The handles are deliberately discarded:
        // the host must not depend on the mod behaving.
        modEventBus.on('turn.start', () => undefined, ownerFor('alpha'));
        modEventBus.on('turn.generated', () => undefined, ownerFor('alpha'));
        modEventBus.on('turn.start', () => undefined, ownerFor('beta'));
        expect(modEventBus.getListenerCount()).toBe(3);

        await host.disable({ mod: rec.mod });

        // Alpha's two are gone; beta's is untouched.
        expect(modEventBus.getListenerCount()).toBe(1);
        expect(modEventBus.getListenerCount('turn.start')).toBe(1);
        expect(modEventBus.getListenerCount('turn.generated')).toBe(0);
    });

    it('a disabled mod stops receiving events', async () => {
        const rec = makeRecordingMod({ id: 'alpha' });
        const host = createLifecycleHost({
            loadHooks: recordingLoader([rec]),
            stateStore: makeInMemoryStateStore(),
            faultStore,
        });

        const seen: string[] = [];
        modEventBus.on('message.deleted', () => { seen.push('hit'); }, ownerFor('alpha'));

        modEventBus.emit('message.deleted', { campaignId: 'c1', messageIds: ['m1'] });
        await host.disable({ mod: rec.mod });
        modEventBus.emit('message.deleted', { campaignId: 'c1', messageIds: ['m2'] });

        expect(seen).toEqual(['hit']);
    });

    it('teardown runs even when the mod\'s own disable hook throws', async () => {
        const rec = makeRecordingMod({
            id: 'alpha',
            overrides: { disable: () => { throw new Error('the mod\'s cleanup misbehaved'); } },
        });
        const host = createLifecycleHost({
            loadHooks: recordingLoader([rec]),
            stateStore: makeInMemoryStateStore(),
            faultStore,
        });

        modEventBus.on('turn.start', () => undefined, ownerFor('alpha'));
        await host.disable({ mod: rec.mod });

        expect(modEventBus.getListenerCount()).toBe(0);
    });

    it('reset drops every listener and every retained sticky payload', async () => {
        const rec = makeRecordingMod({ id: 'alpha' });
        const host = createLifecycleHost({
            loadHooks: recordingLoader([rec]),
            stateStore: makeInMemoryStateStore(),
            faultStore,
        });

        modEventBus.on('turn.start', () => undefined, ownerFor('alpha'));
        modEventBus.on('turn.start', () => undefined, ownerFor('beta'));
        modEventBus.emit('campaign.opened', { campaignId: 'c1' });
        expect(modEventBus.getRetained('campaign.opened')).toBeDefined();

        host.reset();

        expect(modEventBus.getListenerCount()).toBe(0);
        expect(modEventBus.getRetained('campaign.opened')).toBeUndefined();
        expect(eventFaultStore.getRecords()).toEqual([]);
    });

    it('a mod\'s event faults are cleared by reset alongside the other stores', async () => {
        const rec = makeRecordingMod({ id: 'alpha' });
        const host = createLifecycleHost({
            loadHooks: recordingLoader([rec]),
            stateStore: makeInMemoryStateStore(),
            faultStore,
        });

        modEventBus.on('turn.start', () => { throw new Error('boom'); }, ownerFor('alpha'));
        modEventBus.emit('turn.start', { turnId: 't1', campaignId: null, playerInput: '', tier: undefined });
        expect(eventFaultStore.getRecords()).toHaveLength(1);

        host.reset();
        expect(eventFaultStore.getRecords()).toEqual([]);
    });
});
