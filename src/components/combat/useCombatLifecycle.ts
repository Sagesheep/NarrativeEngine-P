import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { normalizeCombatConfig } from '../../types';
import type { ChatMessage, CombatProposal, GameContext } from '../../types';
import { isEngineTurn, resumeStoredSession, startFromProposal } from '../../services/combat/combatController';
import { wasMessageProposed } from '../../services/combat/combatCommitHooks';
import { resumeParley } from '../../services/combat/combatParley';
import { resumeStunt } from '../../services/combat/combatStunt';

export function proposalIsOrphaned(proposal: CombatProposal | null, messages: readonly ChatMessage[]): boolean {
    if (!proposal || !proposal.messageId) return false;
    return !messages.some(m => m.id === proposal.messageId);
}

export function stakesOfferKey(messages: readonly ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'system' && m.name === 'combat-result') return null;
        if (m.role === 'assistant' && m.sceneId && !m.combatBeat) return m.id;
    }
    return null;
}

export function shouldOfferCombat(input: {
    context: Pick<GameContext, 'combatModeActive' | 'combatConfig' | 'combatSheet' | 'lastSceneStakes'>;
    hasProposal: boolean;
    hasSession: boolean;
    offerKey: string | null;
    dismissedKey: string | null;
}): boolean {
    const { context } = input;
    if (context.combatModeActive !== true || context.combatSheet?.needsAllocation !== false) return false;
    if (!normalizeCombatConfig(context.combatConfig).offerOnDangerous) return false;
    if (context.lastSceneStakes !== 'dangerous') return false;
    if (input.hasProposal || input.hasSession || !input.offerKey) return false;
    if (wasMessageProposed(input.offerKey)) return false;
    return input.offerKey !== input.dismissedKey;
}

export function useCombatLifecycle(isStreaming: boolean) {
    const messages = useAppStore(s => s.messages);
    const context = useAppStore(s => s.context);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const proposal = useAppStore(s => s.combatProposal);
    const session = useAppStore(s => s.combatSession);
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const [dismissedKey, setDismissedKey] = useState<string | null>(null);
    const offerKey = useMemo(() => stakesOfferKey(messages), [messages]);

    useEffect(() => {
        if (proposalIsOrphaned(proposal, messages)) useAppStore.getState().setCombatProposal(null);
    }, [proposal, messages]);

    const sessionId = session?.state.id ?? null;
    const parleyId = session?.parley?.attemptId ?? null;
    const stuntId = session?.stunt?.attemptId ?? null;
    const needsResume = !!session && (!!parleyId || session.state.outcome !== null || isEngineTurn(session.state));
    useEffect(() => {
        if (stuntId) resumeStunt();
    }, [activeCampaignId, sessionId, stuntId]);
    useEffect(() => {
        if (!needsResume) return;
        if (parleyId) void resumeParley();
        else resumeStoredSession();
    }, [activeCampaignId, sessionId, needsResume, parleyId]);

    const confirmStart = normalizeCombatConfig(context.combatConfig).confirmStart;
    useEffect(() => {
        if (!proposal || proposal.source !== 'tool' || confirmStart) return;
        if (isStreaming || pipelinePhase !== 'idle') return;
        void startFromProposal(proposal);
    }, [proposal, confirmStart, isStreaming, pipelinePhase]);

    const showOffer = shouldOfferCombat({
        context,
        hasProposal: !!proposal,
        hasSession: !!session,
        offerKey,
        dismissedKey,
    }) && !isStreaming && pipelinePhase === 'idle';

    return {
        proposal,
        session,
        showOffer,
        offerKey,
        dismissOffer: () => setDismissedKey(offerKey),
    };
}
