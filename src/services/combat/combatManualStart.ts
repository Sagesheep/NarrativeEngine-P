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
        '{"combatants":[{"name":"Bandit","side":"enemy","tier":"grunt","archetype":"brute","species":"human","npcName":"","look":"scarred, axe","manner":"sneering, overconfident","speech":"speaks","tactic":"aggressive"}],"map":{"area":"scattered","density":"normal","hazard":"none","labels":{"cover":"trees","difficult":"undergrowth"},"place":"forest clearing"},"reason":"one line"}',
        'side is enemy, ally or neutral. tier is minion, grunt, elite, boss or legendary. Repeat a name for identical foes. No numbers. manner is optional: two or three words for how this one talks and carries itself in a fight. speech is optional, can this creature speak words: speaks (people and anything that talks), sounds (animals and beasts that only growl, bark or shriek) or silent (mindless or mechanical things).',
        'tactic is optional, how this one behaves in the fight:',
        '- aggressive: closes in and hits the most valuable target it can reach.',
        '- skirmisher: keeps its distance, uses cover, strikes and moves away.',
        '- guard: stays beside its leader and drives off whoever threatens it.',
        '- hunter: goes for the weakest or most isolated foe.',
        '- coward: fights from behind others and runs when hurt.',
        '- berserker: ignores danger, always the hardest hit, never backs off.',
        '- support: heals, shields and helps allies first, attacks when nothing needs doing.',
        'objective is optional, what the fight is about; leave it out for a plain fight to the finish. Shape: {"win":"escape","everyone":false,"lose":["round_limit"],"roundLimit":8,"side":"within_rounds","sideRounds":6,"reinforcements":"some"}. Never give coordinates; the engine picks every position. win is one of:',
        '- rout: beat every enemy (the default).',
        '- defeat_leader: a clear leader whose fall breaks the rest; add "leader":"Name" as listed above.',
        '- survive: an ambush or siege; add "rounds" (2 to 8) to hold out.',
        '- escape: the party must get away through an exit; "everyone":true needs the whole party out.',
        '- protect: keep someone alive; add "ward":"Name" (an ally, added if not listed) and either "rounds" or "with" (another win).',
        '- seize: take and hold a marked position.',
        'lose may add pc_falls, round_limit (with roundLimit 3 to 15) or leader_escapes. side may be within_rounds (with sideRounds), no_one_falls, save_bystander (with "bystander":"Name", a neutral) or reach_tile. reinforcements is none, some or many (not for rout).',
        'map.area is the closest of: open (field, plaza, rooftop, arena), scattered (forest, graveyard, junkyard), room (tavern, hall, nightclub), rows (warehouse, server room, library, market), corridors (ship, dungeon, sewer, bunker), cavern (cave, mine), street (alley, road, canal side), ledge (mountain pass, rampart, bridge, catwalk), ruins, wetland (swamp, flooded cave, ford).',
        'The engine builds the map: name what the obstacles are in labels and do not describe positions. density is sparse, normal or dense. hazard is none, fire, deep_water, electric, toxic or pit.',
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
