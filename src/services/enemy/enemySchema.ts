import type { EnemyAction, EnemyEntry, EnemyStat } from '../../types';
// Shared enemy shape (WO-P5-03 Step 4): the field-name lists and enum sets live
// in @narrative/engine so the server (server/lib/enemySchema.js) and this
// client file stop being hand-kept mirrors. This file keeps its own
// normalization logic (it drops malformed fields silently, where the server
// rejects with indexed errors) — only the duplicated field-name set retires.
// The `ENEMY_ENTRY_FIELDS` import is the single source of truth for "what
// fields an EnemyEntry has"; the type guard below asserts the inline
// assignments in normalizeEnemyEntry stay in lock-step with it.
import { ENEMY_ENTRY_FIELDS } from '@narrative/engine';

type UnknownRecord = Record<string, unknown>;

// Compile-time guarantee that the EnemyEntry type's keys are exactly the
// shared field set. If a field is added to EnemyEntry but not to
// ENEMY_ENTRY_FIELDS (or vice versa), this line fails to compile — which is
// the "stop being hand-kept mirrors" contract.
type _EntryKeys = keyof EnemyEntry;
type _SharedKeys = (typeof ENEMY_ENTRY_FIELDS)[number];
type _EntryMatchesShared< T extends _EntryKeys = _SharedKeys, U extends _SharedKeys = _EntryKeys> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
const _entryMatchesShared: _EntryMatchesShared = true as _EntryMatchesShared;
void _entryMatchesShared;

export type NormalizeEnemyOptions = {
    now?: number;
    createId?: () => string;
};

/** Creates a fully controlled blank template for manual or approved discovery use. */
export function createEmptyEnemyEntry(
    name = '',
    classification = '',
    options: NormalizeEnemyOptions = {},
): EnemyEntry {
    const now = options.now ?? Date.now();
    const createId = options.createId ?? (() => crypto.randomUUID());
    return {
        id: createId(),
        name: name.trim(),
        aliases: '',
        classification: classification.trim(),
        description: '',
        threatTier: '',
        tags: [],
        faction: '',
        stats: [],
        actions: [],
        passiveTraits: [],
        specialBehaviors: [],
        weaknesses: [],
        resistances: [],
        tactics: '',
        loot: '',
        gmNotes: '',
        promptEnabled: true,
        createdAt: now,
        updatedAt: now,
    };
}

const isRecord = (value: unknown): value is UnknownRecord =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Canonical whole-word form used for safe name/alias equality and deduping. */
export const canonicalEnemyName = (value: string): string =>
    (value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).join(' ');

const optionalText = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const optionalStringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : [];

const optionalStats = (value: unknown): EnemyStat[] =>
    Array.isArray(value)
        ? value.flatMap(item => {
            if (!isRecord(item)) return [];
            const name = optionalText(item.name);
            if (!name) return [];
            return [{ name, value: optionalText(item.value) }];
        })
        : [];

const optionalActions = (value: unknown): EnemyAction[] =>
    Array.isArray(value)
        ? value.flatMap(item => {
            if (!isRecord(item)) return [];
            const name = optionalText(item.name);
            if (!name) return [];
            return [{ name, description: optionalText(item.description) }];
        })
        : [];

/**
 * Converts imported or persisted unknown data into the safe, known EnemyEntry
 * shape. Optional null/malformed fields become empty values and unknown fields
 * are discarded. A missing name makes the whole record unusable.
 */
export function normalizeEnemyEntry(
    value: unknown,
    options: NormalizeEnemyOptions = {},
): EnemyEntry | null {
    if (!isRecord(value)) return null;
    const name = optionalText(value.name);
    if (!name) return null;

    const now = options.now ?? Date.now();
    const createId = options.createId ?? (() => crypto.randomUUID());
    const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
        ? value.createdAt
        : now;
    const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
        ? value.updatedAt
        : now;

    return {
        id: optionalText(value.id) || createId(),
        name,
        aliases: optionalText(value.aliases),
        classification: optionalText(value.classification),
        description: optionalText(value.description),
        threatTier: optionalText(value.threatTier),
        tags: optionalStringList(value.tags),
        faction: optionalText(value.faction),
        stats: optionalStats(value.stats),
        actions: optionalActions(value.actions),
        passiveTraits: optionalStringList(value.passiveTraits),
        specialBehaviors: optionalStringList(value.specialBehaviors),
        weaknesses: optionalStringList(value.weaknesses),
        resistances: optionalStringList(value.resistances),
        tactics: optionalText(value.tactics),
        loot: optionalText(value.loot),
        gmNotes: optionalText(value.gmNotes),
        promptEnabled: typeof value.promptEnabled === 'boolean' ? value.promptEnabled : true,
        createdAt,
        updatedAt,
    };
}

/** Normalizes an unknown list and reports records that could not be identified. */
export function normalizeEnemyEntries(
    value: unknown,
    options: NormalizeEnemyOptions = {},
): { entries: EnemyEntry[]; skipped: number } {
    if (!Array.isArray(value)) return { entries: [], skipped: 0 };
    const entries = value
        .map(item => normalizeEnemyEntry(item, options))
        .filter((entry): entry is EnemyEntry => entry !== null);
    return { entries, skipped: value.length - entries.length };
}
