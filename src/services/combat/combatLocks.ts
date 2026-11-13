import { useAppStore } from '../../store/useAppStore';
import type { AbilityProposal, ChatMessage, CombatProposal, CombatSession } from '../../types';

export function isSuccessionPending(): boolean {
    return !!useAppStore.getState().context?.combatFallen;
}

export function isSwipeLockedByCombat(
    messageId: string | null | undefined,
    proposal: CombatProposal | null = useAppStore.getState().combatProposal,
    abilityProposal: AbilityProposal | null = useAppStore.getState().abilityProposal ?? null,
    fallen: boolean = isSuccessionPending(),
): boolean {
    if (!messageId) return false;
    if (fallen) return true;
    return (!!proposal && proposal.messageId === messageId) || (!!abilityProposal && abilityProposal.messageId === messageId);
}

export function isCombatMessage(msg: Pick<ChatMessage, 'role' | 'name' | 'combatBeat' | 'combatParley'>): boolean {
    if (msg.combatBeat || msg.combatParley) return true;
    return msg.role === 'system' && (msg.name === 'combat-log' || msg.name === 'combat-result');
}

export function isRewindDeleteLocked(
    msg: Pick<ChatMessage, 'role' | 'name' | 'combatBeat' | 'combatParley'>,
    session: CombatSession | null = useAppStore.getState().combatSession,
    fallen: boolean = isSuccessionPending(),
): boolean {
    return !!session || fallen || isCombatMessage(msg);
}

export function findMessage(id: string): ChatMessage | undefined {
    return useAppStore.getState().messages.find(m => m.id === id);
}
