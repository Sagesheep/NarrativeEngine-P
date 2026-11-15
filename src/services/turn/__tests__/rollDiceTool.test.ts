// roll_dice follows the campaign's dice system.
//
// The Engines tab assigns each category a die, and pool mode rolls by that
// assignment. In tool mode the definition used to name fixed dice (Combat→d20,
// Social→d6) and a fixed category list whatever the campaign had configured.
// These tests use the default dice system (buildDefaultDiceSystem) and small
// variations of it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultDiceSystem, type DiceSystemConfig } from '../../../types';
import { buildRollDiceTool, getToolDefinitions, handleDiceTool } from '../toolHandlers';

type RollDiceTool = {
    function: {
        name: string;
        description: string;
        parameters: { properties: { dice: { description: string }; category: { enum: string[] } }; required: string[] };
    };
};

const tool = (sys?: DiceSystemConfig | null): RollDiceTool => buildRollDiceTool(sys) as RollDiceTool;

/** The default system with chosen categories moved to another die. */
function withDice(overrides: Record<string, string>): DiceSystemConfig {
    const sys = buildDefaultDiceSystem();
    return { ...sys, categories: sys.categories.map(c => (overrides[c.name] ? { ...c, dieTypeId: overrides[c.name] } : c)) };
}

/** Every category on one die. */
function allOn(dieTypeId: string): DiceSystemConfig {
    const sys = buildDefaultDiceSystem();
    return { ...sys, categories: sys.categories.map(c => ({ ...c, dieTypeId })) };
}

afterEach(() => vi.restoreAllMocks());

describe('roll_dice definition', () => {
    it('is the stock definition when the campaign has no dice system', () => {
        for (const sys of [undefined, null]) {
            const t = tool(sys);
            expect(t.function.description).toContain('Combat→d20, Social→d6, Perception→d6');
            expect(t.function.parameters.properties.category.enum).toContain('Mundane');
        }
        const offered = getToolDefinitions({ allowDiceTool: true }) as RollDiceTool[];
        expect(offered.find(t => t.function?.name === 'roll_dice')).toBe(buildRollDiceTool(undefined));
    });

    it('names the one die when every category uses it', () => {
        const t = tool(buildDefaultDiceSystem());
        expect(t.function.description).toContain('this campaign rolls `1d20` for every category');
        expect(t.function.description).toContain('`category`: one of Combat / Perception / Stealth / Social / Movement / Knowledge\n');
        expect(t.function.description).not.toContain('Social→d6');
        expect(t.function.description).not.toContain('Mundane (used for d20 tier mapping only)');
        expect(t.function.parameters.properties.category.enum).toEqual(['Combat', 'Perception', 'Stealth', 'Social', 'Movement', 'Knowledge']);
        expect(t.function.parameters.properties.dice.description).toContain("'1d20'");
        expect(t.function.parameters.required).toEqual(['dice', 'reason']);

        expect(tool(allOn('dt_d100')).function.description).toContain('this campaign rolls `1d100` for every category');
    });

    it('lists each category with its die when the campaign mixes dice', () => {
        const t = tool(withDice({ Social: 'dt_d6', Knowledge: 'dt_d100' }));
        expect(t.function.description).toContain(
            "use the die this campaign assigns to the action's category (Combat→d20, Perception→d20, Stealth→d20, Social→d6, Movement→d20, Knowledge→d100)",
        );
    });

    it('changes only the die and category guidance', () => {
        const stock = tool(undefined).function.description;
        const built = tool(buildDefaultDiceSystem()).function.description;
        // Everything before the `dice` bullet and from the Advantage paragraph on is untouched.
        expect(built.slice(0, built.indexOf('   - `dice`'))).toBe(stock.slice(0, stock.indexOf('   - `dice`')));
        expect(built.slice(built.indexOf('4. Do NOT call'))).toBe(stock.slice(stock.indexOf('4. Do NOT call')));
        expect(built).toContain('(a die with no configured bands)');
    });

    it('skips categories whose die is missing and falls back to stock when none is usable', () => {
        const sys = withDice({ Social: 'dt_gone' });
        expect(tool(sys).function.parameters.properties.category.enum).not.toContain('Social');
        expect(tool(allOn('dt_gone'))).toBe(buildRollDiceTool(undefined));
        expect(tool({ dieTypes: buildDefaultDiceSystem().dieTypes, categories: [] })).toBe(buildRollDiceTool(undefined));
    });

    it('reaches the model through getToolDefinitions', () => {
        const offered = getToolDefinitions({ allowDiceTool: true, diceSystem: allOn('dt_d100') }) as RollDiceTool[];
        const rollDice = offered.find(t => t.function?.name === 'roll_dice');
        expect(rollDice?.function.description).toContain('`1d100` for every category');
        expect(getToolDefinitions({ allowDiceTool: false, diceSystem: allOn('dt_d100') }).some(t => (t as RollDiceTool).function?.name === 'roll_dice')).toBe(false);
    });
});

describe('handleDiceTool — when the model names no die', () => {
    const roll = (args: Record<string, unknown>, diceSystem?: DiceSystemConfig | null) =>
        JSON.parse(handleDiceTool(JSON.stringify(args), { diceSystem }).toolResult) as { dice: string; result: number; tier?: string };

    it("rolls the campaign's only die and reports it", () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const out = roll({ reason: 'Climb the wall' }, allOn('dt_d100'));
        expect(out).toMatchObject({ dice: '1d100', result: 51, tier: 'Success' });
    });

    it("rolls the named category's die in a mixed campaign", () => {
        vi.spyOn(Math, 'random').mockReturnValue(0.99);
        const sys = withDice({ Social: 'dt_d6' });
        expect(roll({ reason: 'Persuade the guard', category: 'social' }, sys)).toMatchObject({ dice: '1d6', result: 6, tier: 'Success' });
        // No category to go on, and no single die: the legacy d20.
        expect(roll({ reason: 'Something else' }, sys)).toMatchObject({ dice: '1d20', result: 20 });
    });

    it('keeps the legacy d20 without a dice system, and never overrides a die the model named', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(roll({ reason: 'x' })).toMatchObject({ dice: '1d20', result: 1 });
        expect(roll({ dice: '1d8', reason: 'x' }, allOn('dt_d100'))).toMatchObject({ dice: '1d8', result: 1 });
    });
});
