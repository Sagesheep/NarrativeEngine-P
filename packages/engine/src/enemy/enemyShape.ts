// Shared enemy shape — Project 5 / WO-P5-03 Step 4.
//
// The two schema files in the repo — server/lib/enemySchema.js and
// src/services/enemy/enemySchema.ts — are hand-kept mirrors. They define the
// same EnemyEntry field set, the same text/list field-name lists, and the
// same enum sets (encounter status/outcome, instance disposition, initiative
// mode, barrier mode) in two places. WO-P5-03 §5 Step 4: extract the shared
// shape here, point both at it, prove with the existing tests UNMODIFIED.
//
// This file is the shape only — field names, enum sets, the EnemyEntry field
// list. It contains NO validation/normalization logic. The two consumers keep
// their own logic (the server rejects with indexed errors, the client drops
// malformed fields silently); they just stop duplicating the field names and
// enum values. Adding a new enemy field touches this file, not two.
//
// Pure (no React, no node:*, no better-sqlite3). The server consumes the built
// dist; the client consumes it via @narrative/engine.

/**
 * EnemyEntry text (string-or-empty) fields. The server loops over these in
 * validateEnemyEntry; the client assigns each explicitly in normalizeEnemyEntry
 * (kept explicit so the test's exact-field assertions cannot drift). Both
 * import the SAME list so a new field is added in one place.
 */
export const ENEMY_TEXT_FIELDS = Object.freeze([
    'aliases', 'classification', 'description', 'threatTier', 'faction',
    'tactics', 'loot', 'gmNotes',
] as const);

/**
 * EnemyEntry string-list fields. Same contract as ENEMY_TEXT_FIELDS.
 */
export const ENEMY_LIST_FIELDS = Object.freeze([
    'tags', 'passiveTraits', 'specialBehaviors', 'weaknesses', 'resistances',
] as const);

/**
 * Encounter status enum. Used by the server's validateEnemyEncounter and the
 * client's normalizeEnemyEncounter (enemyEncounter.ts). Both previously
 * declared their own `new Set(['active','paused','ended'])`.
 */
export const ENCOUNTER_STATUSES = Object.freeze(['active', 'paused', 'ended'] as const);

/**
 * Encounter outcome enum. Used by validateEnemyResolution and
 * normalizeEnemyResolution (enemyResolution.ts).
 */
export const ENCOUNTER_OUTCOMES = Object.freeze([
    'victory', 'partial', 'defeat', 'escaped', 'negotiated', 'other',
] as const);

/**
 * Instance disposition enum (what happens to resolved instances).
 */
export const INSTANCE_DISPOSITIONS = Object.freeze(['archive', 'discard'] as const);

/**
 * Initiative mode enum (combat config).
 */
export const INITIATIVE_MODES = Object.freeze(['manual', 'd20', 'd100'] as const);

/**
 * Barrier mode enum (combat config).
 */
export const BARRIER_MODES = Object.freeze(['manual', 'absorb-first'] as const);

/**
 * The full EnemyEntry field set, in the order both validators build it. Used
 * as a reference list — the two consumers build the object inline (the server
 * with a spread over text/list fields, the client with explicit assignments),
 * so this list is the single source of truth for "what fields an EnemyEntry
 * has" without dictating how they are assigned.
 */
export const ENEMY_ENTRY_FIELDS = Object.freeze([
    'id', 'name', 'aliases', 'classification', 'description', 'threatTier', 'tags',
    'faction', 'stats', 'actions', 'passiveTraits', 'specialBehaviors',
    'weaknesses', 'resistances', 'tactics', 'loot', 'gmNotes',
    'promptEnabled', 'createdAt', 'updatedAt',
] as const);

/** Test helper: is `value` one of the enum's members? */
export function isEncounterStatus(value: unknown): value is (typeof ENCOUNTER_STATUSES)[number] {
    return typeof value === 'string' && (ENCOUNTER_STATUSES as readonly string[]).includes(value);
}
export function isEncounterOutcome(value: unknown): value is (typeof ENCOUNTER_OUTCOMES)[number] {
    return typeof value === 'string' && (ENCOUNTER_OUTCOMES as readonly string[]).includes(value);
}
export function isInstanceDisposition(value: unknown): value is (typeof INSTANCE_DISPOSITIONS)[number] {
    return typeof value === 'string' && (INSTANCE_DISPOSITIONS as readonly string[]).includes(value);
}
export function isInitiativeMode(value: unknown): value is (typeof INITIATIVE_MODES)[number] {
    return typeof value === 'string' && (INITIATIVE_MODES as readonly string[]).includes(value);
}
export function isBarrierMode(value: unknown): value is (typeof BARRIER_MODES)[number] {
    return typeof value === 'string' && (BARRIER_MODES as readonly string[]).includes(value);
}