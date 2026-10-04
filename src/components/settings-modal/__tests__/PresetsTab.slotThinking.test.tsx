import { render, screen, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../store/slices/settingsHelpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../store/slices/settingsHelpers')>()),
    debouncedSaveSettings: vi.fn(),
}));

import { useAppStore } from '../../../store/useAppStore';
import { migrateSettings } from '../../../store/slices/settingsHelpers';
import { PresetsTab } from '../PresetsTab';

const SLOTS = ['story', 'summarizer', 'vision', 'utility', 'auxiliary'] as const;

beforeEach(() => {
    useAppStore.setState({
        settings: migrateSettings({
            settings: {
                providers: [{ id: 'flash', label: 'DS v4 Flash', endpoint: 'https://api.deepseek.com/v1', apiKey: 'k', modelName: 'm', apiFormat: 'openai', thinkingEffort: 'high' }],
                presets: [{ id: 'pr', name: 'P', storyAIProviderId: 'flash', utilityAIProviderId: 'flash' }],
                activePresetId: 'pr',
            },
        }),
    });
});

describe('PresetsTab — per-slot thinking', () => {
    it('renders an Off…Max picker for every slot that thinks, and none for image generation', () => {
        render(<PresetsTab />);
        for (const slot of SLOTS) {
            const picker = screen.getByTestId(`slot-thinking-${slot}`);
            expect(within(picker).getAllByRole('button').map(b => b.textContent)).toEqual(['Off', 'Low', 'Medium', 'High', 'Max']);
        }
        expect(screen.queryByTestId('slot-thinking-image')).toBeNull();
        // Migrated levels are shown: story inherited High, utility starts Off.
        expect(within(screen.getByTestId('slot-thinking-story')).getByText('High')).toHaveAttribute('aria-pressed', 'true');
        expect(within(screen.getByTestId('slot-thinking-utility')).getByText('Off')).toHaveAttribute('aria-pressed', 'true');
    });

    it('changing a picker updates only that slot of the preset', () => {
        render(<PresetsTab />);
        fireEvent.click(within(screen.getByTestId('slot-thinking-utility')).getByText('Low'));
        const preset = useAppStore.getState().settings.presets[0];
        expect(preset.slotThinking).toMatchObject({ story: 'high', utility: 'low', summarizer: 'off' });
        expect(useAppStore.getState().getActiveUtilityEndpoint()?.thinkingEffort).toBe('low');
        expect(useAppStore.getState().getActiveStoryEndpoint()?.thinkingEffort).toBe('high');
    });
});
