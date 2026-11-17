import { useCallback, useMemo, useRef, useState } from 'react';
import { abilityTargets, findUsableAbility, legalAims, needsAim as engineNeedsAim, payloadAt, payloadChoices, previewAbilityPushes, sameTeam } from '@narrative/engine';
import type { PayloadChoice, PushPreview, ThrowPayload, ThrowPlan } from '@narrative/engine';
import type { CombatAction, CombatPos, CombatState, GlyphAbility } from '../../types';
import { posKey } from './combatVisuals';

export type AimHit = { id: string; friendly: boolean };

export type AimPreview = {
    ok: boolean;
    tiles: CombatPos[];
    hits: AimHit[];
    pushes: PushPreview[];
    reason?: string;
    plan?: ThrowPlan;
    lift?: ThrowPayload;
    liftName?: string;
};

export type ThrowAim = {
    step: 1 | 2;
    payload: ThrowPayload | null;
    payloadName: string | null;
    items: readonly PayloadChoice[];
    hand: PayloadChoice | null;
    choose: (payload: ThrowPayload) => void;
};

export type AbilityAim = {
    ability: GlyphAbility;
    actorId: string;
    legal: ReadonlySet<string>;
    legalList: readonly CombatPos[];
    preview: (p: CombatPos | null) => AimPreview | null;
    confirm: (p: CombatPos | null) => void;
    cancel: () => void;
    throwing?: ThrowAim;
};

export function needsAim(ability: GlyphAbility): boolean {
    return engineNeedsAim(ability);
}

export function isThrow(ability: GlyphAbility): boolean {
    return ability.builtin?.kind === 'throw';
}

function hitsOf(state: CombatState, actorId: string, ids: readonly string[]): AimHit[] {
    const actor = state.combatants[actorId];
    return ids.map(id => {
        const c = state.combatants[id];
        return { id, friendly: !!actor && !!c && (c.id === actor.id || sameTeam(actor.side, c.side)) };
    });
}

export function computeAimPreview(state: CombatState, actorId: string, ability: GlyphAbility, p: CombatPos | null, payload?: ThrowPayload): AimPreview {
    const result = abilityTargets(state, actorId, ability, p, payload);
    return {
        ok: result.ok,
        tiles: result.ok ? result.tiles : [],
        hits: result.ok ? hitsOf(state, actorId, result.targetIds) : [],
        pushes: result.ok ? previewAbilityPushes(state, actorId, ability, result) : [],
        ...(result.ok && result.throw ? { plan: result.throw } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
    };
}

export function computeLiftPreview(state: CombatState, actorId: string, p: CombatPos | null): AimPreview {
    if (!p) return { ok: false, tiles: [], hits: [], pushes: [] };
    const found = payloadAt(state, actorId, p);
    if (!found.ok) return { ok: false, tiles: [], hits: [], pushes: [], reason: found.reason };
    const name = payloadChoices(state, actorId).find(c => c.pos && c.pos.x === p.x && c.pos.y === p.y)?.name;
    const id = found.payload.kind === 'creature' ? found.payload.id : null;
    return {
        ok: true,
        tiles: [{ ...p }],
        hits: id ? hitsOf(state, actorId, [id]) : [],
        pushes: [],
        lift: found.payload,
        ...(name ? { liftName: name } : {}),
    };
}

export function useAbilityAim(
    state: CombatState,
    actorId: string | null,
    abilityId: string | null,
    onAction: (action: CombatAction) => void,
    onCancel: () => void,
): AbilityAim | null {
    const ability = actorId && abilityId ? findUsableAbility(state.combatants[actorId], abilityId) : undefined;
    const throwAbility = !!ability && isThrow(ability);
    const [lifted, setLifted] = useState<{ key: string; payload: ThrowPayload } | null>(null);
    const liftKey = `${actorId ?? ''}|${abilityId ?? ''}|${state.turnCount ?? 0}`;
    const payload = throwAbility && lifted && lifted.key === liftKey ? lifted.payload : null;
    const step: 1 | 2 = throwAbility && payload ? 2 : 1;
    const legalList = useMemo(() => {
        if (!actorId || !ability) return [];
        return throwAbility ? legalAims(state, actorId, ability, payload ?? undefined) : legalAims(state, actorId, ability);
    }, [state, actorId, ability, throwAbility, payload]);
    const legal = useMemo(() => new Set(legalList.map(posKey)), [legalList]);
    const cacheRef = useRef<{ state: CombatState | null; ability: GlyphAbility | undefined; payload: ThrowPayload | null; map: Map<string, AimPreview> }>({ state: null, ability: undefined, payload: null, map: new Map() });
    const preview = useCallback((p: CombatPos | null): AimPreview | null => {
        if (!actorId || !ability) return null;
        const c = cacheRef.current;
        if (c.state !== state || c.ability !== ability || c.payload !== payload) cacheRef.current = { state, ability, payload, map: new Map() };
        const cache = cacheRef.current.map;
        const k = `${step}:${p ? posKey(p) : 'none'}`;
        const hit = cache.get(k);
        if (hit) return hit;
        const next = throwAbility && step === 1
            ? computeLiftPreview(state, actorId, p)
            : computeAimPreview(state, actorId, ability, p, payload ?? undefined);
        cache.set(k, next);
        return next;
    }, [state, actorId, ability, throwAbility, step, payload]);
    const choose = useCallback((next: ThrowPayload) => {
        setLifted({ key: liftKey, payload: next });
    }, [liftKey]);
    const confirm = useCallback((p: CombatPos | null) => {
        if (!actorId || !ability) return;
        if (throwAbility) {
            if (!p || !legal.has(posKey(p))) return;
            if (step === 1) {
                const found = payloadAt(state, actorId, p);
                if (found.ok) choose(found.payload);
                return;
            }
            onAction({ type: 'use_ability', actorId, abilityId: ability.id, aim: p, ...(payload ? { payload } : {}) });
            return;
        }
        const aim = needsAim(ability) ? p : null;
        if (needsAim(ability) && (!p || !legal.has(posKey(p)))) return;
        onAction({ type: 'use_ability', actorId, abilityId: ability.id, aim });
    }, [actorId, ability, legal, onAction, throwAbility, step, payload, state, choose]);
    const cancel = useCallback(() => {
        if (throwAbility && step === 2) {
            setLifted(null);
            return;
        }
        onCancel();
    }, [throwAbility, step, onCancel]);
    const throwing = useMemo<ThrowAim | undefined>(() => {
        if (!actorId || !ability || !throwAbility) return undefined;
        const choices = payloadChoices(state, actorId);
        const chosen = payload ? choices.find(c => c.payload.kind === payload.kind && JSON.stringify(c.payload) === JSON.stringify(payload)) : undefined;
        return {
            step,
            payload,
            payloadName: chosen?.name ?? null,
            items: choices.filter(c => c.payload.kind === 'item'),
            hand: choices.find(c => c.payload.kind === 'hand') ?? null,
            choose,
        };
    }, [state, actorId, ability, throwAbility, step, payload, choose]);
    if (!actorId || !ability) return null;
    return { ability, actorId, legal, legalList, preview, confirm, cancel, ...(throwing ? { throwing } : {}) };
}
