import { describe, it, expect } from 'vitest';
import { deriveDefaultMeta, extractHeaderKeywords, extractBoldKeywords } from '../rules/rulesIndexer';
import { retrieveRelevantRules } from '../rules/rulesRetriever';
import { buildPayload } from '../payload/payloadBuilder';
import type { LoreChunk, RuleChunkMeta, GameContext, AppSettings } from '../../types';

describe('Rules Indexer Helpers', () => {
    it('extracts keywords from headers and bold text correctly', () => {
        const header = '## Combat Movement Check';
        const content = 'When moving through **difficult terrain**, make an **athletics** check.';
        
        const headerKws = extractHeaderKeywords(header);
        const boldKws = extractBoldKeywords(content);
        
        expect(headerKws).toContain('combat');
        expect(headerKws).toContain('move');
        expect(headerKws).toContain('check');
        
        expect(boldKws).toContain('difficult terrain');
        expect(boldKws).toContain('athletics');
    });

    it('derives default metadata correctly', () => {
        const chunk: LoreChunk = {
            id: 'rule-combat',
            header: '## Combat Rules',
            content: 'Always roll a **d20** for attacks.',
            tokens: 15,
            priority: 8,
            triggerKeywords: ['attack'],
            secondaryKeywords: ['sword'],
        } as unknown as LoreChunk;
        
        const meta = deriveDefaultMeta(chunk);
        expect(meta.id).toBe('rule-combat');
        expect(meta.priority).toBe(8);
        expect(meta.activationModes).toContain('vector');
        expect(meta.triggerKeywords).toContain('attack');
        expect(meta.triggerKeywords).toContain('combat');
        expect(meta.triggerKeywords).toContain('d20');
        expect(meta.secondaryKeywords).toContain('sword');
    });
});

describe('Rules Retriever Scoring & Matching', () => {
    const mockChunks: LoreChunk[] = [
        {
            id: 'rule-1',
            header: '## Combat Attack',
            content: 'When making an attack, roll a d20.',
            tokens: 50,
            priority: 5,
            triggerKeywords: [],
        } as unknown as LoreChunk,
        {
            id: 'rule-2',
            header: '## Always Rule',
            content: 'This rule is always loaded.',
            tokens: 20,
            priority: 9,
            triggerKeywords: [],
        } as unknown as LoreChunk,
        {
            id: 'rule-3',
            header: '## Stealth Movement',
            content: 'When sneaking in difficult terrain.',
            tokens: 30,
            priority: 4,
            triggerKeywords: [],
        } as unknown as LoreChunk
    ];

    const mockMeta: Record<string, RuleChunkMeta> = {
        'rule-1': {
            id: 'rule-1',
            activationModes: ['keyword'],
            triggerKeywords: ['attack', 'strike'],
            secondaryKeywords: ['combat'],
            priority: 5,
        },
        'rule-2': {
            id: 'rule-2',
            activationModes: ['always'],
            priority: 9,
        },
        'rule-3': {
            id: 'rule-3',
            activationModes: ['vector', 'keyword'],
            triggerKeywords: ['stealth', 'sneak'],
            secondaryKeywords: [],
            priority: 4,
        }
    };

    it('includes always-load rules regardless of keywords or query', () => {
        const result = retrieveRelevantRules(mockChunks, mockMeta, 'looking around', 100);
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).not.toContain('rule-1');
        expect(result.selected.map(r => r.id)).not.toContain('rule-3');
    });

    it('activates keyword rules with valid trigger and secondary keywords', () => {
        // Attack keyword trigger, should activate because 'combat' is in userMessage as secondary keyword
        const result = retrieveRelevantRules(
            mockChunks,
            mockMeta,
            'I perform a quick attack in combat',
            200
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2'); // always
        expect(result.selected.map(r => r.id)).toContain('rule-1'); // keyword active
    });

    it('filters out keyword rules when secondary keyword narrows them away', () => {
        // 'attack' present, but secondary 'combat' missing
        const result = retrieveRelevantRules(
            mockChunks,
            mockMeta,
            'I attack the target from a distance',
            200
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).not.toContain('rule-1');
    });

    it('activates semantic rules via vector search hits', () => {
        const result = retrieveRelevantRules(
            mockChunks,
            mockMeta,
            'sneaking around',
            200,
            [],
            ['rule-3'] // semantic hit
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).toContain('rule-3');
    });

    it('respects token budget constraints and outputs unretrieved manifest', () => {
        // Small budget: only always rule (20 tokens) fits, rule-1 (50 tokens) will exceed if budget is 60 total
        const result = retrieveRelevantRules(
            mockChunks,
            mockMeta,
            'I perform an attack in combat',
            60 // budget limit
        );
        expect(result.selected.map(r => r.id)).toContain('rule-2');
        expect(result.selected.map(r => r.id)).not.toContain('rule-1'); // too big (20 + 50 > 60)
        expect(result.manifest).toContain('Combat Attack');
        expect(result.manifest).toContain('Stealth Movement');
    });
});

describe('Payload Builder Integration', () => {
    const baseContext = (): GameContext => ({
        loreRaw: '',
        rulesRaw: '',
        canonState: '',
        headerIndex: '',
        starter: '',
        continuePrompt: '',
        inventory: '',
        diceFairnessActive: true,
        rulesChunks: [
            { id: 'rule-rag-1', header: '[CHUNK: RULE] Attack Actions', content: 'Roll a d20 for attack actions.', tokens: 30, triggerKeywords: [] },
            { id: 'rule-rag-2', header: '[CHUNK: RULE] Difficulty Check', content: 'Standard DC is 15.', tokens: 40, triggerKeywords: [] }
        ],
        rulesChunkMeta: {
            'rule-rag-1': { id: 'rule-rag-1', activationModes: ['always'] },
            'rule-rag-2': { id: 'rule-rag-2', activationModes: ['always'] }
        }
    } as unknown as GameContext);

    const baseSettings = (): AppSettings => ({
        debugMode: true,
        contextLimit: 1000, // tiny limit to test budget division
        rulesBudgetPct: 0.10, // 100 tokens rules budget
    } as unknown as AppSettings);

    it('falls back to complete raw rules if rulesChunks are not loaded', () => {
        const ctx = baseContext();
        ctx.rulesChunks = []; // no chunk metadata
        ctx.rulesRaw = '### Complete Raw Rules\nLoad all of them.';
        
        const payload = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'Hello' });
        const firstSystem = payload.messages.find(m => m.role === 'system');
        expect(firstSystem).toBeDefined();
        expect(firstSystem!.content).toContain('Complete Raw Rules');
    });

    it('injects relevant RAG rules and enforces budget limits', () => {
        const ctx = baseContext();
        
        // 10% of 1000 limit = 100 tokens rules budget
        // rule-rag-1 (30 tokens) and rule-rag-2 (40 tokens) fit (30 + 40 = 70 tokens <= 100)
        const relevantRules: LoreChunk[] = [
            { id: 'rule-rag-1', header: '[CHUNK: RULE] Attack Actions', content: 'Roll a d20 for attack actions.', tokens: 30, triggerKeywords: [] } as unknown as LoreChunk,
            { id: 'rule-rag-2', header: '[CHUNK: RULE] Difficulty Check', content: 'Standard DC is 15.', tokens: 40, triggerKeywords: [] } as unknown as LoreChunk
        ];
        
        const payload = buildPayload({ settings: baseSettings(), context: ctx, history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: [], npcLedger: [], archiveRecall: [], recommendedNPCNames: [], semanticFactText: undefined, archiveIndex: [], timelineEvents: [], inventoryCategories: [], profileFields: [], deepContextSummary: undefined, divergenceRegister: undefined, chapters: [], onStageNpcIds: [], relevantRules: relevantRules, rulesManifest: '[Available rule sections not loaded this turn]\n## Stealth\n[End section list]' });
        
        // RAG-retrieved rules ride in the volatile block folded into the final user message
        // (only the verbatim full-rules fallback stays in the system message)
        const userMessage = payload.messages.find(m => m.role === 'user');
        expect(userMessage).toBeDefined();
        expect(userMessage!.content).toContain('## RULES');
        expect(userMessage!.content).toContain('Attack Actions');
        expect(userMessage!.content).toContain('Difficulty Check');
        expect(userMessage!.content).toContain('Stealth'); // Manifest contains unretrieved rules list
    });

    it('limits RAG rules injection when they exceed the rules budget', () => {
        const ctx = baseContext();
        
        // Let's create an AppSettings with a tighter contextLimit of 500, meaning rulesBudget = 50 tokens
        const settings = {
            ...baseSettings(),
            contextLimit: 500,
        };
        
        // Both rules combined are 30 + 40 = 70 tokens, which exceeds the 50 token budget
        // Only rule-rag-1 (30 tokens) should fit; rule-rag-2 (40 tokens) is dropped
        const relevantRules: LoreChunk[] = [
            { id: 'rule-rag-1', header: '[CHUNK: RULE] Attack Actions', content: 'Roll a d20.', tokens: 30, triggerKeywords: [] } as unknown as LoreChunk,
            { id: 'rule-rag-2', header: '[CHUNK: RULE] Difficulty Check', content: 'Standard DC is 15.', tokens: 40, triggerKeywords: [] } as unknown as LoreChunk
        ];
        
        const payload = buildPayload({ settings: settings, context: ctx, history: [], userMessage: 'Hello', condensedUpToIndex: undefined, relevantLore: [], npcLedger: [], archiveRecall: [], recommendedNPCNames: [], semanticFactText: undefined, archiveIndex: [], timelineEvents: [], inventoryCategories: [], profileFields: [], deepContextSummary: undefined, divergenceRegister: undefined, chapters: [], onStageNpcIds: [], relevantRules: relevantRules, rulesManifest: '' });
        
        const systemMessage = payload.messages.find(m => m.role === 'user');
        expect(systemMessage).toBeDefined();
        expect(systemMessage!.content).toContain('Attack Actions');
        expect(systemMessage!.content).not.toContain('Difficulty Check'); // Exceeded budget
    });
});
