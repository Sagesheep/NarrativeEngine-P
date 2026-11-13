import { resolveMapSpec } from '@narrative/engine';
import type { CombatMapSpec, CombatProposal, CombatResolvedMap, GameContext, LocationEntry } from '../../types';

export type CombatMapSourceState = {
    context?: Pick<GameContext, 'currentPlaceId'>;
    locationLedger?: readonly LocationEntry[];
};

export function combatMapTexts(proposal: Pick<CombatProposal, 'reason'>, state: CombatMapSourceState): string[] {
    const placeId = state.context?.currentPlaceId;
    const location = placeId ? (state.locationLedger ?? []).find(l => l.id === placeId) : undefined;
    return [proposal.reason, location?.name, location?.description, location?.terrainBiome]
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
}

export function resolveCombatMap(
    proposal: Pick<CombatProposal, 'map' | 'reason' | 'combatants'>,
    state: CombatMapSourceState,
    overrides: Partial<CombatMapSpec> = {},
): CombatResolvedMap {
    return resolveMapSpec({ ...(proposal.map ?? {}), ...overrides }, {
        combatants: proposal.combatants.length,
        texts: combatMapTexts(proposal, state),
    });
}
