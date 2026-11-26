import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, LoreChunk } from '../../../types';

const llmCall = vi.fn();
vi.mock('../../../utils/llmCall', () => ({ llmCall: (...args: unknown[]) => llmCall(...args) }));

import { LoreAiIndexPanel } from '../LoreAiIndexPanel';
import { useAppStore } from '../../../store/useAppStore';
import { hasFreshAiSummary } from '../../../services/lore/loreAiIndex';

const chunk = (id: string): LoreChunk => ({
    id, header: `Entry ${id}`, content: `Text of ${id}`, tokens: 3, alwaysInclude: false, triggerKeywords: [],
    scanDepth: 3, category: 'misc', linkedEntities: [], priority: 3,
});

const setLoreChunks = vi.fn((chunks: LoreChunk[]) => useAppStore.setState({ loreChunks: chunks } as never));
const updateSettings = vi.fn((patch: Partial<AppSettings>) =>
    useAppStore.setState(s => ({ settings: { ...s.settings, ...patch } }) as never));
let utility: { endpoint: string } | undefined;

beforeEach(() => {
    llmCall.mockReset();
    setLoreChunks.mockClear();
    updateSettings.mockClear();
    utility = { endpoint: 'http://localhost:1234/v1' };
    useAppStore.setState({
        activeCampaignId: 'campaign-1',
        loreChunks: [chunk('a'), chunk('b')],
        setLoreChunks,
        updateSettings,
        getActiveUtilityEndpoint: () => utility,
        settings: { ...useAppStore.getState().settings, aiLoreIndex: false, aiLoreShortlist: false, aiLoreShortlistTokens: 4000 },
    } as never);
});

describe('LoreAiIndexPanel', () => {
    it('turns the AI index and the shortlist on and off', () => {
        render(<LoreAiIndexPanel campaignId="campaign-1" />);
        fireEvent.click(screen.getByRole('switch', { name: /Use AI index/ }));
        expect(updateSettings).toHaveBeenLastCalledWith({ aiLoreIndex: true });
        fireEvent.click(screen.getByRole('switch', { name: /Shortlist the top 50/ }));
        expect(updateSettings).toHaveBeenLastCalledWith({ aiLoreShortlist: true });
    });

    it('clamps and saves the token limit', () => {
        useAppStore.setState(s => ({ settings: { ...s.settings, aiLoreShortlist: true } }) as never);
        render(<LoreAiIndexPanel campaignId="campaign-1" />);
        const input = screen.getByLabelText(/Token limit/);
        fireEvent.change(input, { target: { value: '100' } });
        fireEvent.blur(input);
        expect(updateSettings).toHaveBeenLastCalledWith({ aiLoreShortlistTokens: 500 });
    });

    it('writes AI lines to the entries when run', async () => {
        llmCall.mockResolvedValue('{"a": "Entry a. Relevant when: a comes up.", "b": "Entry b. Relevant when: b comes up."}');
        render(<LoreAiIndexPanel campaignId="campaign-1" />);
        expect(screen.getByText('0 of 2 entries indexed', { exact: false })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Run AI indexing' }));
        await waitFor(() => expect(screen.getByRole('status').textContent).toBe('2 entries indexed.'));
        const saved = useAppStore.getState().loreChunks;
        expect(saved.every(hasFreshAiSummary)).toBe(true);
        expect(saved[0].aiSummary).toBe('Entry a. Relevant when: a comes up.');
        expect(screen.getByRole('button', { name: 'Run AI indexing' })).toHaveProperty('disabled', true);
    });

    it('cannot run without a utility endpoint', () => {
        utility = undefined;
        render(<LoreAiIndexPanel campaignId="campaign-1" />);
        expect(screen.getByRole('button', { name: 'Run AI indexing' })).toHaveProperty('disabled', true);
        expect(screen.getByRole('status').textContent).toContain('Needs a utility AI endpoint');
    });
});
