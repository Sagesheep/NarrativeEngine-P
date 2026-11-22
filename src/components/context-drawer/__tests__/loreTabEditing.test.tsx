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
