import { normalizeMapSpec } from '@narrative/engine';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import {
    COMBAT_ARCHETYPES, COMBAT_MANNER_MAX, COMBAT_TIERS, MAX_PROPOSED_COMBATANTS, PROPOSED_ATTACK_STYLES, PROPOSED_COMBATANT_SIDES,
} from '../../types';
import type {
    Archetype, CombatMapSpec, CombatProposal, CombatSession, CombatTier, GameContext, NPCEntry,
    ProposedAttackStyle, ProposedCombatant, ProposedCombatantSide,
} from '../../types';

const NAME_MAX = 60;
const TEXT_MAX = 160;

export type ParsedCombatArgs = {
    combatants: ProposedCombatant[];
    map?: CombatMapSpec;
    reason: string;
};

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
): { ok: true; value: ParsedCombatArgs } | { ok: false; error: string } {
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
    const combatants: ProposedCombatant[] = clipped.map((e, i) => {
        const archetype = typeof e.archetype === 'string' && (COMBAT_ARCHETYPES as readonly string[]).includes(e.archetype.trim().toLowerCase())
            ? e.archetype.trim().toLowerCase() as Archetype
            : undefined;
        const npcName = cleanText(e.npcName, NAME_MAX) || undefined;
        const npcId = resolveNpcId(npcName, ledger);
        const species = cleanText(e.species, NAME_MAX) || undefined;
        const look = cleanText(e.look, TEXT_MAX) || undefined;
        const manner = cleanText(e.manner, COMBAT_MANNER_MAX) || undefined;
        const attack = typeof e.attack === 'string' && (PROPOSED_ATTACK_STYLES as readonly string[]).includes(e.attack.trim().toLowerCase())
            ? e.attack.trim().toLowerCase() as ProposedAttackStyle
            : undefined;
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
            ...(attack ? { attack } : {}),
        };
    });
    const map = parseMap(args.map);
    return {
        ok: true,
        value: { combatants, ...(map ? { map } : {}), reason: cleanText(args.reason, TEXT_MAX) },
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

export function hasEnemy(combatants: readonly ProposedCombatant[]): boolean {
    return combatants.some(c => c.side === 'enemy');
}
