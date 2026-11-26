import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PanelDescriptor } from '@narrative/engine';
import { PanelRenderer } from '../PanelRenderer';

type Row = { name: string; note: string };

const descriptor = (id: string): PanelDescriptor<Row> => ({
    id,
    bindsTo: 'rows',
    launch: 'tab',
    layout: 'list-detail',
    fields: [
        { key: 'name', label: 'Name', control: 'text' },
        { key: 'note', label: 'Note', control: 'textarea' },
    ],
    crud: { read: true, update: true },
});

const rows: Row[] = [
    { name: 'Alpha', note: 'First' },
    { name: 'Beta', note: 'Second' },
];

describe('PanelRenderer list-detail layout', () => {
    it('selects a row and renders its declared fields', async () => {
        const user = userEvent.setup();
        render(<PanelRenderer descriptor={descriptor('npc-ledger')} rows={rows} />);

        expect(screen.getByDisplayValue('Alpha')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Beta/ }));
        expect(screen.getByDisplayValue('Beta')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Second')).toBeInTheDocument();
    });

    it('updates the selected source row and does not branch on its panel id', async () => {
        const user = userEvent.setup();
        const onRowsChange = vi.fn();
        const { container: real } = render(<PanelRenderer descriptor={descriptor('lore-chunks')} rows={rows} onRowsChange={onRowsChange} />);
        const realLayout = real.querySelector('[data-panel-layout="list-detail"]');

        await user.click(screen.getByRole('button', { name: /Beta/ }));
        const note = screen.getByDisplayValue('Second');
        await user.clear(note);
        expect(onRowsChange).toHaveBeenLastCalledWith([
            rows[0],
            expect.objectContaining({ name: 'Beta', note: '' }),
        ]);

        const { container: opaque } = render(<PanelRenderer descriptor={descriptor('zz2')} rows={rows} />);
        expect(opaque.querySelector('[data-panel-layout="list-detail"]')).not.toBeNull();
        expect(opaque.querySelectorAll('[data-panel-detail-list] button')).toHaveLength(realLayout?.querySelectorAll('button').length ?? 0);
    });
});
