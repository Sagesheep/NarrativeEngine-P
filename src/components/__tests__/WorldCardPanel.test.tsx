import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldCardPanel } from '../WorldCardPanel';
import { createWorldCard } from '../../services/lore/worldCard';

const read = vi.hoisted(() => vi.fn());
vi.mock('../../services/lore/worldCard', async importOriginal => ({
    ...await importOriginal<typeof import('../../services/lore/worldCard')>(), readWorldFile: read,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const card = createWorldCard('Persona 3', [{ id: 'tartarus', header: 'Tartarus', content: 'A labyrinth.', tokens: 3,
    triggerKeywords: ['Tartarus'], alwaysInclude: false, scanDepth: 3, category: 'location', linkedEntities: [], priority: 6 }]);

function setup() {
    const onImport = vi.fn();
    render(<WorldCardPanel getExportCard={() => card} onImport={onImport} importLabel="Import as new world draft" />);
    return onImport;
}
describe('WorldCardPanel', () => {
    it('previews the world and waits for an explicit import action', async () => {
        const result = { card, source: 'sillytavern', warnings: ['Unsupported rules require review.'] };
        read.mockResolvedValue(result);
        const onImport = setup();
        fireEvent.change(screen.getByLabelText('World lore file'), { target: { files: [new File(['{}'], 'world.json')] } });
        await screen.findByText('Persona 3');
        expect(screen.getByText('Unsupported rules require review.')).toBeVisible();
        expect(onImport).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('Import as new world draft'));
        expect(onImport).toHaveBeenCalledWith(result);
        expect(screen.queryByText('Import as new world draft')).not.toBeInTheDocument();
    });
    it('cancels without mutations', async () => {
        read.mockResolvedValue({ card, source: 'native', warnings: [] });
        const onImport = setup();
        fireEvent.change(screen.getByLabelText('World lore file'), { target: { files: [new File(['{}'], 'world.json')] } });
        await screen.findByText('Persona 3');
        fireEvent.click(screen.getByText('Cancel'));
        expect(onImport).not.toHaveBeenCalled();
    });
    it('shows parse failures without offering to import stale data', async () => {
        read.mockRejectedValue(new Error('No embedded lorebook found.'));
        const onImport = setup();
        fireEvent.change(screen.getByLabelText('World lore file'), { target: { files: [new File(['{}'], 'world.json')] } });
        expect(await screen.findByRole('alert')).toHaveTextContent('No embedded lorebook');
        expect(onImport).not.toHaveBeenCalled();
        expect(screen.queryByText('Import as new world draft')).not.toBeInTheDocument();
    });
    it('retains review and reports storage failures', async () => {
        read.mockResolvedValue({ card, source: 'native', warnings: [] });
        const onImport = setup();
        onImport.mockImplementation(() => { throw new Error('Storage full'); });
        fireEvent.change(screen.getByLabelText('World lore file'), { target: { files: [new File(['{}'], 'world.json')] } });
        await screen.findByText('Persona 3');
        fireEvent.click(screen.getByText('Import as new world draft'));
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Storage full'));
        expect(screen.getByText('Import as new world draft')).toBeVisible();
    });
});
