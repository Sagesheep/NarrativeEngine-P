/**
 * WO-P5-16 Step 1 — G1 (numeric clamp) + G3 (sort direction).
 *
 * The G1 clamp test is the one 4.2's characterisation oracle got wrong. The
 * The former bespoke enemy renderer test types
 * `-7abc`, which a `type="number"` input flattens to `''`, so `Number('')` is
 * `0` on BOTH the bespoke (`Math.max(0, Number(v) || 0)`) and the generic
 * (`Number(event.target.value)`) paths. The test passed by coincidence
 * (09_PANEL_PROOF.md §11.3). Typing `-5` — a value a `type="number"` input
 * actually accepts — exposes the gap: the bespoke stored `0`, the 4.1 generic
 * stored `-5`.
 *
 * These tests are renderer-level, not panel-name-level. They run the same
 * descriptor through the same renderer with no host wrapper and assert the
 * clamped/sorted output. The renderer never branches on which panel it
 * renders (4.1's opaque-id rule, extended by WO-P5-16 §4).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PanelDescriptor } from '@narrative/engine';
import { PanelRenderer } from '../PanelRenderer';

type NumRow = { count: number };
type SortedRow = { name: string; createdAt: number };

const numDescriptor = (over: Partial<PanelDescriptor<NumRow>> = {}): PanelDescriptor<NumRow> => ({
    id: 'clamp-probe',
    bindsTo: 'rows',
    launch: 'tab',
    layout: 'list',
    fields: [{ key: 'count', label: 'Count', control: 'number', min: 0 }],
    crud: { read: true, update: true },
    ...over,
});

const sortDescriptor = (sort: PanelDescriptor<SortedRow>['sort']): PanelDescriptor<SortedRow> => ({
    id: 'sort-probe',
    bindsTo: 'rows',
    launch: 'tab',
    layout: 'list',
    fields: [
        { key: 'name', label: 'Name', control: 'text' },
        { key: 'createdAt', label: 'Created', control: 'number' },
    ],
    crud: { read: true },
    sort,
});

/** Set a number input atomically — `user.type` types char-by-char and a
 *  `type="number"` input drops intermediate `-` events, which muddies the
 *  clamp assertion. `fireEvent.change` models a single paste, like the 4.2
 *  characterisation tests do for textarea values. */
const setNumberValue = (input: HTMLElement, value: string) => {
    fireEvent.change(input, { target: { value } });
};

describe('PanelRenderer — G1 numeric clamp', () => {
    it('clamps a typed -5 to 0 when min: 0 is declared (the -7abc test 4.2 got wrong)', () => {
        const onRowsChange = vi.fn();
        render(
            <PanelRenderer
                descriptor={numDescriptor()}
                rows={[{ count: 10 }]}
                onRowsChange={onRowsChange}
            />,
        );

        const input = screen.getByLabelText('Count');
        // -5 is a value a type="number" input actually accepts. The bespoke
        // `Math.max(0, Number(-5) || 0)` stored 0; the 4.1 generic's bare
        // `Number(-5)` stored -5. The clamp must restore the bespoke behaviour.
        setNumberValue(input, '-5');

        expect(onRowsChange).toHaveBeenLastCalledWith([expect.objectContaining({ count: 0 })]);
    });

    it('clamps an empty box to the declared min (or 0 when no min)', () => {
        const onRowsChange = vi.fn();
        render(
            <PanelRenderer
                descriptor={numDescriptor({ fields: [{ key: 'count', label: 'Count', control: 'number', min: 3 }] })}
                rows={[{ count: 10 }]}
                onRowsChange={onRowsChange}
            />,
        );

        const input = screen.getByLabelText('Count');
        setNumberValue(input, '');

        // Empty -> NaN; the clamp yields the declared min, not -Infinity.
        expect(onRowsChange).toHaveBeenLastCalledWith([expect.objectContaining({ count: 3 })]);
    });

    it('yields 0 for an empty box when no min is declared (legacy default)', () => {
        const onRowsChange = vi.fn();
        render(
            <PanelRenderer
                descriptor={numDescriptor({ fields: [{ key: 'count', label: 'Count', control: 'number' }] })}
                rows={[{ count: 10 }]}
                onRowsChange={onRowsChange}
            />,
        );

        const input = screen.getByLabelText('Count');
        setNumberValue(input, '');

        expect(onRowsChange).toHaveBeenLastCalledWith([expect.objectContaining({ count: 0 })]);
    });

    it('clamps a value above the declared max', () => {
        const onRowsChange = vi.fn();
        render(
            <PanelRenderer
                descriptor={numDescriptor({ fields: [{ key: 'count', label: 'Count', control: 'number', min: 0, max: 100 }] })}
                rows={[{ count: 10 }]}
                onRowsChange={onRowsChange}
            />,
        );

        const input = screen.getByLabelText('Count');
        setNumberValue(input, '999');

        expect(onRowsChange).toHaveBeenLastCalledWith([expect.objectContaining({ count: 100 })]);
    });

    it('preserves a finite value inside the declared bounds (no clamp)', () => {
        const onRowsChange = vi.fn();
        render(
            <PanelRenderer
                descriptor={numDescriptor()}
                rows={[{ count: 10 }]}
                onRowsChange={onRowsChange}
            />,
        );

        const input = screen.getByLabelText('Count');
        setNumberValue(input, '42');

        expect(onRowsChange).toHaveBeenLastCalledWith([expect.objectContaining({ count: 42 })]);
    });

    it('NaN cannot escape: -7abc flattens to "" then clamps to the declared min', () => {
        const onRowsChange = vi.fn();
        render(
            <PanelRenderer
                descriptor={numDescriptor()}
                rows={[{ count: 10 }]}
                onRowsChange={onRowsChange}
            />,
        );

        const input = screen.getByLabelText('Count');
        // -7abc: a type="number" input flattens this to "" (the original 4.2
        // coincidence case). The clamp must still produce 0, not NaN.
        setNumberValue(input, '-7abc');

        // Whether the input yields "" (->0) or -7 (->0 via the min clamp), the
        // result is 0. This is the case 4.2's oracle could not distinguish.
        const lastCall = onRowsChange.mock.calls.at(-1)?.[0]?.[0];
        expect(lastCall.count).toBe(0);
    });
});

describe('PanelRenderer — G3 sort direction', () => {
    it('sorts ascending for a bare string (4.1 descriptors unchanged)', () => {
        const rows: SortedRow[] = [
            { name: 'Beta', createdAt: 200 },
            { name: 'Alpha', createdAt: 100 },
        ];
        const { container } = render(<PanelRenderer descriptor={sortDescriptor('createdAt')} rows={rows} />);
        // Rows are rendered with `data-panel-row={rowIndex}`; the row's input
        // values (not textContent) carry the field data, because read-only
        // fields render as disabled inputs whose value lives in the `value`
        // attribute, not in textContent.
        const rowInputs = [...container.querySelectorAll('[data-panel-row]')].map(
            (row) => (row.querySelector('input[type="text"]') as HTMLInputElement)?.value ?? '',
        );
        // Ascending: Alpha (100) first, Beta (200) second.
        expect(rowInputs).toEqual(['Alpha', 'Beta']);
        // The toolbar surfaces the field and the resolved direction.
        expect(screen.getByText('Sorted by createdAt')).toBeInTheDocument();
        expect(container.querySelector('[data-panel-sort]')).toHaveAttribute('data-panel-sort-direction', 'asc');
    });

    it('sorts descending when direction: "desc" is declared', () => {
        const rows: SortedRow[] = [
            { name: 'Old', createdAt: 100 },
            { name: 'New', createdAt: 900 },
            { name: 'Mid', createdAt: 500 },
        ];
        const { container } = render(
            <PanelRenderer
                descriptor={sortDescriptor({ field: 'createdAt', direction: 'desc' })}
                rows={rows}
            />,
        );
        const rowInputs = [...container.querySelectorAll('[data-panel-row]')].map(
            (row) => (row.querySelector('input[type="text"]') as HTMLInputElement)?.value ?? '',
        );
        // Descending: New (900), Mid (500), Old (100).
        expect(rowInputs).toEqual(['New', 'Mid', 'Old']);
        expect(container.querySelector('[data-panel-sort]')).toHaveAttribute('data-panel-sort-direction', 'desc');
    });

    it('treats a SortSpec with no direction as ascending', () => {
        const rows: SortedRow[] = [
            { name: 'Beta', createdAt: 200 },
            { name: 'Alpha', createdAt: 100 },
        ];
        const { container } = render(
            <PanelRenderer descriptor={sortDescriptor({ field: 'createdAt' })} rows={rows} />,
        );
        const rowInputs = [...container.querySelectorAll('[data-panel-row]')].map(
            (row) => (row.querySelector('input[type="text"]') as HTMLInputElement)?.value ?? '',
        );
        expect(rowInputs).toEqual(['Alpha', 'Beta']);
        expect(container.querySelector('[data-panel-sort]')).toHaveAttribute('data-panel-sort-direction', 'asc');
    });
});