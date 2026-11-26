import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LoreChunk } from '../../../types';

vi.mock('../../../store/campaignStore', () => ({
    getCampaign: vi.fn().mockResolvedValue({ name: 'Test World' }),
}));

import { LoreTab } from '../LoreTab';
import { useAppStore } from '../../../store/useAppStore';

const chunk = (id: string, header: string): LoreChunk => ({
    id, header, content: 'body', tokens: 3, alwaysInclude: false, triggerKeywords: [],
    scanDepth: 3, category: 'misc', linkedEntities: [], priority: 3,
});

const setLoreChunks = vi.fn((chunks: LoreChunk[]) => useAppStore.setState({ loreChunks: chunks } as never));

beforeEach(() => {
    setLoreChunks.mockClear();
    useAppStore.setState({
        activeCampaignId: 'campaign-1',
        loreChunks: [chunk('a', 'Old Mill'), chunk('b', 'Ember Lords')],
        setLoreChunks,
    } as never);
});

describe('LoreTab — removing an entry', () => {
    it('asks for a second click, then removes only that entry', () => {
        render(<LoreTab />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete Old Mill' }));
        expect(setLoreChunks).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Old Mill' }));
        expect(setLoreChunks).toHaveBeenCalledTimes(1);
        expect(setLoreChunks.mock.calls[0][0].map((c: LoreChunk) => c.id)).toEqual(['b']);
        expect(screen.queryByText('Old Mill')).toBeNull();
    });

    it('disarms when the pointer leaves the button', () => {
        render(<LoreTab />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete Old Mill' }));
        fireEvent.mouseLeave(screen.getByRole('button', { name: 'Confirm delete Old Mill' }));
        expect(screen.getByRole('button', { name: 'Delete Old Mill' })).toBeTruthy();
        expect(setLoreChunks).not.toHaveBeenCalled();
    });
});

describe('LoreTab — adding an entry', () => {
    it('appends a typed entry to the campaign lore', () => {
        render(<LoreTab />);
        fireEvent.click(screen.getByRole('button', { name: '+ New lore entry' }));
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The Ashen Pact' } });
        fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'A treaty signed by the Ember Lords.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));

        const saved = setLoreChunks.mock.calls[0][0] as LoreChunk[];
        expect(saved.map(c => c.header)).toEqual(['Old Mill', 'Ember Lords', 'The Ashen Pact']);
        expect(saved[2].linkedEntities).toEqual(['Ember Lords']);
    });
});

describe('LoreTab — category and folder chips', () => {
    beforeEach(() => {
        useAppStore.setState({
            loreChunks: [
                { ...chunk('a', 'Old Mill'), category: 'location' },
                { ...chunk('b', 'Ember Lords'), category: 'faction' },
                { ...chunk('c', 'Sky Barge'), folder: 'Vehicles' },
                { ...chunk('d', 'Dust Crawler'), category: 'location', folder: 'vehicles ' },
            ],
        } as never);
    });

    it('narrows the list to one category, and back to all on a second click', () => {
        render(<LoreTab />);
        fireEvent.click(screen.getByRole('button', { name: 'location 2' }));
        expect(screen.getByText('Old Mill')).toBeTruthy();
        expect(screen.getByText('Dust Crawler')).toBeTruthy();
        expect(screen.queryByText('Ember Lords')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'location 2' }));
        expect(screen.getByText('Ember Lords')).toBeTruthy();
    });

    it('groups folder names regardless of case or spacing', () => {
        render(<LoreTab />);
        fireEvent.click(screen.getByRole('button', { name: '📁 Vehicles 2' }));
        expect(screen.getByText('Sky Barge')).toBeTruthy();
        expect(screen.getByText('Dust Crawler')).toBeTruthy();
        expect(screen.queryByText('Old Mill')).toBeNull();
    });

    it('saves a folder from the entry editor without changing the category', () => {
        render(<LoreTab />);
        fireEvent.click(screen.getByRole('button', { name: 'Edit Ember Lords' }));
        fireEvent.change(screen.getByLabelText(/Folder/), { target: { value: '  Great   Houses ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        const saved = (setLoreChunks.mock.calls[0][0] as LoreChunk[]).find(c => c.id === 'b')!;
        expect(saved.folder).toBe('Great Houses');
        expect(saved.category).toBe('faction');
        expect(saved.group).toBeUndefined();
    });

    it('adds a new entry straight into a folder', () => {
        render(<LoreTab />);
        fireEvent.click(screen.getByRole('button', { name: '+ New lore entry' }));
        fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Rail Skiff' } });
        fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'A light rail vehicle.' } });
        fireEvent.change(screen.getByLabelText(/Folder/), { target: { value: 'Vehicles' } });
        fireEvent.click(screen.getByRole('button', { name: 'Add entry' }));

        const saved = setLoreChunks.mock.calls[0][0] as LoreChunk[];
        expect(saved.at(-1)?.folder).toBe('Vehicles');
    });
});
