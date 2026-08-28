/**
 * WO 6.5 — the engine travel action. One press = one day = one checkpoint.
 *
 * The button departs on the first press (creating the travel state and landing
 * the party on camp 1) and advances on the rest. No LLM call on any press —
 * the engine posts its own `role: 'system'` line at each checkpoint.
 *
 * This module is the single place that orchestrates a travel press. The three
 * entry points (map, Places panel, composer TRAVEL) all call `composeDeparture`
 * for the first press; subsequent presses call `advanceLeg`. The system message
 * is posted here so the entry points do not diverge.
 */
import type { LocationEntry, TravelState } from '../../types';
import type { ChatMessage } from '../../types/campaign';
import { uid } from '../../utils/uid';
import {
    advance,
    type TransitionResult,
} from './travelState';

/**
 * Build the engine's checkpoint system message. WO 6.5 §3:
 *
 * ```
 * Day 13 · camp 1 of 8 — birch scrub under the ridge
 * ```
 *
 * The message is `role: 'system'`, `name: 'travel-checkpoint'` — the engine
 * speaking as the engine, not the GM. Until WO 7 lands there is no feature
 * vocabulary, so v1 emits a thin terrain line (the biome from the chunk grid
 * when available) or just the day/leg header.
 */
export function buildCheckpointMessage(
    travel: TravelState,
    worldDay: number,
    ledger: readonly LocationEntry[],
    terrainLabel?: string,
): ChatMessage {
    const to = ledger.find(l => l.id === travel.toId);
    const toName = to?.name ?? travel.toId;
    const campNum = travel.leg;
    const totalCamps = travel.totalLegs;
    const day = worldDay ?? 1;

    const header = `Day ${day} · camp ${campNum} of ${totalCamps} — road to ${toName}`;
    const content = terrainLabel ? `${header} · ${terrainLabel}` : header;

    return {
        id: uid(),
        role: 'system',
        name: 'travel-checkpoint',
        content,
        timestamp: Date.now(),
    };
}

/**
 * Build the arrival system message. Posted when the journey ends.
 */
export function buildArrivalMessage(
    travel: TravelState,
    worldDay: number,
    ledger: readonly LocationEntry[],
): ChatMessage {
    const to = ledger.find(l => l.id === travel.toId);
    const toName = to?.name ?? travel.toId;
    const day = worldDay ?? 1;

    return {
        id: uid(),
        role: 'system',
        name: 'travel-arrive',
        content: `Day ${day} · arrived at ${toName}`,
        timestamp: Date.now(),
    };
}

/**
 * Apply a travel press. If no journey is active, returns `null` (the caller
 * should have called `composeDeparture` instead). If a journey is active,
 * advances one leg and returns the `TransitionResult` plus the system message
 * to post. When the journey ends, the result carries `arrive()` and the
 * message is an arrival message.
 */
export function pressTravelAdvance(
    travel: TravelState,
    currentWorldDay: number | undefined,
    ledger: readonly LocationEntry[],
): { result: TransitionResult; message: ChatMessage } | null {
    if (!travel) return null;

    const result = advance(travel, currentWorldDay);
    const newDay = result.contextPatch.worldDay ?? (currentWorldDay ?? 0) + 1;

    if (!result.travel) {
        // Journey ended — arrival.
        return { result, message: buildArrivalMessage(travel, newDay, ledger) };
    }

    return { result, message: buildCheckpointMessage(result.travel, newDay, ledger) };
}

/**
 * Abandon the journey. Clears `travel` without arriving and returns the line
 * the engine posts. Both the composer chip and the map's Abandon button go
 * through here so the two cannot post different sentences for the same act.
 */
export function buildAbandonMessage(
    travel: TravelState,
    ledger: readonly LocationEntry[],
): ChatMessage {
    const to = ledger.find(l => l.id === travel.toId);
    return {
        id: uid(),
        role: 'system',
        name: 'travel-abandon',
        content: `Journey to ${to?.name ?? travel.toId} abandoned.`,
        timestamp: Date.now(),
    };
}

/**
 * WO 6.5 §1 — the button label for the current travel state.
 *
 * This used to read `Day N →`, which names the side effect rather than the
 * act: the player is not pressing a date, they are pressing "keep going".
 * `Continue` says what the button does; how far along the road they are is
 * the panel's and the checkpoint line's job to say, and the tooltip carries
 * the camp count for the composer strip where there is no room for it.
 */
export function travelButtonLabel(travel: TravelState | null | undefined): string {
    if (!travel) return 'Travel';
    if (travel.leg >= travel.totalLegs) return 'Arrive';
    return `Continue →`;
}

/** The hover text that carries the detail the compact label leaves out. */
export function travelButtonTitle(travel: TravelState | null | undefined): string {
    if (!travel) return 'Open the destination picker and depart';
    if (travel.leg >= travel.totalLegs) return 'Finish the journey and arrive';
    return `Travel on to camp ${travel.leg + 1} of ${travel.totalLegs} — one press, one day`;
}