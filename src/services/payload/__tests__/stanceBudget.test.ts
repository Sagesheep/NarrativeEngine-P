import { describe, expect, it } from 'vitest';
import type {
    AppSettings,
    GameContext,
    RelationshipStance,
    RelationshipStanceRecord,
    RelationshipStanceSlots,
} from '../../../types';
import { computeBudgets } from '../budgets';
import { buildPayload } from '../payloadBuilder';
import { assembleContributions } from '../contributions/assemble';
import {
    BUILTIN_FINAL_USER_MODULES,
    type FinalUserModuleInput,
} from '../contributions/builtins';
import { createContributionRegistry } from '../contributions/registry';
import { countTokens } from '../../infrastructure/tokenizer';
import {
    RELATIONSHIP_STANCE_TOKEN_BUDGET,
    renderRelationshipStanceBlock,
} from '../../npc/relationshipStance';

function stance(
    npcName: string,
    tier: RelationshipStance['tier'],
    tierScore: number,
    memoryCount = 5,
): RelationshipStance {
    const topRecords: RelationshipStanceRecord[] = Array.from({ length: memoryCount }, (_, index) => ({
        sceneId: String(index + 1).padStart(3, '0'),
        subject: npcName,
        target: 'MC',
        mood: index % 2 === 0 ? 'tender' : 'hostile',
        impact: 'formative',
        outcome: npcName + ' remembers the promise and what happened after it in full detail',
        source: 'recorded',
        injectionScore: 1,
        line: '#' + String(index + 1).padStart(3, '0') + ' ' + npcName + ' memory line with a complete recorded outcome',
    }));

    const slots: RelationshipStanceSlots = {
        wantsNow: 'an answer before the silence grows',
        hiding: 'how frightened they are',
        wont: 'open the sealed door',
        inTension: [],
        believes: 'the player is testing them',
        manner: 'contained and precise',
        strain: 'close to breaking their usual restraint',
        considered: ['ask directly', 'leave'],
        readRoomAs: 'a controlled confrontation',
    };

    return {
        npcId: npcName,
        npcName,
        targetName: 'Ari',
        sceneId: '123',
        sceneKey: 'scene-key',
        statuses: 'standing at the threshold',
        nonNegotiables: 'will not open the door',
        tier,
        tierScore,
        clashCount: 1,
        pinCount: 1,
        forcedDeep: false,
        topRecords,
        ...(tier === 'deep' ? { stance: slots } : {}),
    };
}

function baseContext(): GameContext {
    return {
        loreRaw: '',
        rulesRaw: '',
        canonState: '',
        headerIndex: '',
        starter: '',
        continuePrompt: '',
        inventory: '',
        inventoryLastScene: 'Never',
        characterProfile: '',
        characterProfileLastScene: 'Never',
        canonStateActive: false,
        headerIndexActive: false,
        starterActive: false,
        continuePromptActive: false,
        inventoryActive: false,
        characterProfileActive: false,
        surpriseEngineActive: true,
        encounterEngineActive: true,
        worldEngineActive: true,
        diceFairnessActive: true,
        sceneNote: '',
        sceneNoteActive: false,
        sceneNoteDepth: 3,
        worldVibe: '',
        notebook: [],
        notebookActive: true,
        relationshipMemory: false,
    } as unknown as GameContext;
}

function baseSettings(contextLimit = 8192): AppSettings {
    return {
        debugMode: true,
        contextLimit,
        rulesBudgetPct: 0.10,
    } as unknown as AppSettings;
}

function spec(text: string, budget: number) {
    return {
        id: 'npc.stance',
        slot: 'final-user' as const,
        order: 150,
        text,
        source: 'builtin' as const,
        budget,
    };
}

describe('stance budgets', () => {
    it('fits three deep stances with five memories without arbiter trimming at 128k', () => {
        const stances = [
            stance('A1', 'deep', 3),
            stance('B2', 'deep', 2),
            stance('C3', 'deep', 1),
        ];
        const { budgetMap } = computeBudgets(128_000, 0.10, false);
        const budget = budgetMap.get('npc');
        const rendered = renderRelationshipStanceBlock(stances, budget);
        const assembled = assembleContributions([spec(rendered, budget)]);

        expect(budget).toBe(5_760);
        expect(assembled.trimmed).toEqual([]);
        expect(assembled.text.endsWith('[END NPC STANCES]')).toBe(true);
        expect((assembled.text.match(/STANCE /g) ?? []).length).toBe(3);
    });

    it.each([
        ['cheap', 8_000],
        ['deep', 8_000],
        ['cheap', 32_000],
        ['deep', 32_000],
        ['cheap', 128_000],
        ['deep', 128_000],
    ] as const)('keeps the terminator for %s stances at %s context tokens', (tier, limit) => {
        const { budgetMap } = computeBudgets(limit, 0.10, false);
        const rendered = renderRelationshipStanceBlock([stance('A1', tier, 1, 0)], budgetMap.get('npc'));

        expect(rendered).not.toBe('');
        expect(rendered.endsWith('[END NPC STANCES]')).toBe(true);
    });

    it('keeps whole stances only when the budget fits exactly two of three', () => {
        const first = stance('A1', 'cheap', 3, 1);
        const second = stance('B2', 'cheap', 2, 1);
        const third = stance('C3', 'cheap', 1, 1);
        const pairBudget = countTokens(renderRelationshipStanceBlock([first, second]));
        const rendered = renderRelationshipStanceBlock([first, second, third], pairBudget);

        expect((rendered.match(/STANCE /g) ?? []).length).toBe(2);
        expect(rendered).not.toContain('C3');
        for (const selected of [first, second]) {
            const lines = renderRelationshipStanceBlock([selected])
                .split('\n')
                .filter(line => line && !line.startsWith('[NPC'));
            for (const line of lines) expect(rendered).toContain(line);
        }
        expect(rendered.endsWith('[END NPC STANCES]')).toBe(true);
    });

    it('prioritises deep and then higher tierScore while preserving ties', () => {
        const deep = stance('D1', 'deep', 1, 0);
        const cheapHigh = stance('C1', 'cheap', 9, 0);
        const cheapLow = stance('C2', 'cheap', 1, 0);
        const pairBudget = countTokens(renderRelationshipStanceBlock([deep, cheapHigh]));
        const rendered = renderRelationshipStanceBlock([cheapLow, deep, cheapHigh], pairBudget);

        expect(rendered.indexOf('D1')).toBeGreaterThanOrEqual(0);
        expect(rendered.indexOf('C1')).toBeGreaterThan(rendered.indexOf('D1'));
        expect(rendered).not.toContain('C2');
    });

    it('returns empty and drops the contribution when even one cheap stance cannot fit', () => {
        const cheap = stance('Q1', 'cheap', 1, 5);
        const oneStance = renderRelationshipStanceBlock([cheap]);
        const budget = countTokens(oneStance) - 1;
        const rendered = renderRelationshipStanceBlock([cheap], budget);
        const assembled = assembleContributions([spec(rendered, budget)]);

        expect(rendered).toBe('');
        expect(assembled.text).toBe('');
        expect(assembled.included).toEqual([]);
        expect(assembled.trimmed).toEqual([]);
    });

    it('clamps the payload input to 5% of remaining-after-rules at an 8k window', () => {
        const stances = [
            stance('D1', 'deep', 3, 0),
            stance('D2', 'deep', 2, 0),
            stance('D3', 'deep', 1, 0),
        ];
        const allocation = computeBudgets(8_192, 0.10, false);
        const expected = allocation.budgetMap.get('npc');
        let observed: number | undefined;

        const registry = createContributionRegistry<FinalUserModuleInput>();
        registry.register({
            id: 'test.capture',
            name: 'Test capture',
            description: 'Captures the host input for this test.',
            source: 'builtin',
            defaultEnabled: true,
            toggleable: false,
            produce: (input) => {
                observed = input.relationshipStanceBudget;
                return [];
            },
        });

        buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: [],
            userMessage: 'Continue.',
            relationshipStances: stances,
            finalUserRegistry: registry,
        });

        expect(expected).toBe(Math.floor((8_192 - allocation.rulesBudget) * 0.05));
        expect(expected).toBeLessThan(3 * RELATIONSHIP_STANCE_TOKEN_BUDGET.deep);
        expect(observed).toBe(expected);
    });

    it('documents the same cheap and deep allowances as the tuning table', () => {
        const module = BUILTIN_FINAL_USER_MODULES.find(entry => entry.id === 'npcStance');
        const tokenImpact = module?.details?.tokenImpact ?? '';
        const documented = [...tokenImpact.matchAll(/\b\d+\b/g)].map(match => Number(match[0]));

        expect(documented).toEqual(expect.arrayContaining(Object.values(RELATIONSHIP_STANCE_TOKEN_BUDGET)));
        expect(tokenImpact).toContain('5%');
        expect(tokenImpact).toContain('dropped rather than trimmed');
    });
});
