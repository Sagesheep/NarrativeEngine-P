import { describe, expect, it } from 'vitest';
import { computeBudgets } from '../../payload/budgets';
import { budgetClaims } from '../../payload/budgetClaims';
import { ensureEnemyBudgetClaim } from '../enemyPayloadSegment';

/**
 * Moved here by Phase 7.5 from `payload/__tests__/enemyBudget.test.ts`, with
 * its assertions unchanged.
 *
 * The claim it covers no longer registers inside `src/services/payload/` — it
 * registers from the subsystem that spends it, so that uninstalling the
 * subsystem takes the allocation with it. A test for a subsystem's claim
 * belongs beside the subsystem for the same reason.
 */
describe('enemy prompt budget', () => {
    it('scales conservatively with the configured context and has a hard ceiling', () => {
        ensureEnemyBudgetClaim();
        // Phase 7.4 — the budget map is keyed by claim id (`budgetMap.get('enemy')`),
        // not by feature name (`budgetMap.enemy`). The numbers are unchanged:
        // 2.5% of `limit`, capped at 1024.
        expect(computeBudgets(16_384, undefined, false).budgetMap.get('enemy')).toBe(409);
        expect(computeBudgets(32_768, undefined, false).budgetMap.get('enemy')).toBe(819);
        expect(computeBudgets(131_072, undefined, false).budgetMap.get('enemy')).toBe(1_024);
    });

    it('is absent until the subsystem asks for it (Phase 7.5 — absence is quiet)', () => {
        // The Phase 8 rehearsal, at the registration end rather than the
        // unregistration end: a budget map built without the subsystem having
        // registered carries no allocation for it, and reading the id returns
        // zero rather than throwing or falling back to a default.
        ensureEnemyBudgetClaim();
        const claim = budgetClaims.get('enemy');
        budgetClaims.unregister('enemy');
        try {
            expect(computeBudgets(32_768, undefined, false).budgetMap.get('enemy')).toBe(0);
        } finally {
            if (claim) budgetClaims.register(claim);
        }
    });
});
