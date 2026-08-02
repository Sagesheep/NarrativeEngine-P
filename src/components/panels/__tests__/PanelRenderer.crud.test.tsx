/**
 * WO-P5-16 Step 2 — G2: `crud` renders affordances, not just permission.
 *
 * 4.2's proof found that `crud.create`/`crud.delete` are capability flags,
 * not rendering declarations — every create and delete button lived in the
 * host wrapper (09_PANEL_PROOF.md §5.2). A mod has no wrapper, so a mod's
 * create and delete do not exist. These tests prove the renderer now renders
 * them from `crud`, with the new row derived from `fields` (no `newRow`
 * field on the descriptor).
 *
 * The renderer never branches on which panel it renders (4.1's opaque-id
 * rule, extended by WO-P5-16 §4). The create/delete UI is a pure function
 * of `crud` and `fields`, like every other declared affordance.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PanelDescriptor } from '@narrative/engine';
import { PanelRenderer } from '../PanelRenderer';

type Row = {
    name: string;
    count: number;
    enabled: boolean;
    tags: string[];
    nested: { value: string };
};

const listDescriptor = (over: Partial<PanelDescriptor<Row>> = {}): PanelDescriptor<Row> => ({
    id: 'crud-probe',
    bindsTo: 'rows',
    launch: 'tab',
    layout: 'list',
    fields: [
        { key: 'name', label: 'Name', control: 'text' },
        { key: 'count', label: 'Count', control: 'number', min: 0 },
        { key: 'enabled', label: 'Enabled', control: 'checkbox' },
        { key: 'tags', label: 'Tags', control: 'tags' },
        { key: 'nested.value', label: 'Nested', control: 'text' },
    ],
    crud: { read: true, update: true, create: true, delete: true },
    ...over,
});

const listDetailDescriptor = (over: Partial<PanelDescriptor<Row>> = {}): PanelDescriptor<Row> => ({
    ...listDescriptor(),
    layout: 'list-detail',
    ...over,
});

const seed: Row = {
    name: 'Alpha',
    count: 2,
    enabled: true,
    tags: ['one'],
    nested: { value: 'deep' },
};

describe('PanelRenderer — G2 create/delete affordances (list layout)', () => {
    it('renders a Create button when crud.create is declared', () => {
        render(<PanelRenderer descriptor={listDescriptor()} rows={[seed]} />);
        expect(screen.getByRole('button', { name: 'Create row' })).toBeInTheDocument();
    });

    it('renders no Create button when crud.create is false', () => {
        render(
            <PanelRenderer
                descriptor={listDescriptor({ crud: { read: true, update: true, delete: true } })}
                rows={[seed]}
            />,
        );
        expect(screen.queryByRole('button', { name: 'Create row' })).toBeNull();
    });

    it('renders a Delete button per row when crud.delete is declared', () => {
        render(<PanelRenderer descriptor={listDescriptor()} rows={[seed, { ...seed, name: 'Beta' }]} />);
        // Two rows → two Delete buttons, indexed for aria-label uniqueness.
        expect(screen.getByRole('button', { name: 'Delete row 1' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete row 2' })).toBeInTheDocument();
    });

    it('renders no Delete button when crud.delete is false', () => {
        render(
            <PanelRenderer
                descriptor={listDescriptor({ crud: { read: true, update: true, create: true } })}
                rows={[seed]}
            />,
        );
        expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull();
    });

    it('Create appends an empty row derived from fields, with no newRow declaration', async () => {
        const user = userEvent.setup();
        const onRowsChange = vi.fn();
        render(<PanelRenderer descriptor={listDescriptor()} rows={[seed]} onRowsChange={onRowsChange} />);

        await user.click(screen.getByRole('button', { name: 'Create row' }));

        // The new row carries one empty value per control, derived from the
        // control kind — NOT a declared `newRow`:
        //   text → '', number(min:0) → 0, checkbox → false, tags → [],
        //   nested-object path → { value: '' }
        expect(onRowsChange).toHaveBeenLastCalledWith([
            seed,
            expect.objectContaining({
                name: '',
                count: 0,
                enabled: false,
                tags: [],
                nested: { value: '' },
            }),
        ]);
    });

    it('seeds number with the declared min, not 0', async () => {
        const user = userEvent.setup();
        const onRowsChange = vi.fn();
        const descriptor = listDescriptor({
            fields: [{ key: 'count', label: 'Count', control: 'number', min: 5 }],
            crud: { read: true, create: true },
        });
        render(<PanelRenderer descriptor={descriptor} rows={[]} onRowsChange={onRowsChange} />);

        await user.click(screen.getByRole('button', { name: 'Create row' }));

        expect(onRowsChange).toHaveBeenLastCalledWith([expect.objectContaining({ count: 5 })]);
    });

    it('Delete removes the matching row from the source array', async () => {
        const user = userEvent.setup();
        const onRowsChange = vi.fn();
        const beta = { ...seed, name: 'Beta' };
        render(
            <PanelRenderer
                descriptor={listDescriptor()}
                rows={[seed, beta]}
                onRowsChange={onRowsChange}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'Delete row 1' }));

        // The first visible row (Alpha) is removed; Beta remains.
        expect(onRowsChange).toHaveBeenLastCalledWith([beta]);
    });

    it('Delete on a row does not also fire the row select handler', async () => {
        const user = userEvent.setup();
        const onSelectRow = vi.fn();
        const onRowsChange = vi.fn();
        render(
            <PanelRenderer
                descriptor={listDescriptor()}
                rows={[seed]}
                onRowsChange={onRowsChange}
                onSelectRow={onSelectRow}
            />,
        );

        await user.click(screen.getByRole('button', { name: 'Delete row 1' }));

        // The delete button stops propagation so the row's onClick (select)
        // does not fire. A delete is not also a select.
        expect(onSelectRow).not.toHaveBeenCalled();
    });

    it('create and delete are no-ops without onRowsChange (read-only host)', async () => {
        const user = userEvent.setup();
        // No onRowsChange passed — the renderer must not throw.
        render(<PanelRenderer descriptor={listDescriptor()} rows={[seed]} />);

        await user.click(screen.getByRole('button', { name: 'Create row' }));
        await user.click(screen.getByRole('button', { name: 'Delete row 1' }));
        // No throw is the assertion. The row is still there.
        expect(screen.getByRole('button', { name: 'Delete row 1' })).toBeInTheDocument();
    });
});

describe('PanelRenderer — G2 create/delete affordances (list-detail layout)', () => {
    it('renders Create and Delete buttons in the list pane when declared', () => {
        render(<PanelRenderer descriptor={listDetailDescriptor()} rows={[seed]} />);
        expect(screen.getByRole('button', { name: 'Create row' })).toBeInTheDocument();
        // Selected row 0 exists, so the Delete button is rendered.
        expect(screen.getByRole('button', { name: 'Delete row 1' })).toBeInTheDocument();
    });

    it('Create appends an empty row derived from fields', async () => {
        const user = userEvent.setup();
        const onRowsChange = vi.fn();
        render(<PanelRenderer descriptor={listDetailDescriptor()} rows={[seed]} onRowsChange={onRowsChange} />);

        await user.click(screen.getByRole('button', { name: 'Create row' }));

        expect(onRowsChange).toHaveBeenLastCalledWith([
            seed,
            expect.objectContaining({
                name: '',
                count: 0,
                enabled: false,
                tags: [],
                nested: { value: '' },
            }),
        ]);
    });

    it('Delete removes the selected row', async () => {
        const user = userEvent.setup();
        const onRowsChange = vi.fn();
        const beta = { ...seed, name: 'Beta' };
        render(
            <PanelRenderer
                descriptor={listDetailDescriptor()}
                rows={[seed, beta]}
                onRowsChange={onRowsChange}
            />,
        );

        // Row 0 (Alpha) is selected by default; Delete removes it.
        await user.click(screen.getByRole('button', { name: 'Delete row 1' }));

        expect(onRowsChange).toHaveBeenLastCalledWith([beta]);
    });

    it('Delete hides when no row is selected (empty list)', () => {
        render(<PanelRenderer descriptor={listDetailDescriptor()} rows={[]} />);
        expect(screen.queryByRole('button', { name: /Delete row/ })).toBeNull();
    });
});