import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TravelButton } from '../TravelButton';
import { useAppStore } from '../../store/useAppStore';
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

describe('TravelButton', () => {
    beforeEach(() => {
        // The real store is fine — we only read/mutate the slices we touch.
        useAppStore.setState({
            pipelinePhase: 'idle',
            locationLedger: [],
            context: { currentPlaceId: undefined, travelMode: undefined },
        });
    });

    afterEach(() => {
        cleanup();
        useAppStore.setState({
            locationLedger: [],
            context: { currentPlaceId: undefined, travelMode: undefined },
            composerInjection: null,
            pendingTravelIntent: null,
        });
    });

    it('renders a Travel button in the composer strip without any hover interaction', () => {
        render(<TravelButton />);
        // Reachable by keyboard — it is a real button with a text label, not a
        // bare glyph hidden until hover.
        const btn = screen.getByRole('button', { name: /travel/i });
        expect(btn).toBeVisible();
        expect(btn).not.toHaveAttribute('disabled');
    });

    it('is disabled while the pipeline is streaming', () => {
        useAppStore.setState({ pipelinePhase: 'streaming' });
        render(<TravelButton />);
        expect(screen.getByRole('button', { name: /travel/i })).toBeDisabled();
    });

    it('opens the destination picker on click', () => {
        const a = makePlace('a', 'Aubergine');
        const b = makePlace('b', 'Beacon', { connections: [{ toId: 'a', band: 'far' }] });
        const aWithConn: LocationEntry = { ...a, connections: [{ toId: 'b', band: 'far' }] };
        useAppStore.setState({
            locationLedger: [aWithConn, b],
            context: { currentPlaceId: 'a', travelMode: 'foot' },
        });

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));

        // The picker modal renders the destination list and Compose departure.
        expect(screen.getByRole('heading', { name: /travel/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /compose departure/i })).toBeInTheDocument();
        // The current place is absent from the picker; the candidate is listed.
        const destSelect = screen.getByRole('combobox', { name: /travel destination/i });
        const options = within(destSelect).getAllByRole('option');
        expect(options.map(o => o.textContent)).toEqual([
            expect.stringContaining('Beacon'),
        ]);
        expect(options.every(o => !o.textContent?.includes('Aubergine'))).toBe(true);
    });

    it('shows an explanatory message when no current place is set', () => {
        useAppStore.setState({
            locationLedger: [makePlace('a', 'Aubergine')],
            context: { currentPlaceId: undefined },
        });

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));

        expect(screen.getByText(/No current place set/i)).toBeInTheDocument();
        // The empty state reads in words, not as an empty list.
        expect(screen.getByText(/No departure point/i)).toBeInTheDocument();
        // Compose departure is disabled.
        expect(screen.getByRole('button', { name: /compose departure/i })).toBeDisabled();
    });

    it('shows an explanatory message when there are no connected destinations', () => {
        useAppStore.setState({
            locationLedger: [makePlace('a', 'Aubergine')],
            context: { currentPlaceId: 'a' },
        });

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));

        // The only place in the ledger is the current place — nothing to pick.
        expect(screen.getByText(/No destinations available/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /compose departure/i })).toBeDisabled();
    });

    it('excludes transit nodes from the candidate list', () => {
        const a = makePlace('a', 'Aubergine');
        const transit = makePlace('t', 'Trade Road', { kind: 'transit' });
        const b = makePlace('b', 'Beacon');
        useAppStore.setState({
            locationLedger: [a, transit, b],
            context: { currentPlaceId: 'a' },
        });

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));

        const destSelect = screen.getByRole('combobox', { name: /travel destination/i });
        const options = within(destSelect).getAllByRole('option');
        expect(options.map(o => o.textContent)).toEqual([
            expect.stringContaining('Beacon'),
        ]);
        expect(options.every(o => !o.textContent?.includes('Trade Road'))).toBe(true);
    });

    it('updates the displayed day estimate when the mode changes', () => {
        const a = makePlace('a', 'Aubergine', { connections: [{ toId: 'b', band: 'far' }] });
        const b = makePlace('b', 'Beacon', { connections: [{ toId: 'a', band: 'far' }] });
        useAppStore.setState({
            locationLedger: [a, b],
            context: { currentPlaceId: 'a', travelMode: 'foot' },
        });

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));

        // far = 16–30 grids. On foot (3 grids/day) → 6–10 days. The baseline
        // (on foot) reads identically, so the string appears twice here.
        expect(screen.getAllByText('6–10 days')).toHaveLength(2);

        // Switch to cart (5 grids/day) → 4–6 days. The mode-adjusted estimate
        // updates; the baseline (on foot) stays at 6–10 days.
        fireEvent.change(
            screen.getByRole('combobox', { name: /travel mode/i }),
            { target: { value: 'cart' } },
        );
        expect(screen.getByText('4–6 days')).toBeInTheDocument();
        // The baseline (on foot) is still present.
        expect(screen.getByText('6–10 days')).toBeInTheDocument();
    });

    it('injects the same departure sentence the Places panel produces', () => {
        // The composer path and the modal path both go through composeDeparture,
        // so the injected sentence is byte-identical. We assert on the injected
        // string the store received — both surfaces cannot drift.
        const a = makePlace('a', 'Aubergine', { connections: [{ toId: 'b', band: 'far' }] });
        const b = makePlace('b', 'Beacon', { connections: [{ toId: 'a', band: 'far' }] });
        useAppStore.setState({
            locationLedger: [a, b],
            context: { currentPlaceId: 'a', travelMode: 'foot' },
        });

        const injectSpy = vi.spyOn(useAppStore.getState(), 'injectToComposer');
        const intentSpy = vi.spyOn(useAppStore.getState(), 'setPendingTravelIntent');

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));
        // Default mode is foot (from context.travelMode).
        fireEvent.click(screen.getByRole('button', { name: /compose departure/i }));

        expect(injectSpy).toHaveBeenCalledWith('We set out for Beacon by foot.');
        expect(intentSpy).toHaveBeenCalledWith(expect.objectContaining({
            toId: 'b',
            mode: 'foot',
            agency: 'free',
            injectedText: 'We set out for Beacon by foot.',
        }));

        injectSpy.mockRestore();
        intentSpy.mockRestore();
    });

    it('closes the picker after composing and the composer carries the sentence', () => {
        const a = makePlace('a', 'Aubergine', { connections: [{ toId: 'b', band: 'far' }] });
        const b = makePlace('b', 'Beacon', { connections: [{ toId: 'a', band: 'far' }] });
        useAppStore.setState({
            locationLedger: [a, b],
            context: { currentPlaceId: 'a', travelMode: 'foot' },
        });

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));
        fireEvent.click(screen.getByRole('button', { name: /compose departure/i }));

        // The picker modal is gone.
        expect(screen.queryByRole('heading', { name: /travel/i })).not.toBeInTheDocument();
        // The composer injection carries the departure sentence.
        expect(useAppStore.getState().composerInjection).toBe('We set out for Beacon by foot.');
        expect(useAppStore.getState().pendingTravelIntent).toEqual(expect.objectContaining({
            toId: 'b',
            mode: 'foot',
        }));
    });
});