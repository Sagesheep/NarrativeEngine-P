import { useAppStore } from '../../store/useAppStore';
import { llmCall } from '../../utils/llmCall';
import { uid } from '../../utils/uid';
import { commitPendingTurn } from '../turn/pendingCommit';
import { isEngineLogMessage } from '../payload/history';
import { parseCombatArgs } from './combatProposal';
import { stageProposal } from './combatController';
import type { ChatMessage, CombatProposal, EndpointConfig, ProviderConfig } from '../../types';

export const MANUAL_START_TRACKING_LABEL = 'combat-manual-start';
const RECENT_MESSAGES = 6;

export function buildManualStartPrompt(messages: readonly ChatMessage[], pcName: string): string {
    const recent = messages
        .filter(m => (m.role === 'user' || m.role === 'assistant') && !isEngineLogMessage(m))
        .slice(-RECENT_MESSAGES)
        .map(m => `[${m.role === 'assistant' ? 'GM' : 'PLAYER'}]: ${(m.content || '').slice(0, 1200)}`)
        .join('\n\n');
    return [
        'Read the scene below and list who takes part in the fight that is about to start.',
        `Do not include the player character${pcName ? ` (${pcName})` : ''}.`,
        'Reply with JSON only, in this shape:',
        '{"combatants":[{"name":"Bandit","side":"enemy","tier":"grunt","archetype":"brute","species":"human","npcName":"","look":"scarred, axe"}],"reason":"one line"}',
        'side is enemy, ally or neutral. tier is minion, grunt, elite, boss or legendary. Repeat a name for identical foes. No numbers.',
        '',
        'SCENE:',
        recent,
    ].join('\n');
}

function anchorMessageId(messages: readonly ChatMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') return messages[i].id;
    }
    return messages[messages.length - 1]?.id ?? '';
}

export async function requestManualCombat(
    call: (provider: EndpointConfig | ProviderConfig, prompt: string) => Promise<string> = (provider, prompt) =>
        llmCall(provider, prompt, { trackingLabel: MANUAL_START_TRACKING_LABEL, timeoutMs: 45000, temperature: 0.2 }),
): Promise<CombatProposal | null> {
    await commitPendingTurn().catch(e => console.warn('[combat] commit before manual start failed:', e));
    const store = useAppStore.getState();
    if (store.combatSession || store.combatProposal || store.context.combatModeActive !== true) return null;
    const empty: CombatProposal = {
        id: uid(),
        messageId: anchorMessageId(store.messages),
        combatants: [],
        reason: '',
        source: 'manual',
    };
    const provider = store.getActiveUtilityEndpoint?.() ?? store.getActiveStoryEndpoint();
    let proposal = empty;
    if (provider) {
        try {
            const raw = await call(provider, buildManualStartPrompt(store.messages, store.context.characterProfileData?.name ?? ''));
            const parsed = parseCombatArgs(raw, store.npcLedger);
            if (parsed.ok) proposal = { ...empty, ...parsed.value };
        } catch (e) {
            console.warn('[combat] manual start extraction failed:', e);
        }
    }
    const live = useAppStore.getState();
    if (live.combatSession || live.combatProposal) return null;
    stageProposal(proposal);
    return proposal;
}
