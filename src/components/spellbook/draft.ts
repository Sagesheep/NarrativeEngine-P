import { chainOf, emptyChain } from '@narrative/engine';
import type { ChainDraft } from '@narrative/engine';
import type { FormId, GlyphAbility } from '../../types';

export type AbilityDraft = {
    id: string;
    name: string;
    description: string;
    damageType: string;
    chain: ChainDraft;
    source: GlyphAbility['source'];
};

export function blankDraft(): AbilityDraft {
    return { id: '', name: '', description: '', damageType: '', chain: emptyChain(), source: 'player' };
}

export function draftFrom(ability: GlyphAbility): AbilityDraft {
    return {
        id: ability.id,
        name: ability.name,
        description: ability.description ?? '',
        damageType: ability.damageType ?? '',
        chain: chainOf(ability),
        source: ability.source,
    };
}

export function toAbility(draft: AbilityDraft): GlyphAbility {
    return {
        id: draft.id,
        name: draft.name,
        ...(draft.description ? { description: draft.description } : {}),
        ...(draft.damageType ? { damageType: draft.damageType } : {}),
        form: { id: (draft.chain.form.id ?? '') as FormId, augments: [...draft.chain.form.augments] },
        effects: draft.chain.effects.map(e => ({ id: e.id, augments: [...e.augments] })),
        source: draft.source,
    };
}

export function sameDraft(a: AbilityDraft, b: AbilityDraft): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}
