/**
 * Phase 7.5 — the enemy subsystem's own payload registration.
 *
 * Everything the payload path used to know about enemies lives here now: the
 * budget claim, the block's rendering rules, its `promptContextEnabled` gate,
 * its trace label, and the `inCombat` fact it establishes. `payloadBuilder.ts`
 * imports nothing from this directory.
 *
 * **The dependency direction is inverted on purpose.** Before this phase the
 * payload layer imported `../enemy/enemyPrompt` and `../enemy/enemyEncounter`;
 * now the enemy layer imports the payload layer's two generic seams
 * (`volatileSegments.ts`, `budgetClaims.ts`). Core can therefore be built,
 * tested and shipped with this file deleted — which is the whole of Phase 7.5's
 * §3 item 3, and what Phase 8.3 will do when the enemy mod takes over.
 *
 * **Phase 8.3 deletes this file.** Its two callers
 * (`turn/turnStages.ts`, `components/hooks/useSceneContinue.ts`) each drop one
 * line, and the enemy mod contributes its block through the generation
 * interceptor (Phase 5.2) and claims its budget through `ctx.budgets.claim`
 * (Phase 7.4) instead. Nothing in `src/services/payload/` changes.
 */
import type { ChatMessage, EnemyCombatConfig, EnemyEncounter, EnemyEntry, EnemyInstance } from '../../types';
import { budgetClaims } from '../payload/budgetClaims';
import type { VolatileSegment, VolatileSegmentOutput } from '../payload/volatileSegments';
import { buildActiveEncounterBlock } from './enemyEncounter';
import { buildRelevantEnemyBlock } from './enemyPrompt';

/**
 * The segment id, and therefore the budget claim id
 * (`VolatileSegmentContext.budget` resolves `budgetMap.get(segment.id)`).
 *
 * Unchanged from Phase 7.4's built-in claim so the allocation, the trace text
 * and any persisted `moduleEnabled` entry keyed on it all stay put.
 */
export const ENEMY_SEGMENT_ID = 'enemy';

/**
 * Between `VOLATILE_ANCHOR.WORLD` (200) and `VOLATILE_ANCHOR.STATE` (400) —
 * exactly where the hand-written `[rules, world, enemyBlock, volatile]` array
 * put it before this phase, which is what keeps the composed block
 * byte-identical.
 */
export const ENEMY_SEGMENT_ORDER = 300;

/** The slice of turn state the enemy block renders from. */
export interface EnemyPromptState {
    readonly enemyCompendium?: EnemyEntry[];
    readonly enemyInstances?: EnemyInstance[];
    readonly enemyEncounters?: EnemyEncounter[];
    readonly enemyCombatConfig?: EnemyCombatConfig;
}

let claimRegistered = false;

/**
 * Register the enemy budget claim. Idempotent, and re-runs after a test called
 * `budgetClaims.clear()` — the same self-healing discipline
 * `ensureBuiltinClaims()` uses for core's four structural claims.
 *
 * The numbers are Phase 7.4's, unchanged: 2.5% of the context limit, capped at
 * 1024 tokens.
 */
export function ensureEnemyBudgetClaim(): void {
    if (claimRegistered && budgetClaims.get(ENEMY_SEGMENT_ID) !== undefined) return;
    claimRegistered = true;
    if (budgetClaims.get(ENEMY_SEGMENT_ID) !== undefined) budgetClaims.unregister(ENEMY_SEGMENT_ID);
    budgetClaims.register({
        id: ENEMY_SEGMENT_ID,
        source: 'builtin',
        name: 'Enemy context',
        description: 'Relevant enemy templates and the active encounter block. Priority-trimmed within the budget.',
        allocate: ({ limit }) => Math.min(1024, Math.floor(limit * 0.025)),
    });
}

/**
 * Build this turn's enemy segment.
 *
 * Closes over the caller's state, so `buildPayload` receives a renderer and
 * never the four enemy fields it used to carry. Registering the budget claim
 * from here rather than at module load means the block and its allocation
 * arrive together: a caller that does not ask for the segment does not reserve
 * the tokens either.
 */
export function buildEnemyVolatileSegment(state: EnemyPromptState): VolatileSegment {
    ensureEnemyBudgetClaim();
    return {
        id: ENEMY_SEGMENT_ID,
        order: ENEMY_SEGMENT_ORDER,
        render({ budget, history, userMessage }): VolatileSegmentOutput {
            // The user's own switch. `promptContextEnabled !== false` (rather
            // than `=== true`) preserves absent-means-on for campaigns saved
            // before the toggle existed.
            const contextEnabled = state.enemyCombatConfig?.promptContextEnabled !== false;
            const activeEncounterBlock = contextEnabled
                ? buildActiveEncounterBlock(state.enemyEncounters, state.enemyInstances, state.enemyCombatConfig, budget)
                : '';
            const text = activeEncounterBlock || (contextEnabled
                ? buildRelevantEnemyBlock(state.enemyCompendium, history as ChatMessage[], userMessage, budget)
                : '');

            // `inCombat` is true only for a live encounter, never for a
            // compendium match — the same distinction the pre-7.5 line
            // `inCombat: activeEncounterBlock !== ''` drew, and the reason the
            // fact is reported even when the block is empty.
            const facts = { inCombat: activeEncounterBlock !== '' };
            if (!text) return { text: '', facts };

            return {
                text,
                trace: {
                    source: activeEncounterBlock ? 'Active Enemy Encounter' : 'Enemy Compendium',
                    classification: 'volatile_state',
                    reason: `Priority-trimmed enemy context (budget ${budget} tokens)`,
                },
                facts,
            };
        },
    };
}
