import { ELEMENT_IDS, TILE_MARK_IDS } from '@narrative/engine';
import type { ElementId, TileMarkId } from '@narrative/engine';
import { t } from '../../i18n';
import type { TranslateKey } from '../../i18n';
import type { CombatEvent, CombatState } from '../../types';
import { CONDITION_LABEL_KEYS } from '../../components/character/tabs/glyphLabels';

const RIDER_KEYS: Readonly<Record<string, TranslateKey>> = {
    burning: 'combat.rider.burning',
    soaked: 'combat.rider.soaked',
    staggered: 'combat.rider.staggered',
    chilled: 'combat.rider.chilled',
    revealed: 'combat.rider.revealed',
    blinded: 'combat.rider.blinded',
    sticky: 'combat.rider.sticky',
    coated: 'combat.rider.coated',
    dazed: 'combat.rider.dazed',
    confused: 'combat.rider.confused',
};

const REACTION_KEYS: Readonly<Record<string, TranslateKey>> = {
    douse: 'combat.log.reaction.douse',
    cool: 'combat.log.reaction.cool',
    melt: 'combat.log.reaction.melt',
    burn_away: 'combat.log.reaction.burn_away',
    brighten: 'combat.log.reaction.brighten',
    freeze: 'combat.log.reaction.freeze',
    conduct: 'combat.log.reaction.conduct',
};

const PLACED_KEYS: Readonly<Record<string, TranslateKey>> = {
    sigil: 'combat.placed.sigil',
    mantle: 'combat.placed.mantle',
    wall: 'combat.placed.wall',
    delay: 'combat.placed.delay',
};

function nameOf(state: CombatState, id: unknown): string {
    return (typeof id === 'string' && state.combatants[id]?.name) || '?';
}

function num(raw: unknown): number {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function isElementId(raw: unknown): raw is ElementId {
    return typeof raw === 'string' && (ELEMENT_IDS as readonly string[]).includes(raw);
}

function isMarkId(raw: unknown): raw is TileMarkId {
    return typeof raw === 'string' && (TILE_MARK_IDS as readonly string[]).includes(raw);
}

function markWord(raw: unknown): string {
    return isMarkId(raw) ? t(`combat.mark.${raw}`) : '?';
}

function conditionWord(id: string): string {
    const key = CONDITION_LABEL_KEYS[id];
    return key ? t(key) : id;
}

function abilityOf(event: CombatEvent): string {
    const raw = event.data.ability;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : '?';
}

export function hitWord(event: CombatEvent): string | null {
    if (event.type !== 'ability_damage' || (!isElementId(event.data.element) && event.data.immune !== true)) return null;
    if (event.data.immune === true) return t('combat.hit.immune');
    if (event.data.weakness === true) return t('combat.hit.weak');
    if (event.data.resisted === true) return t('combat.hit.resisted');
    return null;
}

export function elementLogText(event: CombatEvent, state: CombatState): string | null {
    switch (event.type) {
        case 'element_rider': {
            const key = typeof event.data.rider === 'string' ? RIDER_KEYS[event.data.rider] : undefined;
            if (!key) return null;
            return t('combat.log.rider', { name: nameOf(state, event.targetId), condition: t(key), turns: num(event.data.turns) });
        }
        case 'burn':
            return t('combat.log.burn', { name: nameOf(state, event.targetId), damage: num(event.data.damage) });
        case 'confused':
            return t('combat.log.confused', { name: nameOf(state, event.actorId), target: nameOf(state, event.targetId) });
        case 'mark_harm':
            return event.data.immune === true
                ? t('combat.log.markImmune', { name: nameOf(state, event.targetId), mark: markWord(event.data.mark) })
                : t('combat.log.markHarm', { name: nameOf(state, event.targetId), mark: markWord(event.data.mark), damage: num(event.data.damage) });
        case 'reaction': {
            const key = typeof event.data.reaction === 'string' ? REACTION_KEYS[event.data.reaction] : undefined;
            return key ? t(key, { name: nameOf(state, event.targetId) }) : null;
        }
        case 'placed': {
            const placed = event.data.placed as { expiresRound?: unknown; tiles?: unknown[] } | undefined;
            if (event.data.kind === 'mark') {
                return t('combat.log.markPlaced', { mark: markWord(event.data.mark), squares: Array.isArray(placed?.tiles) ? placed.tiles.length : 0, round: num(placed?.expiresRound) });
            }
            const key = typeof event.data.kind === 'string' ? PLACED_KEYS[event.data.kind] : undefined;
            if (!key) return null;
            return event.data.kind === 'delay'
                ? t('combat.log.delayPlaced', { name: nameOf(state, event.actorId), ability: abilityOf(event) })
                : t('combat.log.placed', { name: nameOf(state, event.actorId), kind: t(key), ability: abilityOf(event), round: num(placed?.expiresRound) });
        }
        case 'placed_triggered': {
            const key = typeof event.data.kind === 'string' ? PLACED_KEYS[event.data.kind] : undefined;
            if (!key) return null;
            return event.data.missed === true
                ? t('combat.log.triggeredEmpty', { kind: t(key), ability: abilityOf(event) })
                : t('combat.log.triggered', { kind: t(key), ability: abilityOf(event), name: nameOf(state, event.targetId) });
        }
        case 'placed_ended': {
            if (event.data.kind === 'mark') {
                const placed = event.data.placed as { mark?: unknown } | undefined;
                return event.data.why === 'expired' ? t('combat.log.markEnded', { mark: markWord(placed?.mark) }) : null;
            }
            const key = typeof event.data.kind === 'string' ? PLACED_KEYS[event.data.kind] : undefined;
            return key ? t('combat.log.ended', { kind: t(key), ability: abilityOf(event) }) : null;
        }
        case 'dispelled': {
            const removed = Array.isArray(event.data.removed) ? event.data.removed.filter((s): s is string => typeof s === 'string') : [];
            return t('combat.log.dispelled', { name: nameOf(state, event.targetId), list: removed.map(conditionWord).join(', ') || '?' });
        }
        case 'decayed':
            return t('combat.log.decayed', { name: nameOf(state, event.targetId), amount: num(event.data.amount) });
        case 'rewound':
            return t('combat.log.rewound', { name: nameOf(state, event.actorId) });
        case 'gravity':
            return t('combat.log.gravity', { ability: abilityOf(event) });
        case 'condition_added': {
            if (event.data.glyph !== true || typeof event.data.condition !== 'string') return null;
            return t('combat.log.condition', { name: nameOf(state, event.targetId), condition: conditionWord(event.data.condition) });
        }
        case 'ability_damage': {
            const word = hitWord(event);
            return word ? t('combat.log.hit', { text: event.text, word }) : null;
        }
        default:
            return null;
    }
}

export function translateElementEvents(events: readonly CombatEvent[], state: CombatState): CombatEvent[] {
    return events.map(e => {
        const text = elementLogText(e, state);
        return text === null ? e : { ...e, text };
    });
}
