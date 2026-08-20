import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { offerConnectionFromPreviousPlace } from '../useSelectionActions';
import { useAppStore } from '../../../store/useAppStore';
import type { LocationEntry } from '../../../types';

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

describe('offerConnectionFromPreviousPlace (WO 6.3 §2)', () => {
    let updateLocation: ReturnType<typeof vi.fn>;
    let showToast: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        updateLocation = vi.fn();
        showToast = vi.fn();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        useAppStore.setState({
            locationLedger: [],
            updateLocation: undefined as never,
        } as never, false);
    });

    it('offers a connection from the previous current place, pre-filled with the local band', () => {
        const previous = makePlace('prev', 'Haven');
        const ledger = [previous];
        const shown = offerConnectionFromPreviousPlace({
            newPlaceId: 'new',
            newPlaceName: 'Beacon',
            previousPlaceId: 'prev',
            ledger,
            updateLocation,
            showToast,
        });
        expect(shown).toBe(true);
        expect(showToast).toHaveBeenCalledTimes(1);
        const [message, action] = showToast.mock.calls[0];
        expect(message).toContain('Beacon');
        expect(message).toContain('Haven');
        expect(message).toContain('local');
        expect(action.label).toBe('Connect');
        expect(typeof action.onClick).toBe('function');
    });

    it('does not auto-create — accepting calls ensureConnection (the shared path), declining writes nothing', () => {
        const previous = makePlace('prev', 'Haven');
        const newPlace = makePlace('new', 'Beacon');
        const ledger = [previous, newPlace];
        const shown = offerConnectionFromPreviousPlace({
            newPlaceId: 'new',
            newPlaceName: 'Beacon',
            previousPlaceId: 'prev',
            ledger,
            updateLocation,
            showToast,
        });
        expect(shown).toBe(true);
        // Declining: no updateLocation call has happened yet.
        expect(updateLocation).not.toHaveBeenCalled();

        // Accepting: the action's onClick reads the live store and calls
        // ensureConnection, which writes a symmetric connection via
        // updateLocation. We mock the store so the live read returns the
        // same ledger + a spied updateLocation.
        const liveUpdateLocation = vi.fn();
        useAppStore.setState({
            locationLedger: ledger,
            updateLocation: liveUpdateLocation,
        });
        const [, action] = showToast.mock.calls[0];
        action.onClick();
        // ensureConnection writes a symmetric connection at the local band:
        // { toId: prev, band: 'local' } on the new place, and
        // { toId: new, band: 'local' } on the previous place. Two
        // updateLocation calls — one per endpoint.
        expect(liveUpdateLocation).toHaveBeenCalledTimes(2);
        expect(liveUpdateLocation).toHaveBeenNthCalledWith(1, 'new', {
            connections: [{ toId: 'prev', band: 'local' }],
        });
        expect(liveUpdateLocation).toHaveBeenNthCalledWith(2, 'prev', {
            connections: [{ toId: 'new', band: 'local' }],
        });
    });

    it('declining leaves the new place unconnected', () => {
        const previous = makePlace('prev', 'Haven');
        const ledger = [previous];
        offerConnectionFromPreviousPlace({
            newPlaceId: 'new',
            newPlaceName: 'Beacon',
            previousPlaceId: 'prev',
            ledger,
            updateLocation,
            showToast,
        });
        // The player dismisses (auto-dismiss or X) — the onClick never fires.
        expect(updateLocation).not.toHaveBeenCalled();
    });

    it('suppresses the offer when there is no previous current place', () => {
        const shown = offerConnectionFromPreviousPlace({
            newPlaceId: 'new',
            newPlaceName: 'Beacon',
            previousPlaceId: null,
            ledger: [],
            updateLocation,
            showToast,
        });
        expect(shown).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
    });

    it('suppresses the offer when the previous place is the new place', () => {
        const shown = offerConnectionFromPreviousPlace({
            newPlaceId: 'same',
            newPlaceName: 'Beacon',
            previousPlaceId: 'same',
            ledger: [makePlace('same', 'Beacon')],
            updateLocation,
            showToast,
        });
        expect(shown).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
    });

    it('suppresses the offer when the previous place is a transit node', () => {
        const transit = makePlace('prev', 'Road between A and B', { kind: 'transit' });
        const shown = offerConnectionFromPreviousPlace({
            newPlaceId: 'new',
            newPlaceName: 'Beacon',
            previousPlaceId: 'prev',
            ledger: [transit],
            updateLocation,
            showToast,
        });
        expect(shown).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
    });

    it('suppresses the offer when a connection already exists', () => {
        const previous = makePlace('prev', 'Haven', { connections: [{ toId: 'new', band: 'local' }] });
        const ledger = [previous];
        const shown = offerConnectionFromPreviousPlace({
            newPlaceId: 'new',
            newPlaceName: 'Beacon',
            previousPlaceId: 'prev',
            ledger,
            updateLocation,
            showToast,
        });
        expect(shown).toBe(false);
        expect(showToast).not.toHaveBeenCalled();
    });

    it('uses a custom band when provided (the ledger default is local)', () => {
        const previous = makePlace('prev', 'Haven');
        const ledger = [previous];
        offerConnectionFromPreviousPlace({
            newPlaceId: 'new',
            newPlaceName: 'Beacon',
            previousPlaceId: 'prev',
            ledger,
            updateLocation,
            showToast,
            band: 'regional',
        });
        const [message] = showToast.mock.calls[0];
        expect(message).toContain('regional');
    });
});