import { useMemo, useState } from 'react';
import type { PanelControl, PanelDescriptor, PanelInputControl, PanelOption } from '@narrative/engine';

type PanelRow = Record<string, unknown>;

interface RenderField {
    key: string;
    label?: string;
    description?: string;
    placeholder?: string;
    options?: PanelOption[];
    control: PanelControl;
}

export interface PanelRendererProps<TRow extends PanelRow = PanelRow> {
    descriptor: PanelDescriptor<TRow>;
    rows: readonly TRow[];
    onRowsChange?: (rows: TRow[]) => void;
    onSelectRow?: (row: TRow, index: number) => void;
    getRowKey?: (row: TRow, index: number) => string;
    className?: string;
}

function readPath(row: PanelRow, path: string): unknown {
    return path.split('.').reduce<unknown>((value, segment) => {
        if (value === null || typeof value !== 'object') return undefined;
        return (value as Record<string, unknown>)[segment];
    }, row);
}

function writePath<TRow extends PanelRow>(row: TRow, path: string, nextValue: unknown): TRow {
    const segments = path.split('.');
    if (segments.length === 1) return { ...row, [path]: nextValue } as TRow;

    const [head, ...tail] = segments;
    const current = row[head];
    const nested = current !== null && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : {};
    let cursor = nested;
    tail.forEach((segment, index) => {
        if (index === tail.length - 1) {
            cursor[segment] = nextValue;
        } else {
            const child = cursor[segment];
            cursor[segment] = child !== null && typeof child === 'object'
                ? { ...(child as Record<string, unknown>) }
                : {};
            cursor = cursor[segment] as Record<string, unknown>;
        }
    });
    return { ...row, [head]: nested } as TRow;
}

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

function parseJsonValue(value: string, fallback: unknown): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function stringArrayValue(value: unknown): string {
    return Array.isArray(value) ? value.map(displayValue).join(', ') : displayValue(value);
}

function searchableText(row: PanelRow, fields: readonly Pick<RenderField, 'key'>[]): string {
    return fields.map((field) => displayValue(readPath(row, field.key))).join(' ').toLocaleLowerCase();
}

function compareValues(left: unknown, right: unknown): number {
    if (left === right) return 0;
    if (left === undefined || left === null) return -1;
    if (right === undefined || right === null) return 1;
    return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

function FieldControl({
    field,
    value,
    editable,
    onChange,
}: {
    field: RenderField;
    value: unknown;
    editable: boolean;
    onChange: (value: unknown) => void;
}) {
    const label = field.label ?? field.key;
    const control = field.control;
    const inputProps = {
        'aria-label': label,
        'data-panel-control': control,
        disabled: !editable,
    };

    if (control === 'readonly' || control === 'computed') {
        return <output data-panel-control={control}>{displayValue(value)}</output>;
    }

    if (control === 'checkbox') {
        return (
            <input
                {...inputProps}
                type="checkbox"
                checked={value === true}
                onChange={(event) => onChange(event.target.checked)}
            />
        );
    }

    if (control === 'select') {
        return (
            <select
                {...inputProps}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => onChange(event.target.value)}
            >
                <option value="">Select…</option>
                {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                ))}
            </select>
        );
    }

    if (control === 'textarea' || control === 'nested-object' || control === 'array') {
        return (
            <textarea
                {...inputProps}
                value={displayValue(value)}
                placeholder={field.placeholder}
                onChange={(event) => onChange(
                    control === 'textarea' ? event.target.value : parseJsonValue(event.target.value, value),
                )}
            />
        );
    }

    if (control === 'tags') {
        return (
            <input
                {...inputProps}
                type="text"
                value={stringArrayValue(value)}
                placeholder={field.placeholder}
                onChange={(event) => onChange(event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))}
            />
        );
    }

    if (control === 'image') {
        const source = typeof value === 'string' ? value : '';
        return (
            <span data-panel-control="image">
                {source ? <img src={source} alt={label} /> : null}
                <input
                    {...inputProps}
                    type="text"
                    value={source}
                    placeholder={field.placeholder}
                    onChange={(event) => onChange(event.target.value)}
                />
            </span>
        );
    }

    const inputType: Extract<PanelInputControl, 'text' | 'number'> = control === 'number' ? 'number' : 'text';
    return (
        <input
            {...inputProps}
            type={inputType}
            value={value === undefined || value === null ? '' : String(value)}
            placeholder={field.placeholder}
            onChange={(event) => onChange(inputType === 'number' ? Number(event.target.value) : event.target.value)}
        />
    );
}

function ListRow<TRow extends PanelRow>({
    descriptor,
    row,
    rowIndex,
    editable,
    onChange,
    onSelect,
}: {
    descriptor: PanelDescriptor<TRow>;
    row: TRow;
    rowIndex: number;
    editable: boolean;
    onChange: (row: TRow) => void;
    onSelect?: () => void;
}) {
    return (
        <div data-panel-row={rowIndex} onClick={onSelect}>
            {descriptor.fields.map((field) => (
                <label key={field.key}>
                    <span>{field.label ?? field.key}</span>
                    <FieldControl
                        field={field}
                        value={readPath(row, field.key)}
                        editable={editable && field.control !== 'readonly' && field.control !== 'computed'}
                        onChange={(value) => onChange(writePath(row, field.key, value))}
                    />
                </label>
            ))}
        </div>
    );
}

function ListRenderer<TRow extends PanelRow>({
    descriptor,
    rows,
    onRowsChange,
    onSelectRow,
    getRowKey,
}: PanelRendererProps<TRow>) {
    const [query, setQuery] = useState('');
    const [filterValue, setFilterValue] = useState('');

    const visibleRows = useMemo(() => {
        let result = [...rows];
        if (query.trim() && descriptor.search) {
            const needle = query.trim().toLocaleLowerCase();
            result = result.filter((row) => searchableText(row, descriptor.fields).includes(needle));
        }
        if (descriptor.filter && filterValue) {
            result = result.filter((row) => displayValue(readPath(row, descriptor.filter!.field)) === filterValue);
        }
        if (descriptor.sort) {
            result.sort((left, right) => compareValues(
                readPath(left, descriptor.sort!),
                readPath(right, descriptor.sort!),
            ));
        }
        return result;
    }, [descriptor, filterValue, query, rows]);

    const updateRow = (visibleIndex: number, nextRow: TRow) => {
        if (!onRowsChange) return;
        const original = visibleRows[visibleIndex];
        const sourceIndex = rows.indexOf(original);
        if (sourceIndex < 0) return;
        const nextRows = [...rows];
        nextRows[sourceIndex] = nextRow;
        onRowsChange(nextRows);
    };

    return (
        <section data-panel-layout="list">
            {(descriptor.search || descriptor.filter || descriptor.sort) && (
                <div data-panel-toolbar>
                    {descriptor.search ? (
                        <input
                            type="search"
                            aria-label="Search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    ) : null}
                    {descriptor.filter ? (
                        <select aria-label={descriptor.filter.label ?? `Filter by ${descriptor.filter.field}`} value={filterValue} onChange={(event) => setFilterValue(event.target.value)}>
                            <option value="">All</option>
                            {descriptor.filter.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                    ) : null}
                    {descriptor.sort ? <span data-panel-sort={descriptor.sort}>Sorted by {descriptor.sort}</span> : null}
                </div>
            )}
            <div data-panel-list>
                {visibleRows.map((row, index) => (
                    <ListRow
                        key={getRowKey?.(row, index) ?? String(index)}
                        descriptor={descriptor}
                        row={row}
                        rowIndex={index}
                        editable={descriptor.crud.update === true}
                        onChange={(nextRow) => updateRow(index, nextRow)}
                        onSelect={onSelectRow ? () => onSelectRow(row, index) : undefined}
                    />
                ))}
            </div>
        </section>
    );
}

export function PanelRenderer<TRow extends PanelRow = PanelRow>(props: PanelRendererProps<TRow>) {
    if (props.descriptor.layout === 'list') {
        return <ListRenderer {...props} />;
    }

    return (
        <div role="status" data-panel-unsupported-layout={props.descriptor.layout}>
            Panel layout “{props.descriptor.layout}” is not supported yet.
        </div>
    );
}
