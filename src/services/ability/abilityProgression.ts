import type { AbilityEntry, AbilityUpgradeNode, CharacterAbility } from '../../types';

export type UpgradeAvailability = {
    available: boolean;
    reasons: string[];
};

const tierIndex = (ability: AbilityEntry, tierId: string): number =>
    ability.masteryLadder.findIndex(tier => tier.id === tierId);

/** Evaluates only structured prerequisites; prose requirements remain player-reviewed. */
export function getUpgradeAvailability(
    ability: AbilityEntry,
    assignment: CharacterAbility,
    upgrade: AbilityUpgradeNode,
): UpgradeAvailability {
    const reasons: string[] = [];
    if (upgrade.prerequisiteTierId) {
        const requiredIndex = tierIndex(ability, upgrade.prerequisiteTierId);
        const currentIndex = tierIndex(ability, assignment.masteryTierId);
        if (requiredIndex >= 0 && currentIndex < requiredIndex) {
            const tier = ability.masteryLadder[requiredIndex];
            reasons.push(`Requires ${tier?.name ?? 'a higher mastery tier'}`);
        }
    }
    for (const prerequisiteId of upgrade.prerequisiteUpgradeIds) {
        if (!assignment.unlockedUpgradeIds.includes(prerequisiteId)) {
            const prerequisite = ability.upgradeNodes.find(node => node.id === prerequisiteId);
            reasons.push(`Requires ${prerequisite?.name ?? 'another upgrade'}`);
        }
    }
    return { available: reasons.length === 0, reasons };
}

export function setCharacterMasteryTier(
    ability: AbilityEntry,
    assignment: CharacterAbility,
    masteryTierId: string,
): CharacterAbility {
    const tier = ability.masteryLadder.find(candidate => candidate.id === masteryTierId);
    let next = {
        ...assignment,
        masteryTierId: tier?.id ?? '',
        mastery: tier?.name ?? assignment.mastery,
    };
    let changed = true;
    while (changed) {
        changed = false;
        for (const upgradeId of next.unlockedUpgradeIds) {
            const upgrade = ability.upgradeNodes.find(node => node.id === upgradeId);
            if (upgrade && !getUpgradeAvailability(ability, next, upgrade).available) {
                next = {
                    ...next,
                    unlockedUpgradeIds: next.unlockedUpgradeIds.filter(id => id !== upgradeId),
                };
                changed = true;
            }
        }
    }
    return next;
}

export function toggleCharacterUpgrade(
    ability: AbilityEntry,
    assignment: CharacterAbility,
    upgradeId: string,
): CharacterAbility {
    if (assignment.unlockedUpgradeIds.includes(upgradeId)) {
        const blockedDependants = new Set([upgradeId]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const node of ability.upgradeNodes) {
                if (!blockedDependants.has(node.id)
                    && node.prerequisiteUpgradeIds.some(id => blockedDependants.has(id))) {
                    blockedDependants.add(node.id);
                    changed = true;
                }
            }
        }
        return {
            ...assignment,
            unlockedUpgradeIds: assignment.unlockedUpgradeIds.filter(id => !blockedDependants.has(id)),
        };
    }
    const upgrade = ability.upgradeNodes.find(node => node.id === upgradeId);
    if (!upgrade || !getUpgradeAvailability(ability, assignment, upgrade).available) return assignment;
    return { ...assignment, unlockedUpgradeIds: [...assignment.unlockedUpgradeIds, upgradeId] };
}
