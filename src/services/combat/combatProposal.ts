import {
    DIRECTED_TIERS, checkElement, elementsFor, filterElements, normalizeMapSpec, normalizeSignatureRequest, normalizeSpeech, normalizeTactic, validateSignature,
} from '@narrative/engine';
import type { ElementDropReason, ElementId, ElementPresetId, SignatureSpec } from '@narrative/engine';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import {
    COMBAT_ARCHETYPES, COMBAT_MANNER_MAX, COMBAT_TIERS, MAX_PROPOSED_COMBATANTS, PROPOSED_ATTACK_STYLES, PROPOSED_COMBATANT_SIDES,
} from '../../types';
import type {
    Archetype, CombatMapSpec, CombatProposal, CombatSession, CombatTier, GameContext, NPCEntry,
    ProposedAttackStyle, ProposedCombatant, ProposedCombatantSide, ProposedObjective,
} from '../../types';
import { isPlainObjective, parseProposedObjective, reconcileObjective } from './combatObjective';

const NAME_MAX = 60;
const TEXT_MAX = 160;

export type ParsedCombatArgs = {
    combatants: ProposedCombatant[];
    map?: CombatMapSpec;
    reason: string;
    objective?: ProposedObjective;
};

export type ElementField = 'weak' | 'resist' | 'immune' | 'element';

export type ElementDropNote = { name: string; field: ElementField; value: string; reason: ElementDropReason };

export type ElementFields = Pick<ProposedCombatant, 'weak' | 'resist' | 'immune' | 'mindless' | 'element'>;

const ELEMENT_LIST_FIELDS = ['weak', 'resist', 'immune'] as const;

function wordList(raw: unknown): string[] {
    const value = typeof raw === 'string' && !raw.trim().startsWith('[') ? raw : parseMaybeJson(raw);
    if (typeof value === 'string') return value.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(Boolean) : [];
}

export function parseElementFields(
    rec: Record<string, unknown>,
    name: string,
    preset: ElementPresetId | undefined,
    drops: ElementDropNote[],
): ElementFields {
    const out: ElementFields = {};
    for (const field of ELEMENT_LIST_FIELDS) {
        const words = wordList(rec[field]);
        if (words.length === 0) continue;
        const filtered = filterElements(preset, words);
        for (const d of filtered.dropped) drops.push({ name, field, value: d.value.slice(0, 24), reason: d.reason });
        if (filtered.kept.length > 0) out[field] = filtered.kept;
    }
    const mindless = parseOfficer(rec.mindless);
    if (mindless !== undefined) out.mindless = mindless;
    const element = typeof rec.element === 'string' ? rec.element.trim() : '';
    if (element) {
        const checked = checkElement(preset, element);
        if (checked.ok) out.element = checked.element;
        else drops.push({ name, field: 'element', value: element.slice(0, 24), reason: checked.reason });
    }
    return out;
}

const DROP_FIELD_WORDS: Readonly<Record<ElementField, string>> = {
    weak: 'weak',
    resist: 'resist',
    immune: 'immune',
    element: 'element',
};

export function elementListLine(preset: ElementPresetId): string {
    return `Elements of this setting: ${elementsFor(preset).join(', ')}. Use only these names in weak, resist, immune and element.`;
}

export function elementToolNotes(drops: readonly ElementDropNote[]): string[] {
    return drops.map(d => `${d.name}: ${DROP_FIELD_WORDS[d.field]} "${d.value}" was dropped (${d.reason === 'unknown' ? 'not an element' : 'not an element of this setting'}).`);
}

export function elementSpecFields(c: ElementFields): { weak?: ElementId[]; resist?: ElementId[]; immune?: ElementId[]; mindless?: boolean; element?: ElementId } {
    return {
        ...(c.weak && c.weak.length > 0 ? { weak: [...c.weak] } : {}),
        ...(c.resist && c.resist.length > 0 ? { resist: [...c.resist] } : {}),
        ...(c.immune && c.immune.length > 0 ? { immune: [...c.immune] } : {}),
        ...(c.mindless !== undefined ? { mindless: c.mindless } : {}),
        ...(c.element ? { element: c.element } : {}),
    };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function cleanText(raw: unknown, max: number): string {
    return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
    if (typeof raw !== 'string') return fallback;
    const lower = raw.trim().toLowerCase();
    return (allowed as readonly string[]).includes(lower) ? lower as T : fallback;
}

function parseMaybeJson(raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        const wrapped = extractJsonRobust<{ v?: unknown }>(`{"v":${trimmed}}`, {});
        return wrapped.parseOk ? wrapped.value.v : undefined;
    }
}

function parseArgsObject(raw: string | Record<string, unknown>): Record<string, unknown> | null {
    if (typeof raw !== 'string') return raw;
    try {
        return asRecord(JSON.parse(raw));
    } catch {
        const { value, parseOk } = extractJsonRobust<Record<string, unknown>>(raw, {});
        return parseOk ? asRecord(value) : null;
    }
}

export function dedupeCombatantNames(names: string[]): string[] {
    const counts = new Map<string, number>();
    for (const n of names) counts.set(n.toLowerCase(), (counts.get(n.toLowerCase()) ?? 0) + 1);
    const seen = new Map<string, number>();
    return names.map(n => {
        const key = n.toLowerCase();
        if ((counts.get(key) ?? 0) < 2) return n;
        const index = (seen.get(key) ?? 0) + 1;
        seen.set(key, index);
        return `${n} ${index}`;
    });
}

export function parseOfficer(raw: unknown): boolean | undefined {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw !== 'string') return undefined;
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === 'yes') return true;
    if (v === 'false' || v === 'no') return false;
    return undefined;
}

export function parseSignature(raw: unknown): SignatureSpec | undefined {
    const value = parseMaybeJson(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return normalizeSignatureRequest(value) ?? undefined;
}

function resolveNpcId(name: string | undefined, ledger: readonly NPCEntry[]): string | undefined {
    if (!name) return undefined;
    const target = name.trim().toLowerCase();
    const hit = ledger.find(n => n.name.trim().toLowerCase() === target);
    return hit?.id;
}

function parseMap(raw: unknown): CombatMapSpec | undefined {
    const rec = asRecord(parseMaybeJson(raw));
    if (!rec) return undefined;
    const features = parseMaybeJson(rec.features);
    const labels = parseMaybeJson(rec.labels);
    const map: CombatMapSpec = normalizeMapSpec({ ...rec, features, labels });
    delete map.size;
    return Object.keys(map).length > 0 ? map : undefined;
}

export function parseCombatArgs(
    raw: string | Record<string, unknown>,
    ledger: readonly NPCEntry[] = [],
    preset?: ElementPresetId,
): { ok: true; value: ParsedCombatArgs; notes: string[]; drops: ElementDropNote[] } | { ok: false; error: string } {
    const args = parseArgsObject(raw);
    if (!args) return { ok: false, error: 'the arguments were not a JSON object' };
    const list = parseMaybeJson(args.combatants);
    if (!Array.isArray(list)) return { ok: false, error: '`combatants` must be an array of 1 to 12 objects' };
    const entries = list
        .map(item => asRecord(item))
        .filter((item): item is Record<string, unknown> => !!item && !!cleanText(item.name, NAME_MAX));
    if (entries.length === 0) return { ok: false, error: '`combatants` needs at least one entry with a `name`' };
    const clipped = entries.slice(0, MAX_PROPOSED_COMBATANTS);
    const names = dedupeCombatantNames(clipped.map(e => cleanText(e.name, NAME_MAX)));
    const drops: ElementDropNote[] = [];
    const combatants: ProposedCombatant[] = clipped.map((e, i) => {
        const archetype = typeof e.archetype === 'string' && (COMBAT_ARCHETYPES as readonly string[]).includes(e.archetype.trim().toLowerCase())
            ? e.archetype.trim().toLowerCase() as Archetype
            : undefined;
        const npcName = cleanText(e.npcName, NAME_MAX) || undefined;
        const npcId = resolveNpcId(npcName, ledger);
        const species = cleanText(e.species, NAME_MAX) || undefined;
        const look = cleanText(e.look, TEXT_MAX) || undefined;
        const manner = cleanText(e.manner, COMBAT_MANNER_MAX) || undefined;
        const speech = normalizeSpeech(e.speech);
        const tactic = normalizeTactic(e.tactic);
        const attack = typeof e.attack === 'string' && (PROPOSED_ATTACK_STYLES as readonly string[]).includes(e.attack.trim().toLowerCase())
            ? e.attack.trim().toLowerCase() as ProposedAttackStyle
            : undefined;
        const officer = parseOfficer(e.officer);
        const signature = parseSignature(e.signature);
        const elements = parseElementFields(e, names[i], preset, drops);
        return {
            name: names[i],
            side: pick<ProposedCombatantSide>(e.side, PROPOSED_COMBATANT_SIDES, 'enemy'),
            tier: pick<CombatTier>(e.tier, COMBAT_TIERS, 'grunt'),
            ...(archetype ? { archetype } : {}),
            ...(species ? { species } : {}),
            ...(npcName ? { npcName } : {}),
            ...(npcId ? { npcId } : {}),
            ...(look ? { look } : {}),
            ...(manner ? { manner } : {}),
            ...(speech ? { speech } : {}),
            ...(tactic ? { tactic } : {}),
            ...(attack ? { attack } : {}),
            ...(officer !== undefined ? { officer } : {}),
            ...(signature ? { signature } : {}),
            ...elements,
        };
    });
    const map = parseMap(args.map);
    const notes: string[] = [];
    const parsedObjective = parseMaybeJson(args.objective);
    const rawObjective = parsedObjective === undefined && typeof args.objective === 'string' && args.objective.trim() ? args.objective.trim() : parsedObjective;
    let objective = rawObjective === undefined || rawObjective === null ? null : parseProposedObjective(rawObjective);
    if (rawObjective !== undefined && rawObjective !== null && !objective) {
        notes.push('The objective was not understood and was ignored; the fight is a plain rout.');
    }
    if (objective && isPlainObjective(objective)) objective = null;
    let roster = combatants;
    let settled: ProposedObjective | undefined;
    if (objective) {
        const reconciled = reconcileObjective(combatants, objective);
        roster = reconciled.combatants;
        settled = reconciled.objective;
        for (const unit of reconciled.added) notes.push(`${unit.name} was not listed in combatants and was added to the fight as ${unit.side === 'ally' ? 'an ally' : 'a neutral bystander'}.`);
    }
    return {
        ok: true,
        value: {
            combatants: roster,
            ...(map ? { map } : {}),
            reason: cleanText(args.reason, TEXT_MAX),
            ...(settled ? { objective: settled } : {}),
        },
        notes,
        drops,
    };
}

export function isCombatToolAllowed(
    context: Pick<GameContext, 'combatModeActive' | 'combatSheet'>,
    session: CombatSession | null,
    proposal: CombatProposal | null,
): boolean {
    return context.combatModeActive === true
        && context.combatSheet?.needsAllocation === false
        && !session
        && !proposal;
}

export function signatureToolNotes(combatants: readonly ProposedCombatant[]): string[] {
    return combatants.flatMap((c, i) => (c.signature
        ? validateSignature({ id: `c${i}`, name: c.name, tier: c.tier }, c.signature).repairs.map(r => r.text)
        : []));
}

export function officerFlag(c: Pick<ProposedCombatant, 'officer' | 'npcId'>): boolean | undefined {
    if (c.officer !== undefined) return c.officer;
    return c.npcId ? true : undefined;
}

export function isOfficer(c: Pick<ProposedCombatant, 'officer' | 'npcId' | 'side' | 'tier'>): boolean {
    if (c.side === 'neutral') return false;
    return officerFlag(c) ?? DIRECTED_TIERS.has(c.tier);
}

export function hasEnemy(combatants: readonly ProposedCombatant[]): boolean {
    return combatants.some(c => c.side === 'enemy');
}
