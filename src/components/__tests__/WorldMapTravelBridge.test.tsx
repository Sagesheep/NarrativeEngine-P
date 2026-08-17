import { cleanup, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
        // Reset the mod event bus so listeners from a previous test's render
        // don't leak into this one. The bridge subscribes on mount and
        // unsubscribes on unmount, but `cleanup()` runs in `afterEach` — a
        // listener that was still active when the next test's `beforeEach`
        // fires would receive this test's events.
        modEventBus.reset();
        useAppStore.setState({
            activeCampaignId: 'camp-1',
            locationLedger: [
                makePlace('a', 'Aethelgard', { connections: [{ toId: 'b' }] }),
                makePlace('b', 'Briarwatch'),
                makePlace('c', 'Caerwyn', { connections: [{ toId: 'b' }] }),
            ],
            context: { currentPlaceId: 'a', travelMode: 'foot' },
            composerInjection: null,
            pendingTravelIntent: null,
        });
    });

    afterEach(() => {
        cleanup();
        modEventBus.reset();
        useAppStore.setState({
            activeCampaignId: null,
            locationLedger: [],
            context: { currentPlaceId: undefined, travelMode: undefined },
            composerInjection: null,
            pendingTravelIntent: null,
        });
    });

    it('renders nothing (side-effect-only component)', () => {
        const { container } = render(<WorldMapTravelBridge />);
        expect(container.firstChild).toBeNull();
    });

    it('on mod.worldmap.travelRequest, injects the byte-identical departure sentence', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a',
                toId: 'b',
                mode: 'foot',
                hops: [{ fromId: 'a', toId: 'b', transitId: 't1', legs: 2 }],
            });
        });
        // The sentence matches `buildDepartureSentence('Briarwatch', 'foot')`.
        expect(useAppStore.getState().composerInjection).toBe('We set out for Briarwatch by foot.');
    });

    it('for a multi-hop route, arms a pending intent with the hops', () => {
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
        const intent = useAppStore.getState().pendingTravelIntent;
        expect(intent).not.toBeNull();
        expect(intent!.toId).toBe('c');
        expect(intent!.mode).toBe('foot');
        expect(intent!.hops).toHaveLength(2);
        expect(intent!.injectedText).toBe('We set out for Caerwyn by foot.');
    });

    it('produces the same sentence the Places panel produces (anti-drift)', () => {
        // WO 6.1 §5 test 3 — the map surface's committed sentence is
        // byte-identical to the Places panel's. Both call
        // `composeDeparture` → `buildDepartureSentence(target.name, mode)`.
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a',
                toId: 'b',
                mode: 'cart',
                hops: [{ fromId: 'a', toId: 'b', transitId: 't1', legs: 3 }],
            });
        });
        // The Places panel and composer button would call
        // `buildDepartureSentence('Briarwatch', 'cart')` → same string.
        expect(useAppStore.getState().composerInjection).toBe('We set out for Briarwatch by cart.');
    });

    it('ignores events when no campaign is active', () => {
        useAppStore.setState({ activeCampaignId: null, composerInjection: null });
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a', toId: 'b', mode: 'foot', hops: [],
            });
        });
        expect(useAppStore.getState().composerInjection).toBeNull();
    });

    it('ignores events with a missing destination in the ledger', () => {
        render(<WorldMapTravelBridge />);
        act(() => {
            modEventBus.emit('mod.worldmap.travelRequest', {
                fromId: 'a', toId: 'missing', mode: 'foot', hops: [],
            });
        });
        expect(useAppStore.getState().composerInjection).toBeNull();
    });
});