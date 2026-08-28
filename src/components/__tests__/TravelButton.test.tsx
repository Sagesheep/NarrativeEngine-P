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
            context: { currentPlaceId: undefined, travelMode: undefined, travel: null, worldDay: undefined },
        });
    });

    it('renders a Travel button in the composer strip', () => {
        render(<TravelButton />);
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

        expect(screen.getByRole('heading', { name: /travel/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /depart/i })).toBeInTheDocument();
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
        expect(screen.getByText(/No departure point/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /depart/i })).toBeDisabled();
    });

    it('shows an explanatory message when there are no connected destinations', () => {
        useAppStore.setState({
            locationLedger: [makePlace('a', 'Aubergine')],
            context: { currentPlaceId: 'a' },
        });

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));

        expect(screen.getByText(/No destinations available/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /depart/i })).toBeDisabled();
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

    it('WO 6.5 — departs directly on confirm: sets context.travel, no LLM, no composer injection', () => {
        const a = makePlace('a', 'Aubergine', { connections: [{ toId: 'b', band: 'far' }] });
        const b = makePlace('b', 'Beacon', { connections: [{ toId: 'a', band: 'far' }] });
        useAppStore.setState({
            locationLedger: [a, b],
            context: { currentPlaceId: 'a', travelMode: 'foot' },
        });

        render(<TravelButton />);
        fireEvent.click(screen.getByRole('button', { name: /travel/i }));
        fireEvent.click(screen.getByRole('button', { name: /depart/i }));

        // The picker modal is gone.
        expect(screen.queryByRole('heading', { name: /travel/i })).not.toBeInTheDocument();
        // context.travel is set — the engine departed.
        const ctx = useAppStore.getState().context;
        expect(ctx.travel).not.toBeNull();
        expect(ctx.travel!.toId).toBe('b');
        expect(ctx.travel!.leg).toBe(1);
        // WO 6.5: the day advanced (first press = camp 1 = day + 1).
        expect(ctx.worldDay).toBe(1);
        // No composer injection — travel is an engine action.
        expect(useAppStore.getState().composerInjection).toBeNull();
    });

    it('WO 6.5 — shows Day N button label when a journey is active and advances on click', () => {
        const a = makePlace('a', 'Aubergine', { connections: [{ toId: 'b', band: 'far' }] });
        const b = makePlace('b', 'Beacon', { connections: [{ toId: 'a', band: 'far' }] });
        useAppStore.setState({
            locationLedger: [a, b],
            context: {
                currentPlaceId: 'a',
                travelMode: 'foot',
                travel: {
                    fromId: 'a', toId: 'b', transitId: 't1', mode: 'foot',
                    leg: 1, totalLegs: 3, agency: 'free',
                },
                worldDay: 5,
            },
        });

        render(<TravelButton />);
        // The label names the act, not the date it happens to advance to:
        // the player is pressing "keep going", not pressing a Tuesday. The
        // camp count moved to the tooltip, where there is room for it.
        const btn = screen.getByRole('button', { name: /continue/i });
        expect(btn).toBeInTheDocument();
        expect(btn).toHaveAttribute('title', expect.stringContaining('camp 2 of 3'));

        fireEvent.click(btn);
        // The leg advanced.
        const ctx = useAppStore.getState().context;
        expect(ctx.travel!.leg).toBe(2);
        expect(ctx.worldDay).toBe(6);
    });

    it('WO 6.5 — shows Arrive label on the last leg', () => {
        const a = makePlace('a', 'Aubergine');
        const b = makePlace('b', 'Beacon');
        useAppStore.setState({
            locationLedger: [a, b],
            context: {
                currentPlaceId: 't1',
                travel: {
                    fromId: 'a', toId: 'b', transitId: 't1', mode: 'foot',
                    leg: 3, totalLegs: 3, agency: 'free',
                },
                worldDay: 7,
            },
        });

        render(<TravelButton />);
        const btn = screen.getByRole('button', { name: /arrive/i });
        expect(btn).toBeInTheDocument();

        fireEvent.click(btn);
        // Arrived — travel is cleared, currentPlaceId is the destination.
        const ctx = useAppStore.getState().context;
        expect(ctx.travel).toBeNull();
        expect(ctx.currentPlaceId).toBe('b');
        expect(ctx.worldDay).toBe(8);
    });
});