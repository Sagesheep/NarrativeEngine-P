import { useAppStore } from '../../store/useAppStore';
import type { ChatMessage, CombatProposal, CombatSession } from '../../types';

export function isSwipeLockedByCombat(messageId: string | null | undefined, proposal: CombatProposal | null = useAppStore.getState().combatProposal): boolean {
    return !!messageId && !!proposal && proposal.messageId === messageId;
}

export function isCombatMessage(msg: Pick<ChatMessage, 'role' | 'name' | 'combatBeat'>): boolean {
    if (msg.combatBeat) return true;
    return msg.role === 'system' && (msg.name === 'combat-log' || msg.name === 'combat-result');
}

export function isRewindDeleteLocked(
    msg: Pick<ChatMessage, 'role' | 'name' | 'combatBeat'>,
    session: CombatSession | null = useAppStore.getState().combatSession,
): boolean {
    return !!session || isCombatMessage(msg);
}

export function findMessage(id: string): ChatMessage | undefined {
    return useAppStore.getState().messages.find(m => m.id === id);
}
