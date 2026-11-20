import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RuleChunkMeta } from '../../../types';
import { RulesManagerTab } from '../RulesManagerTab';

const { updateContext, storeState } = vi.hoisted(() => {
    const updateContext = vi.fn();
    const storeState = {
        context: {
            rulesRaw: '### Stealth\n<!-- rag: vector -->\nMove quietly.',
            rulesChunkMeta: {},
        },
        activeCampaignId: 'test-campaign',
        settings: {},
        getActiveUtilityEndpoint: vi.fn(),
        updateContext,
    };
    return { updateContext, storeState };
});

vi.mock('../../../store/useAppStore', () => ({
    useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

describe('RulesManagerTab manual mode edits', () => {
    it.each([
        { control: 'single rule', role: 'checkbox', name: 'Always', modes: ['vector', 'always'] },
        { control: 'bulk mode', role: 'button', name: 'keyword', modes: ['vector', 'keyword'] },
        { control: 'bulk disable', role: 'button', name: 'Disable All', modes: [] },
    ])('persists the $control override', ({ role, name, modes }) => {
        updateContext.mockClear();
        render(<RulesManagerTab />);
        fireEvent.click(screen.getByRole(role, { name }));

        const { rulesChunkMeta } = updateContext.mock.lastCall?.[0] as {
            rulesChunkMeta: Record<string, RuleChunkMeta>;
        };
        expect(rulesChunkMeta.stealth).toMatchObject({
            activationModes: modes,
            activationModesUserEdited: true,
        });
    });
});
