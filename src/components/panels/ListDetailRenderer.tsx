import { useState } from 'react';
import type { PanelDescriptor } from '@narrative/engine';
import { ListPanelRenderer, type PanelRendererProps } from './ListPanelRenderer';

type PanelRow = Record<string, unknown>;

function displayValue(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/**
 * WO-P5-16 G2 — derive one empty row from a descriptor's `fields`. Mirrors
 * the same helper in `ListPanelRendererCore.tsx`; duplicated rather than
 * imported because the core file is a React module and this detail renderer
 * needs the pure derivation only. Each control seeds one empty value; see
 * the core file for the per-control table.
 */
function emptyRow<TRow extends PanelRow>(descriptor: PanelDescriptor<TRow>): TRow {
    const row: PanelRow = {};
    for (const field of descriptor.fields) {
        let value: unknown;
        switch (field.control) {
            case 'number':
                value = typeof field.min === 'number' && Number.isFinite(field.min) ? field.min : 0;
                break;
            case 'checkbox':
                value = false;
                break;
            case 'tags':
            case 'array':
                value = [];
                break;
            case 'nested-object':
                value = {};
                break;
            default:
                value = '';
        }
        const segments = field.key.split('.');
        if (segments.length === 1) {
            row[segments[0]] = value;
        } else {
            let cursor = row;
            for (let i = 0; i < segments.length - 1; i++) {
                const seg = segments[i];
                const existing = cursor[seg];
                cursor[seg] = existing !== null && typeof existing === 'object' && !Array.isArray(existing)
                    ? { ...(existing as Record<string, unknown>) }
                    : {};
                cursor = cursor[seg] as Record<string, unknown>;
            }
            cursor[segments[segments.length - 1]] = value;
        }
    }
    return row as TRow;
}

export function ListDetailRenderer<TRow extends PanelRow>({
    descriptor,
    rows,
    onRowsChange,
    getRowKey,
}: PanelRendererProps<TRow>) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const selectedRow = rows[selectedIndex];

    const updateSelected = (nextRows: TRow[]) => {
        if (!onRowsChange || selectedRow === undefined) return;
        const nextSelected = nextRows[0];
        if (nextSelected === undefined) return;
        const nextAllRows = [...rows];
        nextAllRows[selectedIndex] = nextSelected;
        onRowsChange(nextAllRows);
    };

    // WO-P5-16 G2 — create appends an empty row (derived from fields); delete
    // removes the selected row. Both call onRowsChange, the same channel
    // update uses. The renderer never branches on which panel it renders.
    const createRow = () => {
        if (!onRowsChange) return;
        onRowsChange([...rows, emptyRow(descriptor)]);
    };
    const deleteSelected = () => {
        if (!onRowsChange || selectedRow === undefined) return;
        const nextRows = [...rows];
        nextRows.splice(selectedIndex, 1);
        onRowsChange(nextRows);
        // Keep the selection clamped to a valid index after the removal.
        setSelectedIndex((prev) => Math.max(0, Math.min(prev, nextRows.length - 1)));
    };

    // The detail pane renders the selected row through the list renderer,
    // but create/delete belong to the list pane (the rows), not the detail
    // pane (one row). Strip them so the nested ListPanelRenderer does not
    // re-render Create/Delete buttons inside the detail editor. The detail
    // pane keeps `update` so the row's fields stay editable.
    const detailDescriptor: PanelDescriptor<TRow> = {
        ...descriptor,
        layout: 'list',
        crud: { ...descriptor.crud, create: false, delete: false },
    };

    return (
        <section data-panel-layout="list-detail">
            <div data-panel-detail-list>
                {(descriptor.crud.create === true || descriptor.crud.delete === true) && (
                    <div data-panel-detail-toolbar>
                        {descriptor.crud.create === true ? (
                            <button
                                type="button"
                                data-panel-create
                                aria-label="Create row"
                                onClick={createRow}
                            >
                                Create
                            </button>
                        ) : null}
                        {descriptor.crud.delete === true && selectedRow !== undefined ? (
                            <button
                                type="button"
                                data-panel-delete={selectedIndex}
                                aria-label={`Delete row ${selectedIndex + 1}`}
                                onClick={deleteSelected}
                            >
                                Delete
                            </button>
                        ) : null}
                    </div>
                )}
                {rows.map((row, index) => (
                    <button
                        type="button"
                        key={getRowKey?.(row, index) ?? String(index)}
                        aria-pressed={index === selectedIndex}
                        onClick={() => setSelectedIndex(index)}
                    >
                        {descriptor.fields.map((field) => displayValue((row as PanelRow)[field.key])).filter(Boolean).join(' · ') || `Row ${index + 1}`}
                    </button>
                ))}
            </div>
            <div data-panel-detail-content>
                {selectedRow === undefined ? (
                    <p>No rows.</p>
                ) : (
                    <ListPanelRenderer
                        descriptor={detailDescriptor}
                        rows={[selectedRow]}
                        onRowsChange={updateSelected}
                    />
                )}
            </div>
        </section>
    );
}
