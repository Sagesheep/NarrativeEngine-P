import { createFinalUserRegistryWithExtensions } from '../payload/contributions/extensions';
import type { FinalUserModuleInput } from '../payload/contributions/builtins';
import type { ContributionRegistry } from '../payload/contributions/registry';
import type { CombatTurnNote, GameContext } from '../../types';
import { uid } from '../../utils/uid';

export const COMBAT_NOTES_MODULE_ID = 'combat.notes';
export const COMBAT_NOTES_ORDER = 650;

export const COMBAT_DECLINED_TEXT = 'The player declined engine-run combat. Resolve this confrontation in narration.';
export const COMBAT_AFTERMATH_DIRECTIVE = 'Continue the story from this outcome. Do not replay or re-narrate the fight.';

export function renderCombatNotes(context: Pick<GameContext, 'combatAftermath' | 'combatDeclined'>): string {
    const parts: string[] = [];
    if (context.combatDeclined?.text) parts.push(`[COMBAT NOTE]\n${context.combatDeclined.text}`);
    if (context.combatAftermath?.text) parts.push(`[COMBAT AFTERMATH]\n${context.combatAftermath.text}\n${COMBAT_AFTERMATH_DIRECTIVE}`);
    return parts.join('\n\n');
}

export function buildCombatNoteRegistry(context: GameContext): ContributionRegistry<FinalUserModuleInput> | undefined {
    const text = renderCombatNotes(context);
    if (!text) return undefined;
    const registry = createFinalUserRegistryWithExtensions();
    if (registry.get(COMBAT_NOTES_MODULE_ID)) return registry;
    registry.register({
        id: COMBAT_NOTES_MODULE_ID,
        name: 'Combat notes',
        description: 'One-turn notes after a declined or finished engine fight.',
        source: 'builtin',
        defaultEnabled: true,
        toggleable: false,
        produce: () => [{
            id: COMBAT_NOTES_MODULE_ID,
            slot: 'final-user',
            order: COMBAT_NOTES_ORDER,
            text,
            source: 'builtin',
            trace: { source: 'Combat', classification: 'volatile_state', reason: 'One-turn combat note' },
        }],
    });
    return registry;
}

export function combatNoteRegistryOption(context: GameContext): { finalUserRegistry?: ContributionRegistry<FinalUserModuleInput> } {
    const registry = buildCombatNoteRegistry(context);
    return registry ? { finalUserRegistry: registry } : {};
}

export function makeCombatNote(text: string, now = Date.now()): CombatTurnNote {
    return { id: uid(), text, createdAt: now };
}
