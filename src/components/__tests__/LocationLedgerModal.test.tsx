import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocationLedgerModal } from '../LocationLedgerModal';
import { normalizeLocationIds } from '../../utils/locationIds';
import { useAppStore } from '../../store/useAppStore';
import type { LocationEntry } from '../../types';

vi.mock('../../services/infrastructure/assetService', () => ({
    uploadImageToLocal: vi.fn(),
    downloadImageToLocal: vi.fn(),
}));
import { uploadImageToLocal } from '../../services/infrastructure/assetService';

function makeLocation(id: string, name: string): LocationEntry {
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
    };
}

function saveNewLocation(name: string) {
    fireEvent.click(screen.getByRole('button', { name: 'New Location' }));
    fireEvent.change(screen.getByPlaceholderText('Ninja Academy'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('LocationLedgerModal', () => {
    it('saves uploaded pictures, preserves them through edits, and removes them', async () => {
        vi.mocked(uploadImageToLocal).mockResolvedValue('/assets/portraits/harbor.png');
        render(<LocationLedgerModal />);
        fireEvent.click(screen.getByRole('button', { name: 'New Location' }));
        fireEvent.change(screen.getByPlaceholderText('Ninja Academy'), { target: { value: 'Harbor' } });
        fireEvent.change(screen.getByLabelText('Upload location picture'), { target: { files: [new File(['image'], 'harbor.png', { type: 'image/png' })] } });
        await screen.findByAltText('Harbor picture');
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(useAppStore.getState().locationLedger[0].image).toBe('/assets/portraits/harbor.png');
        fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
        fireEvent.change(screen.getByPlaceholderText('1-2 sentences of texture.'), { target: { value: 'Busy docks' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(useAppStore.getState().locationLedger[0].image).toBe('/assets/portraits/harbor.png');
        fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
        fireEvent.click(screen.getByRole('button', { name: 'Remove Picture' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        expect(useAppStore.getState().locationLedger[0].image).toBeUndefined();
    });

    it('discards a late upload after switching to another location', async () => {
        let finish!: (value: string) => void;
        vi.mocked(uploadImageToLocal).mockReturnValue(new Promise(resolve => { finish = resolve; }));
        useAppStore.setState({ locationLedger: [makeLocation('a', 'Harbor'), makeLocation('b', 'Forest')] });
        render(<LocationLedgerModal />);
        fireEvent.click(screen.getByText('Harbor'));
        fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
        fireEvent.change(screen.getByLabelText('Upload location picture'), { target: { files: [new File(['image'], 'harbor.png', { type: 'image/png' })] } });
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
        fireEvent.click(screen.getByText('Forest', { selector: 'p' }));
        await act(async () => finish('/assets/portraits/harbor.png'));
        await waitFor(() => expect(screen.queryByAltText('Forest picture')).not.toBeInTheDocument());
        expect(useAppStore.getState().locationLedger.every(location => !location.image)).toBe(true);
    });

    beforeEach(() => {
        useAppStore.setState({
            locationLedgerOpen: true,
            locationLedger: [],
        });
    });

    afterEach(() => {
        cleanup();
        useAppStore.setState({
            locationLedgerOpen: false,
            locationLedger: [],
        });
    });

    it('keeps the saved place selected after creating and connecting two places', () => {
        render(<LocationLedgerModal />);

        saveNewLocation('Point A');

        expect(screen.getByText('No connections recorded.')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Location Details' })).toBeInTheDocument();

        saveNewLocation('Point B');
        expect(screen.getByRole('heading', { name: 'Location Details' })).toBeInTheDocument();

        fireEvent.click(screen.getByText('Point A'));
        fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
        fireEvent.change(screen.getByDisplayValue('Select location...'), { target: { value: useAppStore.getState().locationLedger.find(location => location.name === 'Point B')?.id } });
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(screen.getByRole('heading', { name: 'Location Details' })).toBeInTheDocument();
        expect(screen.getAllByText('Point B')).toHaveLength(2);

        const pointA = useAppStore.getState().locationLedger.find(location => location.name === 'Point A');
        const pointB = useAppStore.getState().locationLedger.find(location => location.name === 'Point B');
        expect(pointA?.id).toBeTruthy();
        expect(pointB?.id).toBeTruthy();
        expect(pointA?.id).not.toBe(pointB?.id);
        expect(pointA?.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ toId: pointB?.id }),
        ]));
        expect(pointB?.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ toId: pointA?.id }),
        ]));

    });


    it('propagates a selected band onto an existing reciprocal connection', () => {
        render(<LocationLedgerModal />);

        saveNewLocation('Point A');
        saveNewLocation('Point B');

        const pointA = useAppStore.getState().locationLedger.find(location => location.name === 'Point A')!;
        const pointB = useAppStore.getState().locationLedger.find(location => location.name === 'Point B')!;
        useAppStore.getState().updateLocation(pointB.id, {
            connections: [{ toId: pointA.id, band: 'local' }],
        });

        fireEvent.click(screen.getByText('Point A'));
        fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
        // The form has multiple selects (Kind, connection place, connection
        // band, ...). Locate the connection selects by the options they
        // present rather than by positional index, so adding a new select
        // elsewhere in the form does not shift these.
        const allSelects = screen.getAllByRole('combobox');
        const placeSelect = allSelects.find(select => {
            const options = [...select.querySelectorAll('option')];
            return options.some(opt => opt.textContent === 'Point B');
        })!;
        const bandSelect = allSelects.find(select => {
            const options = [...select.querySelectorAll('option')];
            return options.some(opt => opt.textContent?.includes('regional'));
        })!;
        fireEvent.change(placeSelect, { target: { value: pointB.id } });
        fireEvent.change(bandSelect, { target: { value: 'regional' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        const updatedPointB = useAppStore.getState().locationLedger.find(location => location.id === pointB.id)!;
        expect(updatedPointB.connections).toEqual(expect.arrayContaining([
            expect.objectContaining({ toId: pointA.id, band: 'regional' }),
        ]));
    });
    it('removes a connection from the existing reciprocal location', () => {
        render(<LocationLedgerModal />);

        saveNewLocation('Point A');
        saveNewLocation('Point B');

        const pointB = useAppStore.getState().locationLedger.find(location => location.name === 'Point B')!;
        fireEvent.click(screen.getByText('Point A'));
        fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
        fireEvent.change(screen.getByDisplayValue('Select location...'), { target: { value: pointB.id } });
        fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
        fireEvent.click(screen.getByRole('button', { name: 'Remove connection to Point B' }));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        const pointAAfter = useAppStore.getState().locationLedger.find(location => location.name === 'Point A')!;
        const pointBAfter = useAppStore.getState().locationLedger.find(location => location.name === 'Point B')!;
        expect(pointAAfter.connections.some(connection => connection.toId === pointBAfter.id)).toBe(false);
        expect(pointBAfter.connections.some(connection => connection.toId === pointAAfter.id)).toBe(false);
    });
    it('repairs legacy blank IDs so existing places can be selected', () => {
        const locations = normalizeLocationIds([makeLocation('', 'Point A'), makeLocation('', 'Point B')]);
        useAppStore.setState({ locationLedger: locations });
        render(<LocationLedgerModal />);
        expect(locations.every(location => location.id)).toBe(true);
        expect(new Set(locations.map(location => location.id)).size).toBe(2);

        fireEvent.click(screen.getAllByText('Point A')[0]);
        expect(screen.getByRole('heading', { name: 'Location Details' })).toBeInTheDocument();
    });

    // WO 3.1 — Travel discoverability. The travel control on each row must be
    // visible without hover, reachable by keyboard, and produce a departure
    // sentence byte-identical to the composer TRAVEL button's output (the two
    // surfaces share `composeDeparture`, so they cannot drift).
    it('shows the Travel button on a non-current row without any hover interaction', () => {
        const a = makeLocation('a', 'Point A');
        const b = makeLocation('b', 'Point B');
        useAppStore.setState({
            locationLedger: [a, b],
            context: { currentPlaceId: 'a' },
        });
        render(<LocationLedgerModal />);

        // The Travel control on Point B's row is a labelled button, present
        // in the DOM without any hover interaction, and not disabled.
        const travelBtn = screen.getByRole('button', { name: /travel to point b/i });
        expect(travelBtn).toBeVisible();
        expect(travelBtn).not.toHaveAttribute('disabled');
        // It carries the Compass glyph + "Travel" text label (not a bare glyph).
        expect(travelBtn.textContent).toMatch(/travel/i);

        // The current place row does not show a Travel button.
        expect(screen.queryByRole('button', { name: /travel to point a/i })).not.toBeInTheDocument();
    });

    it('WO 6.5 — departs directly: sets context.travel, no composer injection, no pending intent', () => {
        const a = makeLocation('a', 'Point A');
        const b = makeLocation('b', 'Point B');
        useAppStore.setState({
            locationLedger: [a, b],
            context: { currentPlaceId: 'a', travelMode: 'foot' },
            messages: [],
        });

        render(<LocationLedgerModal />);
        fireEvent.click(screen.getByRole('button', { name: /travel to point b/i }));
        // Default mode is foot (from context.travelMode). Depart.
        fireEvent.click(screen.getByRole('button', { name: /depart/i }));

        // WO 6.5 — direct departure: context.travel is set immediately.
        const ctx = useAppStore.getState().context;
        expect(ctx.travel).not.toBeNull();
        expect(ctx.travel!.toId).toBe('b');
        expect(ctx.travel!.mode).toBe('foot');
        expect(ctx.travel!.leg).toBe(1);
        // No composer injection — travel is an engine action.
        expect(useAppStore.getState().composerInjection).toBeNull();
        // A checkpoint system message was posted.
        const messages = useAppStore.getState().messages;
        const checkpointMsg = messages.find(m => m.name === 'travel-checkpoint');
        expect(checkpointMsg).toBeDefined();
        expect(checkpointMsg!.content).toContain('Point B');
    });
});

it('keeps travel records accessible without filling the default sidebar', () => {
    const road = { ...makeLocation('road','Road between A and B'), kind:'transit' as const, recordKind:'route' as const };
    const point = { ...makeLocation('point','Exploration point (5, 7)'), recordKind:'position' as const, coordinates:{x:5,y:7} };
    const inn = { ...makeLocation('inn','Road between C and D'), kind:'transit' as const, features:['An old inn'] };
    useAppStore.setState({locationLedgerOpen:true, locationLedger:[road,point,inn,makeLocation('town','Town')],context:{}});
    render(<LocationLedgerModal />);
    expect(screen.queryByText(road.name)).not.toBeInTheDocument();
    expect(screen.queryByText(point.name)).not.toBeInTheDocument();
    expect(screen.getByText(inn.name)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show travel records'));
    fireEvent.click(screen.getByText(point.name));
    expect(screen.getByText('Map coordinates: 5, 7')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Edit world',exact:true}));
    fireEvent.click(screen.getByLabelText('Pin in locations'));
    fireEvent.click(screen.getByRole('button',{name:'Save',exact:true}));
    fireEvent.click(screen.getByLabelText('Show travel records'));
    expect(screen.getByText(point.name)).toBeInTheDocument();
    expect(useAppStore.getState().locationLedger).toHaveLength(4);
    expect(useAppStore.getState().locationLedger.find(row=>row.id==='point')?.coordinates).toEqual({x:5,y:7});
    cleanup(); useAppStore.setState({locationLedgerOpen:false,locationLedger:[]});
});

it('requires world editing for position correction without spending time', () => {
    useAppStore.setState({ locationLedgerOpen: true, locationLedger: [makeLocation('a', 'Alder'), makeLocation('b', 'Birch')],
        context: { currentPlaceId: 'a', worldDay: 8, travel: null } });
    render(<LocationLedgerModal />);
    fireEvent.click(screen.getByText('Birch'));
    expect(screen.queryByRole('button', { name: 'Correct player position here' })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Set as current location')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
    fireEvent.click(screen.getByRole('button', { name: 'Correct player position here' }));
    expect(useAppStore.getState().context).toMatchObject({ currentPlaceId: 'b', worldDay: 8, travel: null });
});

it('saves outbound tunnel and portal authoring without moving the player', () => {
    const a = makeLocation('a', 'Entrance'); const b = makeLocation('b', 'Exit');
    a.connections = [{ toId: 'b', band: 'remote' }];
    useAppStore.setState({ locationLedgerOpen: true, locationLedger: [a,b], context: { currentPlaceId: 'a', worldDay: 8 } });
    render(<LocationLedgerModal />);
    fireEvent.click(screen.getByText('Entrance', { selector: 'p' }));
    expect(screen.queryByLabelText('Outbound passage to Exit')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
    fireEvent.change(screen.getByLabelText('Outbound passage to Exit'), { target: { value: 'tunnel' } });
    fireEvent.change(screen.getByLabelText('Tunnel minutes to Exit'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useAppStore.getState().locationLedger[0].connections[0]).toMatchObject({ passage: 'tunnel', durationMinutes: 120 });
    fireEvent.click(screen.getByRole('button', { name: 'Edit world' }));
    fireEvent.change(screen.getByLabelText('Outbound passage to Exit'), { target: { value: 'portal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(useAppStore.getState().locationLedger[0].connections[0]).toMatchObject({ passage: 'portal' });
    expect(useAppStore.getState().locationLedger[1].connections).toEqual([]);
    expect(useAppStore.getState().context).toMatchObject({ currentPlaceId: 'a', worldDay: 8 });
});
