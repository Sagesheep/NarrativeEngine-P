import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PanelDescriptor } from '@narrative/engine';
import { PanelRenderer } from '../PanelRenderer';

type Row = {
    name: string;
    note: string;
    count: number;
    tags: string[];
    kind: string;
    enabled: boolean;
    nested: { value: string };
    values: number[];
    image: string;
    computed: string;
};

const descriptor = (id: string): PanelDescriptor<Row> => ({
    id,
    bindsTo: 'rows',
    launch: 'tab',
    layout: 'list',
    fields: [
        { key: 'name', label: 'Name', control: 'text' },
        { key: 'note', label: 'Note', control: 'textarea' },
        { key: 'count', label: 'Count', control: 'number' },
        { key: 'tags', label: 'Tags', control: 'tags' },
        { key: 'kind', label: 'Kind', control: 'select', options: [{ value: 'a', label: 'A' }] },
        { key: 'enabled', label: 'Enabled', control: 'checkbox' },
        { key: 'nested', label: 'Nested', control: 'nested-object' },
        { key: 'values', label: 'Values', control: 'array' },
        { key: 'image', label: 'Image', control: 'image' },
        { key: 'computed', label: 'Computed', control: 'computed', compute: (row) => row.computed },
        { key: 'readonlyName', label: 'Read only', control: 'readonly' },
    ],
    crud: { read: true, update: true },
});

const row: Row = {
    name: 'Alpha',
    note: 'Initial note',
    count: 2,
    tags: ['one', 'two'],
    kind: 'a',
    enabled: true,
    nested: { value: 'nested' },
    values: [1, 2],
    image: '',
    computed: 'derived',
};

describe('PanelRenderer list layout', () => {
    it('renders every declared control without knowing the panel id', () => {
        const { container: real } = render(<PanelRenderer descriptor={descriptor('npc-ledger')} rows={[row]} />);
        const realControls = [...real.querySelectorAll('[data-panel-control]')].map((element) => element.getAttribute('data-panel-control'));
        expect(realControls).toEqual(expect.arrayContaining([
            'text', 'textarea', 'number', 'tags', 'select', 'checkbox',
            'nested-object', 'array', 'image', 'computed', 'readonly',
        ]));

        const { container: opaque } = render(<PanelRenderer descriptor={descriptor('zz1')} rows={[row]} />);
        expect(opaque.querySelector('[data-panel-layout="list"]')).not.toBeNull();
        expect(opaque.querySelectorAll('[data-panel-control]').length).toBe(real.querySelectorAll('[data-panel-control]').length);
    });

    it('updates a declared field through the host callback', async () => {
        const user = userEvent.setup();
        const onRowsChange = vi.fn();
        render(<PanelRenderer descriptor={descriptor('opaque')} rows={[row]} onRowsChange={onRowsChange} />);

        const name = screen.getByLabelText('Name');
        await user.clear(name);

        expect(onRowsChange).toHaveBeenLastCalledWith([expect.objectContaining({ name: '' })]);
    });

    it('filters and sorts using declarations rather than panel identity', async () => {
        const user = userEvent.setup();
        const filtering = { ...descriptor('filterable'), search: true, sort: 'name', filter: { field: 'kind', options: [{ value: 'a', label: 'A' }] } };
        render(<PanelRenderer descriptor={filtering} rows={[row, { ...row, name: 'Beta', kind: 'b' }]} />);

        expect(screen.getByText('Sorted by name')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Search'), 'Beta');
        expect(screen.getAllByDisplayValue('Beta')).toHaveLength(2);
        expect(screen.queryByDisplayValue('Alpha')).toBeNull();
    });
});
