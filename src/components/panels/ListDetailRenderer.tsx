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

    const detailDescriptor: PanelDescriptor<TRow> = { ...descriptor, layout: 'list' };

    return (
        <section data-panel-layout="list-detail">
            <div data-panel-detail-list>
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
