import type { SceneImageContextInput, ChatMessage } from '../../types';
import { useAppStore } from '../../store/useAppStore';

export function buildSceneImageContextInput(
    sourceMessageId: string,
    selectedText: string,
    selectionStart?: number,
    selectionEnd?: number
): SceneImageContextInput {
    const state = useAppStore.getState();
    const campaignId = state.activeCampaignId || '';
    const messages = state.messages || [];

    // Find index of target message
    const msgIdx = messages.findIndex(m => m.id === sourceMessageId);

    // Gather up to 3 preceding assistant messages
    const preceding: ChatMessage[] = [];
    if (msgIdx !== -1) {
        for (let i = msgIdx - 1; i >= 0 && preceding.length < 3; i--) {
            if (messages[i].role === 'assistant' && messages[i].content) {
                preceding.unshift(messages[i]);
            }
        }
    }

    const recentNarrative = preceding.map(m => ({
        messageId: m.id,
        text: m.displayContent || m.content,
    }));

    // Extract present characters from ledger or context
    const presentCharacters: string[] = [];
    if (state.npcLedger) {
        for (const npc of state.npcLedger) {
            const npcAny = npc as { lastSeenScene?: string; notes?: string };
            if (npcAny.lastSeenScene || npcAny.notes?.toLowerCase().includes('present') || !npc.archived) {
                if (npc.name && !presentCharacters.includes(npc.name)) {
                    presentCharacters.push(npc.name);
                }
            }
        }
    }

    // Resolve location name
    let locationName = '';
    if (state.context?.currentPlaceId && state.locationLedger) {
        const place = state.locationLedger.find(l => l.id === state.context.currentPlaceId);
        if (place) locationName = place.name;
    }

    return {
        campaignId,
        sourceMessageId,
        selectedText,
        selectionStart,
        selectionEnd,
        activeScene: {
            location: locationName || undefined,
        },
        presentCharacters,
        recentNarrative,
    };
}
