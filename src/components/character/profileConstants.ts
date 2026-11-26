import type { DivergenceCategory, SceneEventType } from '../../types';

export const TRAIT_CATEGORIES: DivergenceCategory[] = [
    'locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc',
];

export const TRAIT_EVENT_TAGS: SceneEventType[] = [
    'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
    'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
];

export const TRAIT_CATEGORY_LABELS: Record<DivergenceCategory, string> = {
    locations: 'Location',
    npc_events: 'NPC Event',
    promises_debts: 'Promise/Debt',
    world_state: 'World State',
    party_facts: 'Party Fact',
    rules_lore: 'Rules/Lore',
    misc: 'Misc',
};