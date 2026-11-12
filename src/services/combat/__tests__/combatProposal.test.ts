import { describe, it, expect } from 'vitest';
import { dedupeCombatantNames, isCombatToolAllowed, parseCombatArgs } from '../combatProposal';
import { getToolDefinitions, handleStartCombatTool, START_COMBAT_TOOL_RESULT } from '../../turn/toolHandlers';
import { resolveToolHandler, TOOL_REGISTRY, validateToolRegistry } from '../../turn/toolRegistry';
import type { CombatProposal, CombatSession, NPCEntry } from '../../../types';

const ledger = [{ id: 'npc-1', name: 'Captain Vey' }] as unknown as NPCEntry[];

const toolNames = (tools: unknown[]) => tools.map(t => (t as { function: { name: string } }).function.name);

describe('start_combat argument parsing', () => {
    it('defaults side and tier, clamps unknown values and keeps optional labels', () => {
        const result = parseCombatArgs(JSON.stringify({
            combatants: [
                { name: '  Wolf  ', tier: 'MINION', species: 'wolf', look: 'grey' },
                { name: 'Shade', side: 'neutral', tier: 'godlike', archetype: 'Caster' },
                { name: 'Squire', side: 'ally', archetype: 'unknown' },
            ],
            reason: 'Wolves leap from the brush.',
        }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.combatants).toEqual([
            { name: 'Wolf', side: 'enemy', tier: 'minion', species: 'wolf', look: 'grey' },
            { name: 'Shade', side: 'neutral', tier: 'grunt', archetype: 'caster' },
            { name: 'Squire', side: 'ally', tier: 'grunt' },
        ]);
        expect(result.value.reason).toBe('Wolves leap from the brush.');
    });

    it('keeps an optional melee or ranged attack style and drops anything else', () => {
        const result = parseCombatArgs({ combatants: [{ name: 'Archer', attack: 'Ranged' }, { name: 'Thug', attack: 'melee' }, { name: 'Odd', attack: 'psychic' }], reason: 'x' });
        expect(result.ok && result.value.combatants.map(c => c.attack)).toEqual(['ranged', 'melee', undefined]);
        const schema = getToolDefinitions({ allowDiceTool: false, allowCombatTool: true })
            .map(t => t as { function: { name: string; parameters: { properties: { combatants: { items: { properties: Record<string, { enum?: string[] }> } } } } } })
            .find(t => t.function.name === 'start_combat')!;
        expect(schema.function.parameters.properties.combatants.items.properties.attack.enum).toEqual(['melee', 'ranged']);
    });

    it('numbers duplicate names', () => {
        expect(dedupeCombatantNames(['Bandit', 'Bandit', 'Boss', 'bandit'])).toEqual(['Bandit 1', 'Bandit 2', 'Boss', 'bandit 3']);
        const result = parseCombatArgs({ combatants: [{ name: 'Bandit' }, { name: 'Bandit' }], reason: 'x' });
        expect(result.ok && result.value.combatants.map(c => c.name)).toEqual(['Bandit 1', 'Bandit 2']);
    });

    it('resolves npcName to an npcId only on an exact match', () => {
        const hit = parseCombatArgs({ combatants: [{ name: 'Vey', npcName: 'captain vey' }], reason: '' }, ledger);
        expect(hit.ok && hit.value.combatants[0].npcId).toBe('npc-1');
        const miss = parseCombatArgs({ combatants: [{ name: 'Vey', npcName: 'Captain' }], reason: '' }, ledger);
        expect(miss.ok && miss.value.combatants[0].npcId).toBeUndefined();
    });

    it('accepts combatants and map delivered as JSON strings', () => {
        const result = parseCombatArgs(JSON.stringify({
            combatants: JSON.stringify([{ name: 'Ogre', tier: 'elite' }]),
            map: JSON.stringify({ size: 'Large', theme: 'cave', features: [{ kind: 'wall', where: 'north edge' }] }),
            reason: 'The ogre charges.',
        }));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.combatants).toEqual([{ name: 'Ogre', side: 'enemy', tier: 'elite' }]);
        expect(result.value.map).toEqual({ size: 'large', theme: 'cave', features: [{ kind: 'wall', where: 'north edge' }] });
    });

    it('caps the roster at 12', () => {
        const result = parseCombatArgs({ combatants: Array.from({ length: 20 }, (_, i) => ({ name: `Rat ${i}` })), reason: '' });
        expect(result.ok && result.value.combatants).toHaveLength(12);
    });

    it('rejects malformed arguments', () => {
        expect(parseCombatArgs('not json at all').ok).toBe(false);
        expect(parseCombatArgs({ combatants: 'nope' }).ok).toBe(false);
        expect(parseCombatArgs({ combatants: [{ side: 'enemy' }] }).ok).toBe(false);
    });
});

describe('start_combat handler and registry', () => {
    it('returns the fixed tool result and a proposal', () => {
        const out = handleStartCombatTool(JSON.stringify({ combatants: [{ name: 'Bandit' }], reason: 'Ambush' }));
        expect(out.toolResult).toBe(START_COMBAT_TOOL_RESULT);
        expect(out.proposal?.combatants[0]).toMatchObject({ name: 'Bandit', side: 'enemy', tier: 'grunt' });
    });

    it('explains malformed arguments and stages nothing', () => {
        const out = handleStartCombatTool('{"combatants": []}');
        expect(out.proposal).toBeUndefined();
        expect(out.toolResult).toMatch(/not accepted/);
    });

    it('registers the handler with append accumulation and a trace', () => {
        expect(() => validateToolRegistry()).not.toThrow();
        expect(typeof TOOL_REGISTRY.start_combat).toBe('function');
        const result = resolveToolHandler('start_combat')!({
            arguments: JSON.stringify({ combatants: [{ name: 'Vey', npcName: 'Captain Vey' }], reason: 'Duel' }),
            loreChunks: [],
            notebook: [],
            diceSystem: null,
            npcLedger: ledger,
        });
        expect(result.accumulation).toBe('append');
        expect(result.traceResult).toBe(true);
        expect(result.combatProposal?.combatants[0].npcId).toBe('npc-1');
        expect(result.proposal).toBeUndefined();
        expect(result.contextPatch).toBeUndefined();
    });
});

describe('tool gating', () => {
    const session = { state: { id: 's' } } as unknown as CombatSession;
    const proposal = { id: 'p', messageId: 'm' } as CombatProposal;
    const sheet = { abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false } as const;

    it('allows the tool only when combat is on, the sheet is allocated and nothing is pending', () => {
        expect(isCombatToolAllowed({ combatModeActive: true, combatSheet: sheet }, null, null)).toBe(true);
        expect(isCombatToolAllowed({ combatModeActive: false, combatSheet: sheet }, null, null)).toBe(false);
        expect(isCombatToolAllowed({ combatModeActive: true, combatSheet: { ...sheet, needsAllocation: true } }, null, null)).toBe(false);
        expect(isCombatToolAllowed({ combatModeActive: true }, null, null)).toBe(false);
        expect(isCombatToolAllowed({ combatModeActive: true, combatSheet: sheet }, session, null)).toBe(false);
        expect(isCombatToolAllowed({ combatModeActive: true, combatSheet: sheet }, null, proposal)).toBe(false);
    });

    it('leaves the tool list unchanged when combat is not allowed and appends start_combat last otherwise', () => {
        const off = getToolDefinitions({ allowDiceTool: true });
        expect(getToolDefinitions({ allowDiceTool: true, allowCombatTool: false })).toEqual(off);
        expect(toolNames(off)).not.toContain('start_combat');
        const on = toolNames(getToolDefinitions({ allowDiceTool: false, allowCombatTool: true }));
        expect(on[on.length - 1]).toBe('start_combat');
    });

    it('describes when not to call the tool and forbids numbers and narration of outcomes', () => {
        const tool = getToolDefinitions({ allowDiceTool: false, allowCombatTool: true }).at(-1) as { function: { description: string } };
        const d = tool.function.description;
        for (const phrase of ['threats', 'intimidation', 'remembered or off-screen fights', 'sparring', 'Never include the player character', 'Never supply numbers', 'roll_dice', 'do not narrate any attack']) {
            expect(d).toContain(phrase);
        }
    });
});
