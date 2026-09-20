import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CampaignWorldSetup } from '../CampaignWorldSetup';
import { createWorldCard } from '../../services/lore/worldCard';

const state = vi.hoisted(() => ({ worldLoreDrafts: [], loadWorldLoreDrafts: vi.fn() }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: (selector: (s: typeof state) => unknown) => selector(state) }));
afterEach(cleanup);
function setup() {
    const onChange = vi.fn();
    const onBusyChange = vi.fn();
    render(<CampaignWorldSetup onChange={onChange} onBusyChange={onBusyChange} onOpenBuilder={vi.fn()} />);
    return { onChange, onBusyChange };
}
function upload(value: unknown) {
    const file = { name: 'world.json', size: 100, text: async () => JSON.stringify(value) };
    fireEvent.change(screen.getByLabelText('Upload world lore'), { target: { files: [file] } });
    return file;
}
describe('campaign world setup', () => {
    it('routes character cards to the NPC roster even if they contain lore', async () => {
        const { onChange, onBusyChange } = setup();
        upload({ spec: 'chara_card_v2', data: { name: 'Mira', character_book: { entries: [] } } });
        expect(await screen.findByRole('alert')).toHaveTextContent('Use Add NPC');
        expect(onChange).not.toHaveBeenCalled();
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
    });
    it('stages a valid world card and lets the user clear it', async () => {
        const { onChange } = setup();
        const card = createWorldCard('Floating Isles', []);
        const file = upload(card);
        await waitFor(() => expect(onChange).toHaveBeenCalledWith(file, expect.objectContaining({ source: 'native' })));
        fireEvent.click(screen.getByRole('button', { name: /Start blank/ }));
        expect(onChange).toHaveBeenLastCalledWith(null);
    });
    it('stages authored text as Markdown', () => {
        const { onChange } = setup();
        fireEvent.click(screen.getByRole('button', { name: /Write your world/ }));
        fireEvent.change(screen.getByLabelText('World lore'), { target: { value: '# A new world' } });
        expect(onChange.mock.lastCall?.[0].name).toBe('world.md');
    });
});
