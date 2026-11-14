import { abilityCost, casterStats, castingAbilityOf, cleanAbilityName, deriveMaxMp, deriveSheet, validateAbility } from '@narrative/engine';
import type { AbilityLimits, CasterStats } from '@narrative/engine';
import { normalizeCombatConfig, normalizeSpellbook } from '../../types';
import type { CombatSettings, CombatSheet, GameContext, GlyphAbility, Spellbook } from '../../types';
import { uid } from '../../utils/uid';

export const FIELD_LIMITS = { damageType: 24, description: 400 } as const;

export function limitsOf(config: CombatSettings): AbilityLimits {
    return { maxChainLength: config.maxChainLength, maxSummons: config.maxSummons };
}

export function spellbookOf(context: Pick<GameContext, 'spellbook'>): Spellbook {
    return normalizeSpellbook(context.spellbook);
}

export function sheetCasterStats(sheet: CombatSheet | undefined): CasterStats {
    if (!sheet) return { proficiency: 2, castingMod: 0 };
    const derived = deriveSheet(sheet);
    return casterStats({ proficiency: derived.proficiency, tier: 'grunt', castingAbility: castingAbilityOf(sheet), abilities: sheet.abilities });
}

export function sheetMaxMp(sheet: CombatSheet | undefined): number {
    return sheet ? deriveMaxMp(sheet) : 0;
}

export function cleanAbility(ability: GlyphAbility, source?: GlyphAbility['source']): GlyphAbility {
    const description = ability.description?.trim().slice(0, FIELD_LIMITS.description);
    const damageType = ability.damageType?.replace(/\s+/g, ' ').trim().slice(0, FIELD_LIMITS.damageType);
    return {
        id: ability.id,
        name: cleanAbilityName(ability.name),
        ...(description ? { description } : {}),
        ...(damageType ? { damageType } : {}),
        form: { id: ability.form.id, augments: [...ability.form.augments] },
        effects: ability.effects.map(e => ({ id: e.id, augments: [...e.augments] })),
        source: source ?? ability.source,
    };
}

export function upsertAbility(book: Spellbook, ability: GlyphAbility): Spellbook {
    const id = ability.id && book.abilities.some(a => a.id === ability.id) ? ability.id : (ability.id || `ab_${uid()}`);
    const clean = cleanAbility({ ...ability, id });
    const exists = book.abilities.some(a => a.id === id);
    return {
        abilities: exists ? book.abilities.map(a => a.id === id ? clean : a) : [...book.abilities, clean],
        equippedIds: book.equippedIds,
    };
}

export function addAsNew(book: Spellbook, ability: GlyphAbility, source: GlyphAbility['source']): Spellbook {
    return upsertAbility(book, { ...ability, id: `ab_${uid()}`, source });
}

export function removeAbility(book: Spellbook, id: string): Spellbook {
    return { abilities: book.abilities.filter(a => a.id !== id), equippedIds: book.equippedIds.filter(e => e !== id) };
}

export function equipBlocker(book: Spellbook, ability: GlyphAbility, config: CombatSettings): string | null {
    const reasons = validateAbility(ability, limitsOf(config));
    if (reasons.length > 0) return reasons[0];
    if (!book.equippedIds.includes(ability.id) && book.equippedIds.length >= config.maxEquippedAbilities) return 'full';
    return null;
}

export function toggleEquipped(book: Spellbook, id: string, config: CombatSettings): Spellbook {
    if (book.equippedIds.includes(id)) return { ...book, equippedIds: book.equippedIds.filter(e => e !== id) };
    const ability = book.abilities.find(a => a.id === id);
    if (!ability || equipBlocker(book, ability, config)) return book;
    return { ...book, equippedIds: [...book.equippedIds, id] };
}

export function unequip(book: Spellbook, id: string): Spellbook {
    return { ...book, equippedIds: book.equippedIds.filter(e => e !== id) };
}

export function reorderEquipped(book: Spellbook, from: number, to: number): Spellbook {
    const ids = [...book.equippedIds];
    if (from < 0 || from >= ids.length || to < 0 || from === to) return book;
    const [moved] = ids.splice(from, 1);
    ids.splice(Math.min(to, ids.length), 0, moved);
    return { ...book, equippedIds: ids };
}

export function equipAt(book: Spellbook, id: string, slot: number, config: CombatSettings): Spellbook {
    const at = book.equippedIds.indexOf(id);
    if (at >= 0) return reorderEquipped(book, at, slot);
    const ability = book.abilities.find(a => a.id === id);
    if (!ability || slot < 0 || slot >= config.maxEquippedAbilities) return book;
    if (validateAbility(ability, limitsOf(config)).length > 0) return book;
    const ids = [...book.equippedIds];
    if (slot < ids.length && ids.length >= config.maxEquippedAbilities) ids[slot] = id;
    else ids.splice(Math.min(slot, ids.length), 0, id);
    return { ...book, equippedIds: ids };
}

export function costOf(ability: GlyphAbility): number {
    return abilityCost(ability);
}

export function configOf(context: Pick<GameContext, 'combatConfig'>): CombatSettings {
    return normalizeCombatConfig(context.combatConfig);
}
