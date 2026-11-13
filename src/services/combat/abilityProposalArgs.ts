import { AUGMENT_IDS, EFFECT_IDS, FORM_IDS, cleanAbilityName, validateAbility } from '@narrative/engine';
import type { AbilityLimits } from '@narrative/engine';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import type { AbilityProposal, AugmentId, CombatSession, EffectId, FormId, GameContext, GlyphAbility } from '../../types';
import { uid } from '../../utils/uid';
import { configOf, limitsOf } from './spellbook';

export const PROPOSE_ABILITY_TOOL_RESULT =
    'The ability has been offered to the player, who decides whether it enters the spellbook. Continue the scene. Do not describe the ability being used, and never state its numbers.';

export const ABILITY_ONE_AT_A_TIME =
    'propose_ability was not accepted: one ability proposal at a time. Continue the scene in narration.';

export type ParsedAbility = { ok: true; ability: GlyphAbility } | { ok: false; reasons: string[] };

function asRecord(raw: unknown): Record<string, unknown> | null {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
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

function parseArgs(raw: string | Record<string, unknown>): Record<string, unknown> | null {
    if (typeof raw !== 'string') return raw;
    try {
        return asRecord(JSON.parse(raw));
    } catch {
        const { value, parseOk } = extractJsonRobust<Record<string, unknown>>(raw, {});
        return parseOk ? asRecord(value) : null;
    }
}

function word(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function augmentList(raw: unknown, reasons: string[], where: string): AugmentId[] {
    const list = parseMaybeJson(raw);
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
        reasons.push(`${where} must be an array of augment names`);
        return [];
    }
    const out: AugmentId[] = [];
    for (const item of list) {
        const w = word(item);
        if ((AUGMENT_IDS as readonly string[]).includes(w)) out.push(w as AugmentId);
        else reasons.push(`${where}: "${String(item)}" is not an augment (use ${AUGMENT_IDS.join(', ')})`);
    }
    return out;
}

function cleanText(raw: unknown, max: number): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const text = raw.replace(/\s+/g, ' ').trim().slice(0, max);
    return text || undefined;
}

export function parseAbilityArgs(raw: string | Record<string, unknown>, limits: AbilityLimits): ParsedAbility {
    const args = parseArgs(raw);
    if (!args) return { ok: false, reasons: ['the arguments were not a JSON object'] };
    const reasons: string[] = [];
    const name = cleanAbilityName(args.name);
    if (!name) reasons.push('`name` is required');
    const formWord = word(args.form);
    if (!(FORM_IDS as readonly string[]).includes(formWord)) reasons.push(`\`form\` must be one of ${FORM_IDS.join(', ')}`);
    const formAugments = augmentList(args.formAugments, reasons, '`formAugments`');
    const rawEffects = parseMaybeJson(args.effects);
    const effects: GlyphAbility['effects'] = [];
    if (!Array.isArray(rawEffects) || rawEffects.length === 0) {
        reasons.push('`effects` must be an array of 1 to 4 objects like {"effect":"damage","augments":[]}');
    } else {
        rawEffects.forEach((item, i) => {
            const rec = asRecord(parseMaybeJson(item));
            const effectWord = word(rec?.effect ?? rec?.id ?? item);
            if (!(EFFECT_IDS as readonly string[]).includes(effectWord)) {
                reasons.push(`effects[${i}]: "${effectWord || String(item)}" is not an effect (use ${EFFECT_IDS.join(', ')})`);
                return;
            }
            effects.push({ id: effectWord as EffectId, augments: augmentList(rec?.augments, reasons, `effects[${i}].augments`) });
        });
    }
    if (reasons.length > 0) return { ok: false, reasons };
    const description = cleanText(args.description, 400);
    const damageType = cleanText(args.damageType, 24);
    const ability: GlyphAbility = {
        id: `ai_${uid()}`,
        name,
        ...(description ? { description } : {}),
        ...(damageType ? { damageType } : {}),
        form: { id: formWord as FormId, augments: formAugments },
        effects,
        source: 'ai',
    };
    const invalid = validateAbility(ability, limits);
    return invalid.length > 0 ? { ok: false, reasons: invalid } : { ok: true, ability };
}

export function rejectionText(reasons: readonly string[]): string {
    return `propose_ability was not accepted: ${reasons.join('; ')}. Fix the arguments and call it again, or continue the scene in narration.`;
}

export function isAbilityToolAllowed(
    context: Pick<GameContext, 'combatModeActive' | 'combatSheet'>,
    session: CombatSession | null,
    proposal: AbilityProposal | null,
): boolean {
    return context.combatModeActive === true && !!context.combatSheet && !session && !proposal;
}

export function abilityLimitsOf(context: Pick<GameContext, 'combatConfig'>): AbilityLimits {
    return limitsOf(configOf(context));
}
