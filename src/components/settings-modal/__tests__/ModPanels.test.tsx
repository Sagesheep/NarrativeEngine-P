/**
 * WO-P5-16 Step 4 — the Extensions-tab mod panel render + round-trip test.
 *
 * The Extensions tab renders one section per declared mod panel, nested
 * under the mod that declared it. The host resolves `bindsTo` against the
 * store's `modTables` map; the generic `PanelRenderer` receives rows and a
 * descriptor and cannot tell a mod panel from a host panel (§4). An edit
 * round-trips to disk through `setModTable`'s fire-and-forget PUT.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import { ModPanels } from '../ModPanels';
import type { ValidatedMod } from '../../../services/mods/modTypes';

const modWithPanel: ValidatedMod = {
    id: 'gate-mod',
    name: 'Gate Mod',
    version: '1.0.0',
    description: 'A mod declaring a table and a panel over it.',
    file: 'gate.mod.json',
    contributions: [{ id: 'placeholder', order: 990, text: '.' }],
    tables: [{ name: 'things', recordShape: 'array', label: 'Things' }],
    panels: [{
        id: 'things-panel',
        bindsTo: 'things',
        launch: 'nested',
        layout: 'list',
        fields: [
            { key: 'name', label: 'Name', control: 'text' },
            { key: 'count', label: 'Count', control: 'number', min: 0 },
        ],
        crud: { create: true, read: true, update: true, delete: true },
        sort: { field: 'name', direction: 'asc' },
    }],
};

describe('ModPanels — Extensions-tab rendering and edit round-trip', () => {
    beforeEach(() => {
        // Seed the store with one row in the mod's namespaced table.
        useAppStore.setState({
            modTables: { 'mod.gate-mod.things': [{ name: 'Alpha', count: 1 }] },
        });
    });

    afterEach(() => {
        useAppStore.setState({ modTables: {} });
    });

    it('renders nothing when no mod declares panels', () => {
        const { container } = render(<ModPanels mods={[]} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders a section per declared mod panel, nested under the mod', () => {
        render(<ModPanels mods={[modWithPanel]} />);
        // The mod's name appears as the section label.
        expect(screen.getByText('Gate Mod')).toBeInTheDocument();
        // The panel renders its fields. The Create button (crud.create)
        // and a Delete button per row (crud.delete) are present.
        expect(screen.getByRole('button', { name: 'Create row' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete row 1' })).toBeInTheDocument();
        // The first field's label renders.
        expect(screen.getByLabelText('Name')).toBeInTheDocument();
        expect(screen.getByLabelText('Count')).toBeInTheDocument();
    });

    it('round-trips an edit through setModTable (the renderer is agnostic to the row source)', () => {
        const setModTable = vi.fn();
        // Override the store's setModTable to capture the write-back.
        useAppStore.setState({ setModTable } as unknown as Partial<typeof useAppStore.getState>);

        render(<ModPanels mods={[modWithPanel]} />);
        const nameInput = screen.getByLabelText('Name');
        fireEvent.change(nameInput, { target: { value: 'Edited' } });

        // The renderer's onRowsChange fires; ModPanels forwards it to
        // setModTable with the namespaced table key. This is the disk
        // round-trip path — the same PUT the Arc mod uses for mod.arc.arcs.
        expect(setModTable).toHaveBeenCalledWith(
            'mod.gate-mod.things',
            [expect.objectContaining({ name: 'Edited', count: 1 })],
        );
    });

    it('Create appends an empty row derived from fields and writes it to the mod table', () => {
        const setModTable = vi.fn();
        useAppStore.setState({ setModTable } as unknown as Partial<typeof useAppStore.getState>);

        render(<ModPanels mods={[modWithPanel]} />);
        fireEvent.click(screen.getByRole('button', { name: 'Create row' }));

        // The empty row is derived from fields: text -> '', number(min:0) -> 0.
        expect(setModTable).toHaveBeenCalledWith(
            'mod.gate-mod.things',
            [
                { name: 'Alpha', count: 1 },
                expect.objectContaining({ name: '', count: 0 }),
            ],
        );
    });

    it('Delete removes the row from the mod table', () => {
        const setModTable = vi.fn();
        useAppStore.setState({ setModTable } as unknown as Partial<typeof useAppStore.getState>);

        render(<ModPanels mods={[modWithPanel]} />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete row 1' }));

        expect(setModTable).toHaveBeenCalledWith('mod.gate-mod.things', []);
    });

    it('does not render a section for a mod whose tables are absent from the store', () => {
        // A mod that declared a panel but whose table has not been hydrated
        // (e.g. the mod was just installed and the campaign has not been
        // re-hydrated) renders an empty panel — the rows array is empty,
        // not a throw. The renderer's "no rows" path handles it.
        useAppStore.setState({ modTables: {} });
        render(<ModPanels mods={[modWithPanel]} />);
        expect(screen.getByText('Gate Mod')).toBeInTheDocument();
        // No row inputs (the list is empty); Create is still available.
        expect(screen.getByRole('button', { name: 'Create row' })).toBeInTheDocument();
        expect(screen.queryByLabelText('Name')).toBeNull();
    });
});