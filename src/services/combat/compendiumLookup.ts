import { parseDiceExpr } from '@narrative/engine';
import { isModEnabled } from '../mods/modEnablement';
import type { ProposedCombatant, TemplateOverlay } from '../../types';

export const ENEMY_COMPENDIUM_KEY = 'mod.enemies.compendium';

export type CompendiumField = 'hp' | 'ac' | 'attack' | 'damage';

export const COMPENDIUM_FIELDS: readonly CompendiumField[] = ['hp', 'ac', 'attack', 'damage'];

export type CompendiumStat = { name: string; value: string };

export type CompendiumTemplate = {
    name: string;
    aliases?: string;
    stats?: CompendiumStat[];
    weaknesses?: string[];
    resistances?: string[];
};

export type CompendiumSource =
    | { kind: 'tier' }
    | { kind: 'compendium'; templateName: string; fields: CompendiumField[]; unique: boolean };

export type CompendiumLookupState = {
    modTables?: Record<string, unknown>;
    settings?: { moduleEnabled?: Record<string, boolean> } | null;
};

const STAT_NAMES: Readonly<Record<CompendiumField, readonly string[]>> = {
    hp: ['hp', 'hit points', 'health'],
    ac: ['ac', 'armor', 'armour', 'armor class', 'armour class', 'defense', 'defence'],
    attack: ['attack', 'attack bonus', 'to hit'],
    damage: ['damage'],
};

function norm(text: string): string {
    return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isTemplate(raw: unknown): raw is CompendiumTemplate {
    return !!raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { name?: unknown }).name === 'string';
}

function stringList(raw: unknown): string[] {
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map(s => s.trim()) : [];
}

export function readCompendium(state: CompendiumLookupState): CompendiumTemplate[] {
    if (!isModEnabled({ id: 'enemies' }, state.settings?.moduleEnabled)) return [];
    const raw = state.modTables?.[ENEMY_COMPENDIUM_KEY];
    return Array.isArray(raw) ? raw.filter(isTemplate) : [];
}

function namesOf(template: CompendiumTemplate): string[] {
    const aliases = typeof template.aliases === 'string' ? template.aliases.split(',') : [];
    return [template.name, ...aliases].map(norm).filter(Boolean);
}

export function findCompendiumTemplate(species: string | undefined, state: CompendiumLookupState): CompendiumTemplate | null {
    if (!species || !species.trim()) return null;
    const wanted = norm(species);
    return readCompendium(state).find(t => namesOf(t).includes(wanted)) ?? null;
}

function statValue(template: CompendiumTemplate, field: CompendiumField): string | null {
    const stats = Array.isArray(template.stats) ? template.stats : [];
    const names = STAT_NAMES[field];
    const hit = stats.find(s => s && typeof s.name === 'string' && typeof s.value === 'string' && names.includes(norm(s.name)));
    return hit ? hit.value : null;
}

export function parseLeadingNumber(value: string | null): number | null {
    if (value === null) return null;
    const match = value.match(/^\s*\+?(\d+)(?!\s*d\d)(?!\d)/i);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
}

function parseDamage(value: string | null): TemplateOverlay['damage'] | null {
    if (value === null) return null;
    const dice = parseDiceExpr(value.replace(/\s+/g, ''));
    if (!dice || dice.count < 1 || dice.faces < 2) return null;
    return { count: dice.count, sides: dice.faces, bonus: dice.modifier };
}

function baseName(name: string): string {
    return norm(name).replace(/\s+\d+$/, '');
}

export function isUniqueIndividual(combatant: Pick<ProposedCombatant, 'name' | 'npcId'>, template: CompendiumTemplate): boolean {
    if (combatant.npcId) return true;
    return !namesOf(template).includes(baseName(combatant.name));
}

export function templateOverlay(
    template: CompendiumTemplate,
    combatant: Pick<ProposedCombatant, 'name' | 'npcId'>,
): { overlay: TemplateOverlay; fields: CompendiumField[]; unique: boolean } {
    const unique = isUniqueIndividual(combatant, template);
    const hp = parseLeadingNumber(statValue(template, 'hp'));
    const ac = parseLeadingNumber(statValue(template, 'ac'));
    const attack = unique ? null : parseLeadingNumber(statValue(template, 'attack'));
    const damage = unique ? null : parseDamage(statValue(template, 'damage'));
    const weaknesses = stringList(template.weaknesses);
    const resistances = stringList(template.resistances);
    const overlay: TemplateOverlay = {
        mode: unique ? 'floor' : 'replace',
        ...(hp !== null && hp > 0 ? { maxHp: hp } : {}),
        ...(ac !== null ? { ac } : {}),
        ...(attack !== null ? { attackBonus: attack } : {}),
        ...(damage ? { damage } : {}),
        ...(weaknesses.length > 0 ? { weaknesses } : {}),
        ...(resistances.length > 0 ? { resistances } : {}),
    };
    const fields: CompendiumField[] = [];
    if (overlay.maxHp !== undefined) fields.push('hp');
    if (overlay.ac !== undefined) fields.push('ac');
    if (overlay.attackBonus !== undefined) fields.push('attack');
    if (overlay.damage) fields.push('damage');
    return { overlay, fields, unique };
}

export function compendiumFor(
    combatant: Pick<ProposedCombatant, 'name' | 'npcId' | 'species'>,
    state: CompendiumLookupState,
): { overlay?: TemplateOverlay; source: CompendiumSource } {
    const template = findCompendiumTemplate(combatant.species, state);
    if (!template) return { source: { kind: 'tier' } };
    const { overlay, fields, unique } = templateOverlay(template, combatant);
    const hasLists = !!overlay.weaknesses || !!overlay.resistances;
    if (fields.length === 0 && !hasLists) return { source: { kind: 'tier' } };
    return {
        overlay,
        source: fields.length > 0 ? { kind: 'compendium', templateName: template.name, fields, unique } : { kind: 'tier' },
    };
}
