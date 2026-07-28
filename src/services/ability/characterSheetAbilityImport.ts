import type {
    AbilityCategory,
    AbilityEntry,
    AbilityOrigin,
    AbilityProposal,
    CharacterAbility,
} from '../../types';

type AbilityProposalDraft = Omit<AbilityProposal, 'id' | 'createdAt' | 'updatedAt'>;

export type CharacterSheetAbilityImportResult = {
    proposals: AbilityProposalDraft[];
    alreadyTrackedSources: string[];
    pendingSources: string[];
};

const canonical = (value: string) =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const trimTrailingDetails = (value: string) =>
    value.replace(/\s*\([^)]*\)\s*$/, '').trim() || value.trim();

export function parseCharacterSheetAbility(source: string): {
    name: string;
    category: AbilityCategory;
    origin: AbilityOrigin;
    effect: string;
    activation: string;
} | null {
    const text = source.trim();
    if (!text) return null;

    const cantrip = text.match(/^cantrip\s*:\s*(.+)$/i);
    if (cantrip) {
        return {
            name: trimTrailingDetails(cantrip[1]),
            category: 'active',
            origin: 'spell',
            effect: text,
            activation: 'Cast as a cantrip',
        };
    }

    const levelledSpell = text.match(/^((?:\d+(?:st|nd|rd|th)|[a-z]+)-level)\s+spell\s*:\s*(.+)$/i);
    if (levelledSpell) {
        return {
            name: trimTrailingDetails(levelledSpell[2]),
            category: 'active',
            origin: 'spell',
            effect: text,
            activation: `Cast as a ${levelledSpell[1].toLocaleLowerCase()} spell`,
        };
    }

    const labelled = text.match(/^(weapon mastery|origin feat)\s*:\s*(.+)$/i);
    if (labelled) {
        const label = labelled[1].replace(/\b\w/g, character => character.toLocaleUpperCase());
        return {
            name: `${label}: ${trimTrailingDetails(labelled[2])}`,
            category: labelled[1].toLocaleLowerCase() === 'origin feat' ? 'passive' : 'active',
            origin: 'trained',
            effect: text,
            activation: '',
        };
    }

    const colon = text.indexOf(':');
    if (colon > 0) {
        return {
            name: trimTrailingDetails(text.slice(0, colon)),
            category: 'active',
            origin: 'trained',
            effect: text.slice(colon + 1).trim() || text,
            activation: '',
        };
    }

    const name = trimTrailingDetails(text);
    const passive = /\b(darkvision|resistance|immunity|presence|feat|proficiency)\b/i.test(text);
    return {
        name,
        category: passive ? 'passive' : 'active',
        origin: passive ? 'innate' : 'trained',
        effect: text,
        activation: '',
    };
}

export function buildCharacterSheetAbilityImport(
    sources: string[],
    ownerId: string,
    abilities: AbilityEntry[],
    assignments: CharacterAbility[],
    pending: AbilityProposal[],
): CharacterSheetAbilityImportResult {
    const abilityByName = new Map<string, AbilityEntry>();
    for (const ability of abilities) {
        for (const name of [ability.name, ...ability.aliases.split(',')]) {
            const key = canonical(name);
            if (key && !abilityByName.has(key)) abilityByName.set(key, ability);
        }
    }

    const ownedAbilityIds = new Set(assignments
        .filter(entry => entry.ownerType === 'pc' && entry.ownerId === ownerId)
        .map(entry => entry.abilityId));
    const pendingKeys = new Set(pending
        .filter(entry => entry.ownerType === 'pc' && entry.ownerId === ownerId)
        .map(entry => entry.abilityId || canonical(entry.abilityName)));
    const seen = new Set<string>();
    const proposals: AbilityProposalDraft[] = [];
    const alreadyTrackedSources: string[] = [];
    const pendingSources: string[] = [];

    for (const source of sources) {
        const parsed = parseCharacterSheetAbility(source);
        if (!parsed) continue;
        const nameKey = canonical(parsed.name);
        if (!nameKey || seen.has(nameKey)) continue;
        seen.add(nameKey);

        const known = abilityByName.get(nameKey);
        if (known && ownedAbilityIds.has(known.id)) {
            alreadyTrackedSources.push(source);
            continue;
        }

        const proposalKey = known?.id || nameKey;
        if (pendingKeys.has(proposalKey)) {
            pendingSources.push(source);
            continue;
        }

        proposals.push({
            kind: known ? 'assign' : 'new',
            abilityId: known?.id ?? '',
            abilityName: parsed.name,
            ownerType: 'pc',
            ownerId,
            category: parsed.category,
            origin: parsed.origin,
            effect: parsed.effect,
            activation: parsed.activation,
            mastery: '',
            masteryTierId: '',
            modification: '',
            upgradeId: '',
            trainingDelta: 0,
            reason: 'Imported from the player character sheet for review.',
            evidence: source.trim(),
            sourceSceneId: '',
            sourceProfileAbility: source,
        });
    }

    return { proposals, alreadyTrackedSources, pendingSources };
}
