import { cleanup, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorldMapTravelBridge } from '../WorldMapTravelBridge';
import { useAppStore } from '../../store/useAppStore';
import { modEventBus } from '../../services/mods/events';
import type { LocationEntry } from '../../types';

function makePlace(id: string, name: string, overrides: Partial<LocationEntry> = {}): LocationEntry {
    return {
        id,
        name,
        aliases: '',
        broadLocation: '',
        features: [],
        connections: [],
        description: '',
        firstSeenScene: '1',
        lastSeenScene: '1',
        source: 'manual',
        ...overrides,
    };
}

describe('WorldMapTravelBridge', () => {
    beforeEach(() => {
        modEventBus.reset();
        useAppStore.setState({
            activeCampaignId: 'camp-1',
            // Messages accumulate across tests otherwise, and a count
            // assertion then measures the whole file instead of the test.
            messages: [],
            locationLedger: [
                makePlace('a', 'Aethelgard', { connections: [{ toId: 'b' }] }),
                makePlace('b', 'Briarwatch'),
                makePlace('c', 'Caerwyn', { connections: [{ toId: 'b' }] }),
            ],
            context: { currentPlaceId: 'a', travelMode: 'foot', worldDay: 1 },
        });
    });

    afterEach(() => {
        cleanup();
        modEventBus.reset();
        useAppStore.setState({
            activeCampaignId: null,
            locationLedger: [],
            context: { currentPlaceId: undefined, travelMode: undefined, travel: null, worldDay: undefined },
        });
    });

    it('renders nothing (side-effect-only component)', () => {
        const { container } = render(<WorldMapTravelBridge />);
        expect(container.firstChild).toBeNull();
    });

    it('WO 6.5 — on mod.worldmap.travelRequest, departs directly: sets context.travel, no composer injection', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a',
                toId: 'b',
                mode: 'foot',
                hops: [{ fromId: 'a', toId: 'b', transitId: 't1', legs: 2 }],
            });
        });
        const ctx = useAppStore.getState().context;
        expect(ctx.travel).not.toBeNull();
        expect(ctx.travel!.toId).toBe('b');
        expect(ctx.travel!.leg).toBe(1);
        // WO 6.5: the day advanced (first press = camp 1 = day + 1).
        expect(ctx.worldDay).toBe(2);
        // No composer injection — travel is an engine action.
        expect(useAppStore.getState().composerInjection).toBeNull();
    });

    it('WO 6.5 — for a multi-hop route, sets context.travel with hops', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a',
                toId: 'c',
                mode: 'foot',
                hops: [
                    { fromId: 'a', toId: 'b', transitId: 't1', legs: 2 },
                    { fromId: 'b', toId: 'c', transitId: 't2', legs: 3 },
                ],
            });
        });
        const ctx = useAppStore.getState().context;
        expect(ctx.travel).not.toBeNull();
        expect(ctx.travel!.toId).toBe('c');
        expect(ctx.travel!.mode).toBe('foot');
        expect(ctx.travel!.hops).toHaveLength(2);
        expect(ctx.travel!.totalLegs).toBe(5);
        expect(ctx.worldDay).toBe(2);
    });

    it('WO 6.5 — produces the same travel state the other entry points produce (anti-drift)', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a',
                toId: 'b',
                mode: 'cart',
                hops: [{ fromId: 'a', toId: 'b', transitId: 't1', legs: 3 }],
            });
        });
        const ctx = useAppStore.getState().context;
        // The travel state is the same as what composeDeparture would produce
        // for the same (fromId, toId, mode, band) — all three entry points
        // go through composeDeparture.
        expect(ctx.travel).not.toBeNull();
        expect(ctx.travel!.toId).toBe('b');
        expect(ctx.travel!.mode).toBe('cart');
    });

    it('ignores events when no campaign is active', () => {
        useAppStore.setState({ activeCampaignId: null });
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a', toId: 'b', mode: 'foot', hops: [],
            });
        });
        expect(useAppStore.getState().context.travel).toBeUndefined();
    });

    it('ignores events with a missing destination in the ledger', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a', toId: 'missing', mode: 'foot', hops: [],
            });
        });
        expect(useAppStore.getState().context.travel).toBeUndefined();
    });

    it('WO 6.5 — moves without posting routine checkpoint text', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a',
                toId: 'b',
                mode: 'foot',
                hops: [{ fromId: 'a', toId: 'b', transitId: 't1', legs: 3 }],
            });
        });
        const messages = useAppStore.getState().messages;
        const checkpointMsg = messages.find(m => m.name === 'travel-checkpoint');
        expect(checkpointMsg).toBeUndefined();
    });

    it('the map panel’s Continue advances a leg, without the LLM', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a', toId: 'b', mode: 'foot',
                hops: [{ fromId: 'a', toId: 'b', transitId: 't1', legs: 3 }],
            });
        });
        const departed = useAppStore.getState().context;
        expect(departed.travel!.leg).toBe(1);

        act(() => { modEventBus.emit('mod.worldmap.travelAdvance', {}); });

        const after = useAppStore.getState();
        expect(after.context.travel!.leg).toBe(2);
        expect(after.context.worldDay).toBe((departed.worldDay ?? 0) + 1);
        // One press, one day, one camp — and one line from the engine.
        const camps = after.messages.filter(m => m.name === 'travel-checkpoint');
        expect(camps).toHaveLength(0);
    });

    it('the map panel’s Abandon clears the journey without arriving', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a', toId: 'b', mode: 'foot',
                hops: [{ fromId: 'a', toId: 'b', transitId: 't1', legs: 3 }],
            });
        });
        expect(useAppStore.getState().context.travel).toBeTruthy();

        act(() => { modEventBus.emit('mod.worldmap.travelAbandon', {}); });

        const after = useAppStore.getState();
        expect(after.context.travel).toBeNull();
        // Abandoning is not arriving: the destination is not reached.
        expect(after.context.currentPlaceId).not.toBe('b');
        const abandoned = after.messages.find(m => m.name === 'travel-abandon');
        expect(abandoned?.content).toContain('Briarwatch');
    });

    it('advancing with no journey does nothing at all', () => {
        // The map cannot be trusted to only emit when a journey is running —
        // it reads a snapshot that can be one repaint stale.
        render(<WorldMapTravelBridge />);
        const before = useAppStore.getState().messages.length;
        act(() => {
            modEventBus.emit('mod.worldmap.travelAdvance', {});
            modEventBus.emit('mod.worldmap.travelAbandon', {});
        });
        const after = useAppStore.getState();
        expect(after.context.travel ?? null).toBeNull();
        expect(after.messages).toHaveLength(before);
    });
    it('ignores a stale departure click while a journey is already active', () => {
        render(<WorldMapTravelBridge />);
        const payload = { fromId: 'a', toId: 'b', mode: 'foot' as const, hops: [{ fromId: 'a', toId: 'b', transitId: 't1', legs: 3 }] };
        act(() => { modEventBus.emit('mod.worldmap.travelRequest', payload); });
        const before = useAppStore.getState().context;
        act(() => { modEventBus.emit('mod.worldmap.travelRequest', payload); });
        expect(useAppStore.getState().context).toEqual(before);
    });

});

describe('map roleplay handoff', () => {
    const scene = { key: '1:1:2', placeId: 'a', worldDay: 1, leg: null, weather: 'clear', biome: 'forest', quiet: false,
        status: 'available' as const, events: [{ id: 'bear', source: 'biome', title: 'Bear', text: 'A bear forages.' }] };
    const request = { campaignId: 'camp-rp', key: scene.key, placeId: 'a', worldDay: 1, leg: null, kind: 'reply', text: 'I observe the bear.' };
    beforeEach(() => {
        modEventBus.reset(); useAppStore.setState({ activeCampaignId: 'camp-rp', composerInjection: null, isStreaming: false,
            messages: [], context: { currentPlaceId: 'a', worldDay: 1, travel: null, mapEncounter: scene } });
    });
    afterEach(() => { cleanup(); modEventBus.reset(); useAppStore.setState({ activeCampaignId: null, composerInjection: null }); });
    it('prepares editable text without sending, moving or resolving the encounter', () => {
        render(<WorldMapTravelBridge />);
        act(() => modEventBus.emit('mod.worldmap.roleplayRequest', request));
        const state = useAppStore.getState();
        expect(state.composerInjection).toBe(request.text); expect(state.messages).toEqual([]);
        expect(state.context).toMatchObject({ currentPlaceId: 'a', worldDay: 1, travel: null, mapEncounter: scene });
    });
    it('rejects a delayed action from another campaign, day, place or leg', () => {
        render(<WorldMapTravelBridge />);
        for (const patch of [{ campaignId: 'other' }, { worldDay: 2 }, { placeId: 'b' }, { leg: 1 }, { key: 'stale' }]) {
            act(() => modEventBus.emit('mod.worldmap.roleplayRequest', { ...request, ...patch }));
            expect(useAppStore.getState().composerInjection).toBeNull();
        }
    });
    it('allows a camp draft at quiet or handled stops but rejects restarting an encounter', () => {
        useAppStore.setState({ context: { currentPlaceId: 'a', worldDay: 1, mapEncounter: { ...scene, status: 'handled' } } });
        render(<WorldMapTravelBridge />);
        act(() => modEventBus.emit('mod.worldmap.roleplayRequest', request));
        expect(useAppStore.getState().composerInjection).toBeNull();
        act(() => modEventBus.emit('mod.worldmap.roleplayRequest', { ...request, kind: 'camp', text: 'I make camp here.' }));
        expect(useAppStore.getState().composerInjection).toBe('I make camp here.');
        expect(useAppStore.getState().context.worldDay).toBe(1);
    });
});
