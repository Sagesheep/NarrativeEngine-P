import { abilityReadiness } from '../glyphs/apply';
import { AUGMENT_IDS, EFFECT_IDS, EFFECTS, FORM_IDS, FORMS } from '../glyphs/registry';
import { abilityCost, cleanAbilityName, glyphCount, validateAbility } from '../glyphs/validate';
import type {
    AugmentId, CombatState, CombatTier, Combatant, EffectId, FormId, GlyphAbility, Signature, SignatureEffectSpec, SignatureRepair,
    SignatureRepairCode, SignatureSpec,
} from '../types';
import { SIGNATURE_BUDGET, SIGNATURE_ID_PREFIX, SIGNATURE_NAME_FALLBACK, SIGNATURE_SURCHARGE, SIGNATURE_UNUSABLE_EFFECTS } from './tables';
import type { SignatureBudget } from './tables';

const FORM_SET: ReadonlySet<string> = new Set(FORM_IDS);
const EFFECT_SET: ReadonlySet<string> = new Set(EFFECT_IDS);
const AUGMENT_SET: ReadonlySet<string> = new Set(AUGMENT_IDS);

function key(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

function augmentsOf(raw: unknown): AugmentId[] {
    if (typeof raw === 'string') return raw.split(/[,+]/).map(key).filter(Boolean) as AugmentId[];
    if (!Array.isArray(raw)) return [];
    return raw.map(key).filter(Boolean) as AugmentId[];
}

function effectOf(raw: unknown): SignatureEffectSpec | null {
    if (typeof raw === 'string') {
        const id = key(raw);
        return id ? { id: id as EffectId, augments: [] } : null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = key(r.id ?? r.effect ?? r.name);
    return id ? { id: id as EffectId, augments: augmentsOf(r.augments) } : null;
}

export function normalizeSignatureRequest(raw: unknown): SignatureSpec | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    let formId = '';
    let formAugments: AugmentId[] = [];
    if (typeof r.form === 'string') {
        formId = key(r.form);
        formAugments = augmentsOf(r.augments ?? r.formAugments);
    } else if (r.form && typeof r.form === 'object') {
        const f = r.form as Record<string, unknown>;
        formId = key(f.id);
        formAugments = augmentsOf(f.augments ?? r.augments);
    }
    const effectsRaw = Array.isArray(r.effects) ? r.effects : typeof r.effect === 'string' ? [r.effect] : [];
    const effects = effectsRaw.map(effectOf).filter((e): e is SignatureEffectSpec => !!e);
    if (!formId && effects.length === 0) return null;
    const name = typeof r.name === 'string' ? r.name : '';
    const damageType = typeof r.damageType === 'string' && r.damageType.trim() ? r.damageType.trim().toLowerCase() : undefined;
    return { name, ...(damageType ? { damageType } : {}), form: formId as FormId, augments: formAugments, effects };
}

type Working = { form: FormId; augments: AugmentId[]; effects: Array<{ id: EffectId; augments: AugmentId[] }> };

function abilityOf(unit: Pick<Combatant, 'id'>, name: string, damageType: string | undefined, w: Working): GlyphAbility {
    return {
        id: `${SIGNATURE_ID_PREFIX}${unit.id}`,
        name,
        ...(damageType ? { damageType } : {}),
        form: { id: w.form, augments: [...w.augments] },
        effects: w.effects.map(e => ({ id: e.id, augments: [...e.augments] })),
        source: 'ai',
    };
}

function trimOnce(w: Working): boolean {
    const last = w.effects[w.effects.length - 1];
    if (last && last.augments.length > 0) {
        last.augments.pop();
        return true;
    }
    if (w.effects.length > 1) {
        w.effects.pop();
        return true;
    }
    if (w.augments.length > 0) {
        w.augments.pop();
        return true;
    }
    return false;
}

function describe(w: Working): string {
    return [w.form, ...w.augments, ...w.effects.flatMap(e => [e.id, ...e.augments])].join(' ');
}

export function signatureCost(ability: GlyphAbility): number {
    return abilityCost(ability) + ability.effects.reduce((sum, e) => sum + (SIGNATURE_SURCHARGE[e.id] ?? 0), 0);
}

export type SignatureValidation = {
    ability: GlyphAbility | null;
    signature: Signature | null;
    repairs: SignatureRepair[];
};

export function validateSignature(
    unit: Pick<Combatant, 'id' | 'name'> & { tier: CombatTier },
    spec: SignatureSpec,
    limits: { maxSummons?: number } = {},
): SignatureValidation {
    const repairs: SignatureRepair[] = [];
    const note = (code: SignatureRepairCode, text: string, from?: unknown, to?: unknown) => {
        repairs.push({ unitId: unit.id, unitName: unit.name, code, text, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
    };
    const dropped = (code: SignatureRepairCode, text: string): SignatureValidation => {
        note(code, text);
        return { ability: null, signature: null, repairs };
    };
    const budget: SignatureBudget | undefined = SIGNATURE_BUDGET[unit.tier];
    if (!budget) return dropped('no_budget', `${unit.name} is a ${unit.tier}; only grunts, elites, bosses and legendary units may have a signature move, so it was dropped.`);
    const cleaned = cleanAbilityName(spec?.name);
    const name = cleaned || SIGNATURE_NAME_FALLBACK;
    if (!cleaned) note('name_defaulted', `${unit.name}'s signature had no name and is called "${SIGNATURE_NAME_FALLBACK}".`, spec?.name, SIGNATURE_NAME_FALLBACK);
    const formId = key(spec?.form);
    if (!FORM_SET.has(formId)) return dropped('invalid_dropped', `${unit.name}'s signature "${name}" has no valid form (${formId || 'none'}), so it was dropped.`);
    const form = FORMS[formId as FormId];
    const w: Working = { form: formId as FormId, augments: [], effects: [] };
    for (const raw of Array.isArray(spec.augments) ? spec.augments : []) {
        const a = key(raw);
        if (!AUGMENT_SET.has(a)) note('unknown_glyph', `"${String(raw)}" is not a glyph; removed from ${unit.name}'s signature.`, raw);
        else if (!form.augments.includes(a as AugmentId)) note('unusable_effect', `The ${formId} form does not accept ${a}; removed from ${unit.name}'s signature.`, raw);
        else w.augments.push(a as AugmentId);
    }
    for (const raw of Array.isArray(spec.effects) ? spec.effects : []) {
        const id = key(raw?.id);
        if (!EFFECT_SET.has(id) || EFFECTS[id as EffectId].builtin) {
            note('unknown_glyph', `"${String(raw?.id)}" is not an effect glyph; removed from ${unit.name}'s signature.`, raw?.id);
            continue;
        }
        if (!form.effects.includes(id as EffectId)) {
            note('unusable_effect', `The ${formId} form cannot carry ${id}; removed from ${unit.name}'s signature.`, id);
            continue;
        }
        if (SIGNATURE_UNUSABLE_EFFECTS.has(id as EffectId)) {
            note('unusable_effect', `The engine's planner cannot use ${id} in a signature; removed from ${unit.name}'s signature.`, id);
            continue;
        }
        if (w.effects.some(e => e.id === id)) {
            note('unusable_effect', `${id} appears twice; the second was removed from ${unit.name}'s signature.`, id);
            continue;
        }
        const spec2 = EFFECTS[id as EffectId];
        const aug: AugmentId[] = [];
        for (const a of Array.isArray(raw.augments) ? raw.augments : []) {
            const k = key(a);
            if (!AUGMENT_SET.has(k)) note('unknown_glyph', `"${String(a)}" is not a glyph; removed from ${unit.name}'s signature.`, a);
            else if (!spec2.augments.includes(k as AugmentId)) note('unusable_effect', `${id} does not accept ${k}; removed from ${unit.name}'s signature.`, a);
            else aug.push(k as AugmentId);
        }
        w.effects.push({ id: id as EffectId, augments: aug });
    }
    if (w.effects.length === 0) return dropped('invalid_dropped', `${unit.name}'s signature "${name}" has no usable effect, so it was dropped.`);
    const damageType = spec.damageType?.trim().toLowerCase() || undefined;
    const limitsFor = { maxChainLength: budget.glyphs, maxSummons: limits.maxSummons ?? 2 };
    const original = { glyphs: glyphCount(abilityOf(unit, name, damageType, w)), cost: signatureCost(abilityOf(unit, name, damageType, w)), chain: describe(w) };
    for (;;) {
        const ability = abilityOf(unit, name, damageType, w);
        const reasons = validateAbility(ability, limitsFor);
        const cost = signatureCost(ability);
        if (reasons.length === 0 && cost <= budget.cost) {
            if (describe(w) !== original.chain) {
                note(
                    'trimmed',
                    `${unit.name}'s signature "${name}" was over budget (cost ${original.cost}, ${original.glyphs} glyphs; the ${unit.tier} ceiling is cost ${budget.cost}, ${budget.glyphs} glyphs) and was trimmed from the end to ${describe(w)}.`,
                    original.chain,
                    describe(w),
                );
            }
            return { ability, signature: { abilityId: ability.id, usesLeft: budget.uses }, repairs };
        }
        if (!trimOnce(w)) {
            return dropped(
                cost > budget.cost ? 'over_budget_dropped' : 'invalid_dropped',
                `${unit.name}'s signature "${name}" cannot be made to fit (${reasons[0] ?? `cost ${cost} over ${budget.cost}`}), so it was dropped.`,
            );
        }
    }
}

export function signatureReady(state: CombatState, c: Combatant): boolean {
    const sig = c.signature;
    if (!sig || sig.usesLeft <= 0) return false;
    const ability = c.kit?.find(a => a.id === sig.abilityId);
    if (!ability) return false;
    return abilityReadiness(state, c, ability, { actorId: c.id, moveLeft: 0, actionUsed: false }) === null;
}
