import { useCallback, useMemo, useRef } from 'react';
import { abilityTargets, findKitAbility, legalAims, sameTeam } from '@narrative/engine';
import type { CombatAction, CombatPos, CombatState, GlyphAbility } from '../../types';
import { posKey } from './combatVisuals';

export type AimHit = { id: string; friendly: boolean };

export type AimPreview = {
    ok: boolean;
    tiles: CombatPos[];
    hits: AimHit[];
    reason?: string;
};

export type AbilityAim = {
    ability: GlyphAbility;
    actorId: string;
    legal: ReadonlySet<string>;
    legalList: readonly CombatPos[];
    preview: (p: CombatPos | null) => AimPreview | null;
    confirm: (p: CombatPos | null) => void;
    cancel: () => void;
};

export function needsAim(ability: GlyphAbility): boolean {
    return ability.form.id !== 'self' || ability.effects.some(e => e.id === 'blink');
}

export function computeAimPreview(state: CombatState, actorId: string, ability: GlyphAbility, p: CombatPos | null): AimPreview {
    const result = abilityTargets(state, actorId, ability, p);
    const actor = state.combatants[actorId];
    const hits = result.targetIds.map(id => {
        const c = state.combatants[id];
        return { id, friendly: !!actor && !!c && (c.id === actor.id || sameTeam(actor.side, c.side)) };
    });
    return { ok: result.ok, tiles: result.ok ? result.tiles : [], hits: result.ok ? hits : [], ...(result.reason ? { reason: result.reason } : {}) };
}

export function useAbilityAim(
    state: CombatState,
    actorId: string | null,
    abilityId: string | null,
    onAction: (action: CombatAction) => void,
    onCancel: () => void,
): AbilityAim | null {
    const ability = actorId && abilityId ? findKitAbility(state.combatants[actorId], abilityId) : undefined;
    const legalList = useMemo(() => (actorId && ability ? legalAims(state, actorId, ability) : []), [state, actorId, ability]);
    const legal = useMemo(() => new Set(legalList.map(posKey)), [legalList]);
    const cacheRef = useRef<{ state: CombatState | null; ability: GlyphAbility | undefined; map: Map<string, AimPreview> }>({ state: null, ability: undefined, map: new Map() });
    const preview = useCallback((p: CombatPos | null): AimPreview | null => {
        if (!actorId || !ability) return null;
        if (cacheRef.current.state !== state || cacheRef.current.ability !== ability) cacheRef.current = { state, ability, map: new Map() };
        const cache = cacheRef.current.map;
        const k = p ? posKey(p) : 'none';
        const hit = cache.get(k);
        if (hit) return hit;
        const next = computeAimPreview(state, actorId, ability, p);
        cache.set(k, next);
        return next;
    }, [state, actorId, ability]);
    const confirm = useCallback((p: CombatPos | null) => {
        if (!actorId || !ability) return;
        const aim = needsAim(ability) ? p : null;
        if (needsAim(ability) && (!p || !legal.has(posKey(p)))) return;
        onAction({ type: 'use_ability', actorId, abilityId: ability.id, aim });
    }, [actorId, ability, legal, onAction]);
    if (!actorId || !ability) return null;
    return { ability, actorId, legal, legalList, preview, confirm, cancel: onCancel };
}
