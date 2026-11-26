import { useCallback } from 'react';
import { computeTrimIndex, getVerbatimWindow } from '../../services/archive-memory/condenser';
import type { ChatMessage, CondenserState } from '../../types';

interface UseCondenserDeps {
    messages: ChatMessage[];
    condenser: CondenserState;
    setCondensed: (upToIndex: number) => void;
}

export function useCondenser(deps: UseCondenserDeps) {
    const triggerCondense = useCallback(() => {
        if (deps.messages.length <= getVerbatimWindow()) return;
        const newIndex = computeTrimIndex(deps.messages, deps.condenser.condensedUpToIndex);
        if (newIndex !== deps.condenser.condensedUpToIndex) {
            deps.setCondensed(newIndex);
        }
    }, [deps.messages, deps.condenser.condensedUpToIndex, deps.setCondensed]);

    return { triggerCondense };
}