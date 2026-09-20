import { hasKnownPosition } from '../location/knowledge';
import type { GameContext, LocationEntry, TravelHop, TravelMode } from '../../types';
import { modEventBus } from '../mods/events';

export type StoryMovement = { action: 'stay' | 'local' | 'depart' | 'continue' | 'arrive' | 'relocate'; place?: string; feature?: string | null };
export function parseStoryMovement(text: string): { present: boolean; movement: StoryMovement | null } {
    const present = /<!--\s*MOVEMENT\b/i.test(text);
    const matches = [...text.matchAll(/<!--\s*MOVEMENT\s+(.*?)\s*-->/gis)];
    if (!present || matches.length !== 1 || matches[0][1].length > 600) return { present, movement: null };
    try {
        const raw = JSON.parse(matches[0][1]);
        if (!raw || !['stay', 'local', 'depart', 'continue', 'arrive', 'relocate'].includes(raw.action)
            || (raw.place !== undefined && (typeof raw.place !== 'string' || raw.place.length > 100))
            || (raw.feature !== undefined && raw.feature !== null && (typeof raw.feature !== 'string' || raw.feature.length > 100))) return { present, movement: null };
        return { present, movement: { action: raw.action, place: raw.place?.trim(), feature: raw.feature?.trim() || null } };
    } catch { return { present, movement: null }; }
}
export function movementPositionKey(context: GameContext): string {
    return JSON.stringify([context.currentPlaceId ?? null, context.currentFeature ?? null, context.worldDay ?? null,
        context.travel ?? null, context.travelMinutesToday ?? 0]);
}
export function exactMovementPlace(value: string | undefined, ledger: LocationEntry[]): LocationEntry | undefined {
    if (!value) return undefined;
    const key = value.trim().toLowerCase();
    const matches = ledger.filter(place => place.id === value || place.name.toLowerCase() === key
        || place.aliases.split(',').some(alias => alias.trim().toLowerCase() === key));
    return matches.length === 1 ? matches[0] : undefined;
}
export function buildMovementContract(context: GameContext, ledger: LocationEntry[]): string {
    const current = ledger.find(place => place.id === context.currentPlaceId);
    const destinations = ledger.filter(place => place.kind !== 'transit' && hasKnownPosition(place) && place.id !== current?.id).slice(0, 24)
        .map(place => ({ id: place.id, name: place.name }));
    return `[MOVEMENT CONTRACT]
The engine position below supersedes older chat locations. Play the player's new message HERE unless their action actually changes location. Camp, conversation, looking around, memories, wishes and plans do not advance travel or time. Nearby discoveries are not reached automatically.
Current: ${JSON.stringify({ id: context.currentPlaceId ?? null, name: current?.name ?? null, feature: context.currentFeature ?? null, day: context.worldDay ?? null, travel: context.travel ?? null })}
Known destinations: ${JSON.stringify(destinations)}
Rumoured leads (not exact destinations; investigate or obtain directions before travelling to the place): ${JSON.stringify(ledger.filter(place => place.knowledge === 'rumoured' && place.id !== current?.id).slice(0, 24).map(place => ({ name: place.name, clue: place.knowledgeNote ?? '' })))}
Secret places are not character knowledge. Do not reveal them or infer exact coordinates from a rumour.
End this same reply with one hidden HTML comment: <!-- MOVEMENT {"action":"stay"} -->
Actions: stay = no movement (default); local = actually enter a room/district of the current place, include feature; depart = player starts travelling to a known place, include its exact id as place; continue = player spends one travel day advancing the active journey; arrive = completed arrival, include place; relocate = explicit established teleport/scene cut, include place. Depart/continue advance at most ONE engine checkpoint on commit; do not narrate reaching a distant destination. Arrive during travel is accepted only at its final remaining checkpoint. Ordinary cross-place travel must use depart, not relocate. Initial scene with no current place may use arrive with the containing place name and feature (Unknown settlement / Slum district if unnamed). New destinations require established scene/lore, never infer them from memories. Keep the visible location header consistent. If nothing changes use stay. Do not output coordinates or invent elapsed days. No additional tool or model call is required.`;
}
export function requestStoryRoute(campaignId: string, context: GameContext, toId: string, mode: TravelMode): Promise<TravelHop[] | null> {
    if (!modEventBus.getListenerCount('mod.worldmap.storyRoute')) return Promise.resolve(null);
    return new Promise(resolve => {
        const requestId = crypto.randomUUID();
        const finish = (value: TravelHop[] | null) => { clearTimeout(timer); unsubscribe(); resolve(value); };
        const unsubscribe = modEventBus.on('mod.worldmap.storyRouteResult', payload => {
            if (payload?.requestId !== requestId) return;
            const hops = payload.hops;
            finish(Array.isArray(hops) && hops.length > 0 && hops.every(hop => hop && typeof hop.fromId === 'string'
                && typeof hop.toId === 'string' && Number.isSafeInteger(hop.legs) && hop.legs > 0) ? hops as TravelHop[] : null);
        });
        const timer = setTimeout(() => finish(null), 10000);
        modEventBus.emitFromMod({ modId: 'worldmap', modName: 'World Map', file: 'worldmap/manifest.json' }, 'storyRoute',
            { requestId, campaignId, fromId: context.currentPlaceId, worldDay: context.worldDay, toId, mode, expiresAt: Date.now() + 8000 });
    });
}
