import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { InventoryTab } from '../tabs/InventoryTab';
import { useAppStore } from '../../../store/useAppStore';
import { useToastStore } from '../../Toast';
import type { InventoryItem } from '../../../types';

vi.mock('../../../services/inventoryParser', () => ({ scanInventory: vi.fn() }));

function item(id: string, name: string): InventoryItem {
    return {
        id,
        name,
        qty: 1,
        category: 'misc',
        keywords: [],
        equipped: false,
        lastUsedScene: '000',
        importance: 5,
        notes: '',
        locationTag: 'inventory',
    };
}

const names = () => useAppStore.getState().inventoryItems.map((it) => it.name);

describe('InventoryTab item deletion', () => {
    beforeEach(() => {
        useAppStore.getState().setInventoryItems([item('a', 'Rope'), item('b', 'Junk')]);
        useToastStore.setState({ toasts: [] });
    });

    it('deletes a row from the grid and can undo it', () => {
        render(<InventoryTab />);

        fireEvent.click(screen.getByRole('button', { name: 'Delete Junk' }));
        expect(names()).toEqual(['Rope']);
        expect(useAppStore.getState().context.inventoryItems?.map((it) => it.name)).toEqual(['Rope']);

        const toast = useToastStore.getState().toasts[0];
        expect(toast.message).toBe('Deleted Junk');
        toast.action?.onClick();
        expect(names()).toEqual(['Rope', 'Junk']);
    });

    describe('filter and bulk delete', () => {
        beforeEach(() => {
            useAppStore.getState().setInventoryItems([
                item('a', 'Rope'),
                item('b', 'Junk'),
                { ...item('c', 'Gold'), category: 'currency' },
                { ...item('d', 'Silver'), category: 'currency' },
            ]);
        });
        const shownRows = () => screen.getAllByRole('button', { name: /^Delete (?!selected)/ }).length;
        const filterTo = (value: string) =>
            fireEvent.change(screen.getByLabelText('Filter inventory'), { target: { value } });
        const clickButton = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

        it('filters to one category from the dropdown', () => {
            render(<InventoryTab />);
            expect(shownRows()).toBe(4);
            filterTo('currency');
            expect(shownRows()).toBe(2);
        });

        it('swaps Equipped ticks for selection ticks, so selecting never equips', () => {
            render(<InventoryTab />);
            clickButton('Select');
            expect(screen.queryByLabelText('Equipped Rope')).toBeNull();

            fireEvent.click(screen.getByLabelText('Select Rope'));

            expect(useAppStore.getState().inventoryItems.find((it) => it.id === 'a')?.equipped).toBe(false);
        });

        it('deletes everything in the current filter after confirming, and can undo', () => {
            render(<InventoryTab />);
            filterTo('currency');
            clickButton('Select');
            fireEvent.click(screen.getByLabelText(/Select all shown/));
            expect(screen.getByText(/^2 selected/)).toBeTruthy();

            clickButton('Delete selected');
            expect(names()).toHaveLength(4);
            clickButton('Confirm delete 2?');
            expect(names().sort()).toEqual(['Junk', 'Rope']);

            const toast = useToastStore.getState().toasts[0];
            expect(toast.message).toBe('Deleted 2 items');
            toast.action?.onClick();
            expect(names().sort()).toEqual(['Gold', 'Junk', 'Rope', 'Silver']);
        });

        it('warns about selected items the filter is hiding', () => {
            render(<InventoryTab />);
            clickButton('Select');
            fireEvent.click(screen.getByLabelText('Select Rope'));
            filterTo('currency');
            expect(screen.getByText('(1 not shown)')).toBeTruthy();
        });

        it('asks for confirmation again if the selection changes', () => {
            render(<InventoryTab />);
            clickButton('Select');
            fireEvent.click(screen.getByLabelText('Select Rope'));
            clickButton('Delete selected');
            fireEvent.click(screen.getByLabelText('Select Junk'));
            expect(screen.getByRole('button', { name: 'Delete selected' })).toBeTruthy();
        });
    });

    describe('raw edit', () => {
        const openRaw = () => {
            render(<InventoryTab />);
            fireEvent.click(screen.getByRole('button', { name: 'Raw Edit' }));
            return screen.getByLabelText('Raw inventory JSON') as HTMLTextAreaElement;
        };

        it('keeps invalid text in the box without touching the saved items', () => {
            const box = openRaw();

            fireEvent.change(box, { target: { value: '[{"id":"a",}' } });

            expect(box.value).toBe('[{"id":"a",}');
            expect(screen.getByRole('alert').textContent).toMatch(/not saved/i);
            expect(names()).toEqual(['Rope', 'Junk']);
        });

        it('saves once the edit is valid again, so an item can be deleted', () => {
            const box = openRaw();
            const kept = JSON.stringify([item('a', 'Rope')], null, 2);

            fireEvent.change(box, { target: { value: `${kept},` } });
            expect(names()).toEqual(['Rope', 'Junk']);

            fireEvent.change(box, { target: { value: kept } });
            expect(names()).toEqual(['Rope']);
            expect(screen.queryByRole('alert')).toBeNull();
        });

        it('rejects valid JSON that is not a list of items', () => {
            const box = openRaw();

            fireEvent.change(box, { target: { value: '[{"name":"no id"}]' } });

            expect(screen.getByRole('alert')).toBeTruthy();
            expect(names()).toEqual(['Rope', 'Junk']);
        });

        it('shows items written elsewhere while the editor is open', () => {
            const box = openRaw();

            fireEvent.change(box, { target: { value: 'half-typed' } });
            act(() => useAppStore.getState().setInventoryItems([item('c', 'Scanned')]));

            expect(box.value).toContain('Scanned');
            expect(screen.queryByRole('alert')).toBeNull();
        });
    });
});
