import type { Archetype, CombatTier, GlyphAbility } from '../types';

export const ENEMY_BOLT_ID = 'kit-bolt';
export const ENEMY_BURST_ID = 'kit-burst';

const BURST_TIERS: ReadonlySet<CombatTier> = new Set<CombatTier>(['elite', 'boss', 'legendary']);

function titleCase(word: string): string {
    const w = word.trim();
    return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : 'Arcane';
}

export function enemyKit(tier: CombatTier, archetype: Archetype | undefined, damageType: string): GlyphAbility[] {
    if (archetype !== 'caster') return [];
    const type = damageType.trim() || 'arcane';
    const kit: GlyphAbility[] = [{
        id: ENEMY_BOLT_ID,
        name: `${titleCase(type)} bolt`,
        damageType: type,
        form: { id: 'projectile', augments: [] },
        effects: [{ id: 'damage', augments: [] }],
        source: 'preset',
    }];
    if (BURST_TIERS.has(tier)) {
        kit.push({
            id: ENEMY_BURST_ID,
            name: `${titleCase(type)} burst`,
            damageType: type,
            form: { id: 'burst', augments: [] },
            effects: [{ id: 'damage', augments: [] }],
            source: 'preset',
        });
    }
    return kit;
}

export type StarterPresetId = 'fire-bolt' | 'mend' | 'fireball' | 'flash-step' | 'haste' | 'aqua-elemental';

export const STARTER_ABILITIES: readonly GlyphAbility[] = [
    { id: 'fire-bolt', name: 'Fire bolt', damageType: 'fire', form: { id: 'projectile', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'preset' },
    { id: 'mend', name: 'Mend', form: { id: 'touch', augments: [] }, effects: [{ id: 'heal', augments: [] }], source: 'preset' },
    { id: 'fireball', name: 'Fireball', damageType: 'fire', form: { id: 'burst', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'preset' },
    { id: 'flash-step', name: 'Flash step', form: { id: 'dash', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'preset' },
    { id: 'haste', name: 'Haste', form: { id: 'self', augments: [] }, effects: [{ id: 'haste', augments: [] }], source: 'preset' },
    { id: 'aqua-elemental', name: 'Aqua elemental', damageType: 'water', form: { id: 'touch', augments: [] }, effects: [{ id: 'summon', augments: ['extend'] }], source: 'preset' },
];
