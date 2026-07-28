import type {
    AbilityCategory,
    AbilityOwnerType,
    AbilityOrigin,
    AbilityProposal,
    AbilityProposalKind,
} from '../../types';
import { ABILITY_CATEGORIES, ABILITY_ORIGINS } from './abilitySchema';

type UnknownRecord = Record<string, unknown>;

export type AbilityProposalOptions = {
    now?: number;
    createId?: () => string;
};

const isRecord = (value: unknown): value is UnknownRecord =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown, max = 4_000): string =>
    typeof value === 'string' ? value.trim().slice(0, max) : '';

const nonNegativeInteger = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const proposalKind = (value: unknown): AbilityProposalKind | null =>
    value === 'new' || value === 'assign' || value === 'progression' ? value : null;

const ownerType = (value: unknown): AbilityOwnerType | null =>
    value === 'pc' || value === 'npc' ? value : null;

const category = (value: unknown): AbilityCategory =>
    typeof value === 'string' && ABILITY_CATEGORIES.includes(value as AbilityCategory)
        ? value as AbilityCategory
        : 'other';

const origin = (value: unknown): AbilityOrigin =>
    typeof value === 'string' && ABILITY_ORIGINS.includes(value as AbilityOrigin)
        ? value as AbilityOrigin
        : 'trained';

export function normalizeAbilityProposal(
    value: unknown,
    options: AbilityProposalOptions = {},
): AbilityProposal | null {
    if (!isRecord(value)) return null;
    const kind = proposalKind(value.kind);
    if (!kind) return null;
    const abilityId = text(value.abilityId, 160);
    const abilityName = text(value.abilityName, 120);
    if (kind === 'new' ? !abilityName : !abilityId) return null;

    const now = options.now ?? Date.now();
    const createId = options.createId ?? (() => crypto.randomUUID());
    const normalizedOwnerType = ownerType(value.ownerType);
    const normalizedOwnerId = text(value.ownerId, 160);
    return {
        id: text(value.id, 160) || createId(),
        kind,
        abilityId,
        abilityName,
        ownerType: normalizedOwnerType && normalizedOwnerId ? normalizedOwnerType : null,
        ownerId: normalizedOwnerType ? normalizedOwnerId : '',
        category: category(value.category),
        origin: origin(value.origin),
        effect: text(value.effect),
        activation: text(value.activation),
        mastery: text(value.mastery, 120),
        masteryTierId: text(value.masteryTierId, 160),
        modification: text(value.modification, 500),
        upgradeId: text(value.upgradeId, 160),
        trainingDelta: nonNegativeInteger(value.trainingDelta),
        reason: text(value.reason, 500),
        evidence: text(value.evidence, 1_000),
        sourceSceneId: text(value.sourceSceneId, 160),
        sourceProfileAbility: text(value.sourceProfileAbility, 1_000) || undefined,
        createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
            ? value.createdAt
            : now,
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
            ? value.updatedAt
            : now,
    };
}

export function normalizeAbilityProposals(
    value: unknown,
    options: AbilityProposalOptions = {},
): { entries: AbilityProposal[]; skipped: number } {
    if (!Array.isArray(value)) return { entries: [], skipped: 0 };
    const entries = value
        .map(item => normalizeAbilityProposal(item, options))
        .filter((entry): entry is AbilityProposal => entry !== null);
    return { entries, skipped: value.length - entries.length };
}
