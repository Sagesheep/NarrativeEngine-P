import { describe, it, expect } from 'vitest';
import { handleProposeInventoryTool, getToolDefinitions } from '../toolHandlers';

type ToolDef = { function: { name: string; parameters: { properties: Record<string, { enum?: readonly string[] }> } } };

describe('propose_inventory_change scalingStat', () => {
    it('accepts each D&D ability label', () => {
        for (const stat of ['STR', 'DEX', 'INT', 'WIS', 'CHA'] as const) {
            const { proposal } = handleProposeInventoryTool(JSON.stringify({ name: 'Blade', kind: 'weapon', scalingStat: stat }));
            expect(proposal.scalingStat).toBe(stat);
        }
    });

    it('defaults to STR when absent, unknown or a retired label', () => {
        for (const raw of [undefined, 'PWR', 'SPD', 'WIL', 'CON', 'nonsense']) {
            const { proposal } = handleProposeInventoryTool(JSON.stringify({ name: 'Blade', scalingStat: raw }));
            expect(proposal.scalingStat).toBe('STR');
        }
    });
});

describe('propose_inventory_change schema', () => {
    it('offers the D&D ability labels in its enum', () => {
        const defs = getToolDefinitions({ allowDiceTool: false }) as ToolDef[];
        const tool = defs.find(d => d.function.name === 'propose_inventory_change');
        expect(tool?.function.parameters.properties.scalingStat.enum).toEqual(['STR', 'DEX', 'INT', 'WIS', 'CHA']);
    });
});
