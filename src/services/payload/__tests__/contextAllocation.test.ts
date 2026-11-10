import { describe, expect, it } from 'vitest';
import type { AppSettings, ArchiveScene } from '../../../types';
import { countTokens } from '../../infrastructure/tokenizer';
import { computeBudgets } from '../budgets';
import {
    customPct, normalizeContextAllocation, resolveAllocation, retrievalBudget, SAFETY_MARGIN_TOKENS,
} from '../contextAllocation';
import { fitBlock, fitLines, fitText } from '../fitToBudget';
import { buildWorld } from '../world';
import { createTraceCollector } from '../traceCollector';

const settings = (over: Partial<AppSettings> = {}) => ({ contextLimit: 8192, rulesBudgetPct: 0.10, ...over }) as AppSettings;

describe('normalizeContextAllocation', () => {
    it('keeps finite 0–100 percentages for known rows and drops the rest', () => {
        expect(normalizeContextAllocation({ recall: 20, lore: 150, facts: -3, bogus: 5, npcs: 'x' }))
            .toEqual({ recall: 20, lore: 100, facts: 0 });
        expect(normalizeContextAllocation({})).toBeUndefined();
        expect(normalizeContextAllocation(null)).toBeUndefined();
    });
});

describe('customPct / retrievalBudget', () => {
    it('treats the default rules share as Automatic and any other value as Custom', () => {
        expect(customPct(settings(), 'rules')).toBeUndefined();
        expect(customPct(settings({ rulesBudgetPct: 0.2 }), 'rules')).toBeCloseTo(20);
    });

    it('fetches with the same number assembly uses', () => {
        expect(retrievalBudget(settings(), 'recall')).toBe(3000);
        expect(retrievalBudget(settings({ contextAllocation: { recall: 20 } }), 'recall')).toBe(1638);
        expect(retrievalBudget(settings({ contextAllocation: { lore: 12.5 } }), 'lore')).toBe(1024);
        expect(retrievalBudget(settings(), 'rules')).toBe(819);
    });
});

describe('resolveAllocation', () => {
    it('reproduces today\'s automatic numbers when there is room', () => {
        const { budgetMap } = computeBudgets(8192, 0.10, false);
        const a = resolveAllocation({ settings: settings(), limit: 8192, hasDeepContext: false, fixedTokens: 100, latestExchangeTokens: 0 });
        expect(a.state).toBe(budgetMap.get('volatile'));
        expect(a.npcFloor).toBe(budgetMap.get('npc'));
        expect(a.pool).toBe(budgetMap.get('world'));
        expect(a.squeezed).toEqual([]);
    });

    it('reserves custom rows first and squeezes automatic ones to stay inside the limit', () => {
        const a = resolveAllocation({
            settings: settings({ contextAllocation: { recall: 50, facts: 30 } }),
            limit: 8192, hasDeepContext: false, fixedTokens: 500, latestExchangeTokens: 400,
        });
        expect(a.recall).toBe(4096);
        expect(a.facts).toBe(2457);
        expect(a.currentSceneMin).toBe(400);
        const used = 500 + SAFETY_MARGIN_TOKENS + a.reply + a.currentSceneMin + a.recall! + a.facts! + a.state + a.npcFloor + a.pool;
        expect(used).toBeLessThanOrEqual(8192);
        expect(a.squeezed.length).toBeGreaterThan(0);
    });

    it('scales custom rows down together when they cannot all fit', () => {
        const a = resolveAllocation({
            settings: settings({ contextAllocation: { recall: 60, lore: 60 } }),
            limit: 8192, hasDeepContext: false, fixedTokens: 0, latestExchangeTokens: 0,
        });
        expect(a.recall! + a.lore!).toBeLessThanOrEqual(8192 - SAFETY_MARGIN_TOKENS);
        expect(a.recall).toBe(a.lore);
        expect(a.squeezed).toEqual(expect.arrayContaining(['recall', 'lore']));
    });

    it('gives the recent conversation its custom minimum before any row', () => {
        const a = resolveAllocation({
            settings: settings({ contextAllocation: { currentScene: 40, reply: 10 } }),
            limit: 8192, hasDeepContext: false, fixedTokens: 0, latestExchangeTokens: 0,
        });
        expect(a.currentSceneMin).toBe(3276);
        expect(a.reply).toBe(819);
    });
});

describe('fitToBudget', () => {
    it('returns the text unchanged when it fits', () => {
        const t = '[TAG]\na\nb\n[END TAG]';
        expect(fitBlock(t, 1000)).toBe(t);
        expect(fitText('hello', 100)).toBe('hello');
    });

    it('keeps the newest lines with keep: last', () => {
        const lines = Array.from({ length: 40 }, (_, i) => `• fact number ${i} about the world`);
        const out = fitLines({ head: '[H]', lines, foot: '[END H]', budget: 60, keep: 'last' });
        expect(out).toContain('fact number 39');
        expect(out).not.toContain('fact number 0 ');
        expect(countTokens(out)).toBeLessThanOrEqual(60);
    });
});

describe('buildWorld with allocation caps', () => {
    const base = {
        history: [], userMessage: 'hi', budgetWorld: 100_000, npcBudgetFloor: 2048,
        collector: createTraceCollector(true),
    };

    it('cuts the best recalled scene to an excerpt and keeps the brief reminders', () => {
        const recall = [
            { sceneId: '001', content: 'The long scene. '.repeat(400), tokens: 0 },
            { sceneId: '002', content: 'A short reminder of the bridge fight.', tokens: 0, form: 'short' },
        ] as unknown as ArchiveScene[];
        const r = buildWorld({ ...base, archiveRecall: recall, allocation: { pool: 0, npcFloor: 0, recall: 400 } });
        expect(r.worldContent).toContain('[ARCHIVE RECALL');
        expect(r.worldContent).toContain('bridge fight');
        expect(countTokens(r.worldContent)).toBeLessThanOrEqual(400);
    });

    it('keeps on-stage NPC core lines before mentioned NPCs when the NPC allowance is small', () => {
        const npc = (id: string, name: string) => ({
            id, name, aliases: '', appearance: 'tall '.repeat(30), faction: '', storyRelevance: '', status: 'alive',
            disposition: '', goals: '', voice: 'gravelly and slow '.repeat(20), personality: 'stern '.repeat(30),
        });
        const ledger = [npc('a', 'Mentioned Mara'), npc('b', 'Onstage Orrin')] as never[];
        const collector = createTraceCollector(true);
        const r = buildWorld({
            ...base, collector, userMessage: 'Mentioned Mara and Onstage Orrin talk',
            npcLedger: ledger, onStageNpcIds: ['b'], allocation: { pool: 0, npcFloor: 0, npcs: 90 },
        });
        expect(r.worldContent.toUpperCase()).toContain('ONSTAGE ORRIN');
        expect(countTokens(r.worldContent)).toBeLessThanOrEqual(90);
    });
});
