import type { ChatMessage } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';

const VERBATIM_WINDOW = 10;

export function getCondenseBudgetRatio(strategy: string): number {
    switch (strategy) {
        case 'tight': return 0.5;
        case 'deep': return 0.90;
        default: return 0.75;
    }
}

export function shouldCondense(
    messages: ChatMessage[],
    contextLimit: number,
    condensedUpToIndex: number,
    budgetRatio: number = 0.75
): boolean {
    const uncondensedMessages = messages.slice(condensedUpToIndex + 1);
    if (uncondensedMessages.length <= VERBATIM_WINDOW) return false;

    const historyTokens = countTokens(
        uncondensedMessages.map((m) => m.content).join('')
    );
    return historyTokens > contextLimit * budgetRatio;
}

export function getVerbatimWindow(): number {
    return VERBATIM_WINDOW;
}

export function computeTrimIndex(messages: ChatMessage[], condensedUpToIndex: number): number {
    const trimTarget = messages.length - VERBATIM_WINDOW;
    if (trimTarget <= condensedUpToIndex) return condensedUpToIndex;
    return trimTarget;
}