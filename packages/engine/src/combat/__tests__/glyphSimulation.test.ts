import { describe, it, expect } from 'vitest';
import { ARCHETYPE_PRESETS, simulateFights, STARTER_ABILITIES } from '../index';
import type { CombatSheet, CombatantSpec, MapSpec, PcCombatantInput } from '../index';

const FIGHTS = 1000;

const fighterSheet: CombatSheet = {
    abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 },
    budget: 'NORMAL',
    level: 3,
    needsAllocation: false,
};

const casterSheet: CombatSheet = { abilities: { ...ARCHETYPE_PRESETS.caster }, budget: 'NORMAL', level: 3, needsAllocation: false };

const spells = STARTER_ABILITIES.filter(a => a.id === 'fire-bolt' || a.id === 'fireball');

const pcs: Array<[string, PcCombatantInput]> = [
    ['weapon-only', { name: 'PC', sheet: fighterSheet, weapon: { quality: 'common', scalingStat: 'STR' } }],
    ['same PC + Fire bolt/Fireball', { name: 'PC', sheet: fighterSheet, weapon: { quality: 'common', scalingStat: 'STR' }, kit: spells }],
    ['caster sheet + Fire bolt/Fireball', { name: 'PC', sheet: casterSheet, weapon: { quality: 'common', scalingStat: 'DEX' }, kit: spells }],
];

const enemies = (tier: CombatantSpec['tier'], n: number, extra: Partial<CombatantSpec> = {}): CombatantSpec[] =>
    Array.from({ length: n }, (_, i) => ({ name: `Foe ${i + 1}`, side: 'enemy', tier, ...extra }));

const maps: Array<[string, MapSpec]> = [
    ['open arena', { size: 'medium', area: 'open', density: 'sparse' }],
    ['scattered cover', { size: 'medium', area: 'scattered', density: 'normal' }],
];

const cases: Array<[string, CombatantSpec[]]> = [
    ['2 minions', enemies('minion', 2)],
    ['1 grunt', enemies('grunt', 1)],
    ['3 grunts', enemies('grunt', 3)],
    ['1 elite', enemies('elite', 1)],
    ['2 ranged grunts', enemies('grunt', 2, { range: 'ranged' })],
];

const casterCases: Array<[string, CombatantSpec[]]> = [
    ['1 grunt caster', enemies('grunt', 1, { archetype: 'caster' })],
    ['2 minion casters', enemies('minion', 2, { archetype: 'caster' })],
    ['1 elite caster', enemies('elite', 1, { archetype: 'caster' })],
];

describe(`glyph simulation (${FIGHTS} seeded fights each, reported, no target)`, () => {
    for (const [mapLabel, map] of maps) {
        for (const [label, foes] of cases) {
            it(`${label} on the ${mapLabel}: weapon-only beside casters`, () => {
                const row = pcs.map(([pcLabel, pc]) => {
                    const r = simulateFights(pc, foes, FIGHTS, { baseSeed: 1, map });
                    return `${pcLabel} ${(r.winRate * 100).toFixed(1)}% (${r.meanRounds.toFixed(2)} rounds)`;
                });
                console.log(`[glyph-sim] ${mapLabel} | ${label}: ${row.join(' | ')}`);
                expect(row).toHaveLength(3);
            }, 300000);
        }
        for (const [label, foes] of casterCases) {
            it(`${label} on the ${mapLabel} against the weapon-only PC (C6)`, () => {
                const plain = simulateFights(pcs[0][1], foes.map(f => ({ ...f, archetype: undefined })), FIGHTS, { baseSeed: 1, map });
                const casters = simulateFights(pcs[0][1], foes, FIGHTS, { baseSeed: 1, map });
                console.log(`[glyph-sim] ${mapLabel} | ${label}: win ${(casters.winRate * 100).toFixed(1)}% (${casters.meanRounds.toFixed(2)} rounds); same tier without the caster archetype ${(plain.winRate * 100).toFixed(1)}%`);
                expect(casters.fights).toBe(FIGHTS);
            }, 300000);
        }
    }
});
