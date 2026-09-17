import type { GameContext, TravelMode } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { anchorSceneLocation } from '../locationHeader';
import { exactMovementPlace, movementPositionKey, parseStoryMovement, requestStoryRoute } from './storyMovement';
import { advance, depart, departMultiHop, mergeUpserts } from './travelState';
import { connectionBand } from '../locationParser';
import { modEventBus } from '../mods/events';

/** Returns true whenever the contract owns this turn, including invalid/rejected output. */
export async function applyStoryMovement(content: string, campaignId: string): Promise<boolean> {
    const parsed = parseStoryMovement(content);
    if (!parsed.present) return false;
    const state = useAppStore.getState();
    if (state.activeCampaignId !== campaignId) return true;
    const movement = parsed.movement;
    const reject = (reason: string) => state.addMessage?.({ id: crypto.randomUUID(), role: 'system', name: 'movement-status',
        content: `Movement unchanged: ${reason}`, timestamp: Date.now() });
    if (!movement) { reject('the story movement update was malformed.'); return true; }
    if (movement.action === 'stay') return true;
    const context = state.context;
    const ledger = state.locationLedger ?? [];
    const current = ledger.find(place => place.id === context.currentPlaceId);
    const target = exactMovementPlace(movement.place, ledger);
    const apply = (patch: Partial<GameContext>) => state.updateContext(patch);
    if (movement.action === 'local') {
        if (!current || !movement.feature || (movement.place && target?.id !== current.id)) { reject('the local feature does not belong to the current place.'); return true; }
        if (!current.features.some(feature => feature.toLowerCase() === movement.feature!.toLowerCase()) && current.features.length < 20) {
            state.updateLocation(current.id, { features: [...current.features, movement.feature] });
        }
        apply({ currentFeature: movement.feature });
        return true;
    }
    if (movement.action === 'continue' || (movement.action === 'arrive' && context.travel)) {
        const travel = context.travel;
        if (!travel || (movement.action === 'arrive' && (target?.id !== travel.toId || travel.leg + 1 < travel.totalLegs))) {
            reject('there is no matching journey ready for arrival. Use travel to continue the route.'); return true;
        }
        apply(advance(travel, context.worldDay).contextPatch);
        return true;
    }
    if (movement.action === 'depart') {
        if (!current || !target || target.id === current.id || target.kind === 'transit' || context.travel) {
            reject('choose a known destination from your current stop, with no other journey active.'); return true;
        }
        const mode: TravelMode = context.travelMode ?? 'foot';
        const key = movementPositionKey(context);
        const hasMap = modEventBus.getListenerCount('mod.worldmap.storyRoute') > 0;
        const hops = hasMap ? await requestStoryRoute(campaignId, context, target.id, mode) : null;
        const fresh = useAppStore.getState();
        if (fresh.activeCampaignId !== campaignId || movementPositionKey(fresh.context) !== key) return true;
        const connection = current.connections.find(edge => edge.toId === target.id);
        if ((hasMap && !hops) || (!hasMap && !connection)) { reject('no usable route was found. Check the destination and travel mode on the map.'); return true; }
        const result = hops ? departMultiHop({ fromId: current.id, toId: target.id, mode, hops, ledger: fresh.locationLedger, currentWorldDay: context.worldDay })
            : depart({ fromId: current.id, toId: target.id, mode, band: connectionBand(connection!), ledger: fresh.locationLedger, currentWorldDay: context.worldDay });
        if (result.ledgerUpsert) fresh.setLocationLedger(mergeUpserts(fresh.locationLedger, result.ledgerUpsert));
        fresh.updateContext(result.contextPatch);
        return true;
    }
    // Ordinary cross-place arrival must use an engine journey. Scene cuts/portals are explicit.
    if (movement.action === 'arrive' && current && target?.id !== current.id) {
        reject('cross-place travel needs a journey; the narrated destination was not applied.'); return true;
    }
    if (!movement.place || /[\r\n|<>]/.test(movement.place)) { reject('no valid containing place was supplied.'); return true; }
    const name = target?.name ?? movement.place;
    const { outcome, created } = anchorSceneLocation(`📍 ${name}${movement.feature ? ' — ' + movement.feature : ''}`, ledger, context.currentPlaceId ?? null);
    if (created) state.addLocation(created);
    if (outcome.kind === 'resolved') {
        if (outcome.appendFeature && outcome.feature && target) state.updateLocation(target.id, { features: [...target.features, outcome.feature] });
        apply({ currentPlaceId: outcome.placeId, currentFeature: outcome.feature, travel: null });
    } else reject('the containing place could not be resolved.');
    return true;
}
