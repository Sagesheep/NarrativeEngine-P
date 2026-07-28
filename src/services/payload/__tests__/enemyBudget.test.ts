import { describe, expect, it } from 'vitest';
import { computeBudgets } from '../budgets';

describe('enemy prompt budget', () => {
    it('scales conservatively with the configured context and has a hard ceiling', () => {
        expect(computeBudgets(16_384, undefined, false).budgetMap.enemy).toBe(409);
        expect(computeBudgets(32_768, undefined, false).budgetMap.enemy).toBe(819);
        expect(computeBudgets(131_072, undefined, false).budgetMap.enemy).toBe(1_024);
    });
});
