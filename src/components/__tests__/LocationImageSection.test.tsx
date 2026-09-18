import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocationImageSection } from '../location-ledger/LocationImageSection';
import { useAppStore } from '../../store/useAppStore';
import { generateNPCPortrait } from '../../services/npc-generation/portrait';
import { downloadImageToLocal } from '../../services/infrastructure/assetService';
vi.mock('../../services/npc-generation/portrait', () => ({ generateNPCPortrait: vi.fn() }));
vi.mock('../../services/infrastructure/assetService', () => ({ downloadImageToLocal: vi.fn(), uploadImageToLocal: vi.fn() }));
describe('location picture context', () => {
    afterEach(() => { cleanup(); vi.restoreAllMocks(); });
    it('sends the actual description, region, features, and condition to Image AI', async () => {
        const config = { endpoint: 'https://images.test', apiKey: '', modelName: 'image' };
        vi.spyOn(useAppStore.getState(), 'getActiveImageEndpoint').mockReturnValue(config);
        vi.mocked(generateNPCPortrait).mockResolvedValue('https://images.test/harbor.png');
        vi.mocked(downloadImageToLocal).mockResolvedValue('/assets/harbor.png');
        const onChange = vi.fn();
        render(<LocationImageSection isEditing location={{ name: 'Old Harbor', description: 'Broken piers under red cliffs.', broadLocation: 'Northern Coast', features: ['Lighthouse'], status: 'Flooded' }} onChange={onChange} onBusyChange={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Generate Picture' }));
        await waitFor(() => expect(onChange).toHaveBeenCalledWith('/assets/harbor.png'));
        const [actualConfig, prompt, layout] = vi.mocked(generateNPCPortrait).mock.calls[0];
        expect(actualConfig).toEqual(config);
        for (const detail of ['Old Harbor', 'Broken piers under red cliffs.', 'Northern Coast', 'Lighthouse', 'Flooded']) expect(prompt).toContain(detail);
        expect(layout).toBe('landscape');
    });
});
