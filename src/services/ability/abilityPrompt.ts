import type { AbilityEntry, AbilityRuntimeState, AbilityTerminology, CharacterAbility, ChatMessage, InventoryItem, NPCEntry } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { normalizeAbilityTerminology, resolveAbilityCategoryLabel, resolveAbilityOriginLabel } from './abilitySchema';

export const MAX_RELEVANT_ABILITY_MATCHES = 4;

export type AbilityOwnershipContext = {
    characterAbilities?: CharacterAbility[];
    abilityRuntimeStates?: AbilityRuntimeState[];
    playerCharacter?: NPCEntry | null;
    npcLedger?: NPCEntry[];
    onStageNpcIds?: string[];
    inventoryItems?: InventoryItem[];
    terminology?: AbilityTerminology;
};

const normalizedWords = (value: string): string[] =>
    value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

const containsExactPhrase = (textWords: string[], phrase: string): boolean => {
    const phraseWords = normalizedWords(phrase);
    if (!phraseWords.length || phraseWords.length > textWords.length) return false;
    return textWords.some((word, start) =>
        word === phraseWords[0]
        && phraseWords.every((phraseWord, offset) => textWords[start + offset] === phraseWord));
};

const canonicalTag = (value: string) => value.toLocaleLowerCase().trim();

const activeGrantItem = (ability: AbilityEntry, inventoryItems: InventoryItem[] = []): InventoryItem | null => {
    if (ability.origin !== 'item-granted') return null;
    const item = inventoryItems.find(candidate =>
        candidate.id === ability.sourceInventoryItemId
        && candidate.qty > 0
        && (candidate.locationTag ?? 'inventory') === 'inventory');
    if (!item || (ability.inventoryRequiresEquipped && !item.equipped)) return null;
    return item;
};

const interactsWith = (left: AbilityEntry, right: AbilityEntry): boolean => {
    const leftInteractions = new Set((left.interactionTags ?? []).map(canonicalTag));
    const leftCounters = new Set((left.counterTags ?? []).map(canonicalTag));
    const rightInteractions = new Set((right.interactionTags ?? []).map(canonicalTag));
    const rightCounters = new Set((right.counterTags ?? []).map(canonicalTag));
    return [...leftCounters].some(tag => rightInteractions.has(tag))
        || [...rightCounters].some(tag => leftInteractions.has(tag));
};

/**
 * Selects only enabled definitions named in the current or ten most recent
 * messages. PC, on-stage NPC, and explicitly named-owner assignments annotate
 * the definition with personal mastery and variants without changing canon.
 */
export function buildRelevantAbilityBlock(
    abilities: AbilityEntry[] | undefined,
    history: ChatMessage[],
    userMessage: string,
    tokenBudget = Infinity,
    maxMatches = MAX_RELEVANT_ABILITY_MATCHES,
    ownership: AbilityOwnershipContext = {},
): string {
    if (!abilities?.length || tokenBudget <= 0 || maxMatches <= 0) return '';
    const terminology = normalizeAbilityTerminology(ownership.terminology);
    const textWords = normalizedWords(`${history.slice(-10).map(message => message.content ?? '').join(' ')} ${userMessage}`);
    const eligible = abilities.filter(ability => {
        if (ability.promptEnabled === false) return false;
        if (ability.loreCheckRequired && ability.loreStatus !== 'verified') return false;
        if (ability.origin === 'item-granted' && !activeGrantItem(ability, ownership.inventoryItems)) return false;
        return true;
    });
    const named = eligible.filter(ability => {
        const aliases = ability.aliases.split(',').map(alias => alias.trim()).filter(Boolean);
        return [ability.name, ...aliases].some(name => containsExactPhrase(textWords, name));
    });
    const relevant = [...named];
    for (const seed of named) {
        for (const candidate of eligible) {
            if (relevant.length >= maxMatches) break;
            if (!relevant.includes(candidate) && interactsWith(seed, candidate)) relevant.push(candidate);
        }
    }
    relevant.splice(maxMatches);
    if (!relevant.length) return '';

    const header = '[RELEVANT ABILITY RULES — canonical definitions and owner-specific variants]';
    const footer = '[END ABILITY RULES]';
    const rendered: string[] = [];

    for (const ability of relevant) {
        const owned = (ownership.characterAbilities ?? [])
            .filter(entry => entry.abilityId === ability.id && entry.promptEnabled !== false)
            .flatMap(entry => {
                const owner = entry.ownerType === 'pc'
                    ? ownership.playerCharacter?.id === entry.ownerId ? ownership.playerCharacter : null
                    : ownership.npcLedger?.find(npc => npc.id === entry.ownerId) ?? null;
                if (!owner) return [];
                const explicitlyMentioned = containsExactPhrase(textWords, owner.name);
                const active = entry.ownerType === 'pc' || ownership.onStageNpcIds?.includes(owner.id);
                if (!active && !explicitlyMentioned) return [];
                return [{ entry, owner, priority: entry.ownerType === 'pc' ? 0 : active ? 1 : 2 }];
            })
            .sort((a, b) => a.priority - b.priority || a.owner.name.localeCompare(b.owner.name))
            .slice(0, 3);

        const ownershipLines = owned.flatMap(({ entry, owner }) => {
            const runtime = ownership.abilityRuntimeStates?.find(state =>
                state.characterAbilityId === entry.id);
            const runtimeStatus = runtime
                ? runtime.cooldownRemaining > 0
                    ? `COOLDOWN ${runtime.cooldownRemaining}/${runtime.cooldownMax}`
                    : runtime.chargesRemaining === 0 ? 'NO CHARGES' : 'READY'
                : '';
            const chargeStatus = runtime?.chargesMax == null
                ? ''
                : ` | CHARGES ${runtime.chargesRemaining}/${runtime.chargesMax}`;
            const tier = ability.masteryLadder.find(candidate => candidate.id === entry.masteryTierId);
            const upgrades = ability.upgradeNodes.filter(node => (entry.unlockedUpgradeIds ?? []).includes(node.id));
            const completedMilestones = (entry.trainingMilestones ?? []).filter(milestone => milestone.completed);
            return [
                `KNOWN BY: ${owner.name}${tier?.name || entry.mastery ? ` | MASTERY: ${tier?.name || entry.mastery}` : ''}${entry.variantName ? ` | VARIANT: ${entry.variantName}` : ''}`,
                upgrades.length && `UNLOCKED UPGRADES (${owner.name}): ${upgrades.map(upgrade => upgrade.name).join('; ')}`,
                ((entry.trainingGoal ?? 0) > 0 || (entry.trainingProgress ?? 0) > 0) && `TRAINING (${owner.name}): ${entry.trainingProgress ?? 0}/${entry.trainingGoal || '?'}`,
                completedMilestones.length && `COMPLETED MILESTONES (${owner.name}): ${completedMilestones.map(milestone => milestone.name).join('; ')}`,
                entry.modifications.length && `OWNER MODIFICATIONS (${owner.name}): ${entry.modifications.join('; ')}`,
                runtime && `RUNTIME (${owner.name}): ${runtimeStatus}${chargeStatus} | USES ${runtime.uses}${runtime.lastUsedSceneId ? ` | LAST USED scene ${runtime.lastUsedSceneId}` : ''}`,
                runtime?.activeEffects.length && `ACTIVE EFFECTS (${owner.name}): ${runtime.activeEffects.map(effect =>
                    `${effect.name} (${effect.remainingTurns} turn${effect.remainingTurns === 1 ? '' : 's'}${effect.notes ? `; ${effect.notes}` : ''})`).join('; ')}`,
                runtime?.notes && `RUNTIME NOTES (${owner.name}): ${runtime.notes}`,
                entry.learnedSceneId && `LEARNED (${owner.name}): scene ${entry.learnedSceneId}`,
                entry.notes && `OWNERSHIP NOTES (${owner.name}): ${entry.notes}`,
            ].filter((line): line is string => Boolean(line));
        });
        const grantItem = activeGrantItem(ability, ownership.inventoryItems);
        if (grantItem && ownership.playerCharacter) {
            ownershipLines.unshift(
                `KNOWN BY: ${ownership.playerCharacter.name} | GRANTED BY ITEM: ${grantItem.name}${ability.inventoryRequiresEquipped ? ' (equipped)' : ''}`,
            );
        }

        const lines = [
            `ABILITY: ${ability.name}`,
            `CATEGORY: ${ability.category} [${resolveAbilityCategoryLabel(ability.category, terminology)}] | ORIGIN: ${ability.origin ?? 'trained'} [${resolveAbilityOriginLabel(ability.origin ?? 'trained', terminology)}]`,
            ...ownershipLines,
            ability.effect && `EFFECT: ${ability.effect}`,
            ability.activation && `ACTIVATION: ${ability.activation}`,
            ability.costs.length && `COSTS: ${ability.costs.map(cost =>
                [cost.resource, cost.amount, cost.timing, cost.condition].filter(Boolean).join(' | ')).join('; ')}`,
            ability.range && `RANGE: ${ability.range}`,
            ability.targets && `TARGETS: ${ability.targets}`,
            ability.duration && `DURATION: ${ability.duration}`,
            ability.area && `AREA: ${ability.area}`,
            ability.limitations.length && `LIMITS: ${ability.limitations.join('; ')}`,
            ability.counters.length && `COUNTERS: ${ability.counters.join('; ')}`,
            ability.prerequisites.length && `PREREQUISITES: ${ability.prerequisites.join('; ')}`,
            ability.interactionTags?.length && `INTERACTION TAGS: ${ability.interactionTags.join('; ')}`,
            ability.counterTags?.length && `COUNTER TAGS: ${ability.counterTags.join('; ')}`,
            ability.outcomeGuidance && `OUTCOMES: ${ability.outcomeGuidance}`,
            ability.description && `DESCRIPTION: ${ability.description}`,
            ability.appearance && `APPEARANCE: ${ability.appearance}`,
            ability.gmNotes && `GM NOTES: ${ability.gmNotes}`,
        ].filter((line): line is string => Boolean(line));

        let accepted = '';
        for (const line of lines) {
            const candidateRecord = accepted ? `${accepted}\n${line}` : line;
            const candidate = [header, ...rendered, candidateRecord, footer].join('\n\n');
            if (countTokens(candidate) <= tokenBudget) accepted = candidateRecord;
        }
        if (!accepted || !accepted.startsWith(`ABILITY: ${ability.name}`)) break;
        rendered.push(accepted);
    }

    return rendered.length ? [header, ...rendered, footer].join('\n\n') : '';
}
