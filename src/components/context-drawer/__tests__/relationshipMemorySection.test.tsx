import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../store/useAppStore', () => ({
    useAppStore: (selector: (s: unknown) => unknown) => selector({ settings: {}, npcLedger: [] }),
}));

import { RelationshipMemorySection } from '../EnginesTab';
import type { GameContext } from '../../../types';

type Props = Parameters<typeof RelationshipMemorySection>[0];

// context.relationshipMemory had readers but nothing could set it, so NPC Ledger v3 never ran.
describe('RelationshipMemorySection', () => {
    it('turning it on writes relationshipMemory: true', () => {
        const updateContext = vi.fn();
        render(<RelationshipMemorySection context={{} as GameContext} updateContext={updateContext as Props['updateContext']} />);
        fireEvent.click(screen.getAllByRole('button')[0]);
        expect(updateContext).toHaveBeenCalledWith({ relationshipMemory: true });
    });

    it('turning it off writes false', () => {
        const updateContext = vi.fn();
        render(<RelationshipMemorySection context={{ relationshipMemory: true } as GameContext} updateContext={updateContext as Props['updateContext']} />);
        fireEvent.click(screen.getAllByRole('button')[0]);
        expect(updateContext).toHaveBeenCalledWith({ relationshipMemory: false });
    });
});
