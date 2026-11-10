import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../../types';
import { buildAllocationView, resetAll, resetRow, setRowPct } from '../contextAllocationModel';

const base = (over: Partial<AppSettings> = {}) => ({ contextLimit: 8192, rulesBudgetPct: 0.10, ...over }) as AppSettings;
const total = (v: ReturnType<typeof buildAllocationView>) => v.segments.reduce((s, x) => s + x.tokens, 0);

describe('context allocation screen model', () => {
    it('balance bar always adds up to the whole limit', () => {
        expect(total(buildAllocationView(base(), 0))).toBe(8192);
        expect(total(buildAllocationView(base({ contextAllocation: { recall: 20, facts: 15 } }), 300))).toBe(8192);
    });

    it('a slider stops at the space that is still free', () => {
        let s = base({ contextAllocation: { recall: 60 } });
        let view = buildAllocationView(s, 0);
        const patch = setRowPct(s, view, 'lore', 90);
        s = { ...s, ...patch } as AppSettings;
        view = buildAllocationView(s, 0);
        expect(s.contextAllocation!.lore!).toBeLessThan(90);
        expect(view.currentSceneTokens).toBeGreaterThanOrEqual(0);
        expect(total(view)).toBe(8192);
        // Nothing is free for another row now.
        expect(view.rows.find(r => r.id === 'reply')!.maxPct).toBeLessThan(1);
    });

    it('typing 12.5% on an 8,192 limit is 1,024 tokens', () => {
        const s = base();
        const patch = setRowPct(s, buildAllocationView(s, 0), 'lore', 12.5);
        const view = buildAllocationView({ ...s, ...patch } as AppSettings, 0);
        expect(view.rows.find(r => r.id === 'lore')!.tokens).toBe(1024);
    });

    it('reset returns rows to Automatic', () => {
        const s = base({ contextAllocation: { recall: 20 }, rulesBudgetPct: 0.2, sceneRecallBudget: 6000 });
        expect(resetRow(s, 'recall')).toEqual({ contextAllocation: undefined, sceneRecallBudget: 3000 });
        expect(resetRow(s, 'rules')).toEqual({ rulesBudgetPct: 0.10 });
        expect(resetAll()).toEqual({ contextAllocation: undefined, rulesBudgetPct: 0.10, sceneRecallBudget: 3000 });
    });
});
