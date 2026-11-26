import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const store = vi.hoisted(() => ({
    state: {
        settings: { aiTier: 'max', moduleEnabled: {} as Record<string, boolean> },
        npcLedger: [{ id: 'n1', name: 'Therese Soll' }, { id: 'n2', name: 'Rin Holmes' }],
    },
}));
vi.mock('../../../store/useAppStore', () => ({
    useAppStore: (selector: (s: typeof store.state) => unknown) => selector(store.state),
}));

import { NpcAppearanceSection } from '../EnginesTab';
import type { GameContext } from '../../../types';

type Props = Parameters<typeof NpcAppearanceSection>[0];

describe('NpcAppearanceSection', () => {
    it('adds a ledger NPC to the pool with the mobile defaults', () => {
        const updateContext = vi.fn();
        render(<NpcAppearanceSection context={{} as GameContext} updateContext={updateContext as Props['updateContext']} />);

        fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'Therese Soll' } });
        fireEvent.click(screen.getByText('Add to pool'));

        expect(updateContext).toHaveBeenCalledWith({
            npcIntroConfig: { initialDC: 196, dcReduction: 2, characters: [{ name: 'Therese Soll', type: 'wandering' }] },
        });
    });

    it('turning it on writes npcIntroEngineActive', () => {
        const updateContext = vi.fn();
        render(<NpcAppearanceSection context={{} as GameContext} updateContext={updateContext as Props['updateContext']} />);
        fireEvent.click(screen.getAllByRole('button')[0]); // the header toggle
        expect(updateContext).toHaveBeenCalledWith({ npcIntroEngineActive: true });
    });

    it('says when the tier keeps it off', () => {
        store.state.settings.aiTier = 'pro';
        render(<NpcAppearanceSection context={{} as GameContext} updateContext={vi.fn() as unknown as Props['updateContext']} />);
        expect(screen.getByText(/Off for the PRO tier/)).toBeTruthy();
        store.state.settings.aiTier = 'max';
    });
});
