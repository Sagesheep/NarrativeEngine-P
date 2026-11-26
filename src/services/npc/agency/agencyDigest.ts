import type { Band } from './agencyConstants';
import { VISIBILITY_RUBRIC, DIGEST_PLAYER_CAP } from './agencyConstants';
import type { GoalHorizon } from '../../../types';

export type TickDelta = {
    npcId: string;
    // WO-08 (id-leak fix, Opus-ratified 2026-06-18): the player-facing prose MUST use names, not
    // internal ids. `proseLine` prefers `npcName` when present; falls back to `npcId` only for
    // backwards compat (callers that haven't been migrated). The debug view always shows the id.
    npcName?: string;
    goalText: string;
    horizon: GoalHorizon;
    band: Band;
    visibility: 'direct' | 'report' | 'hidden';
    note: string;
};

type DigestView = 'debug' | 'player';

const BAND_PROSE: Record<Band, string> = {
    critSuccess: 'achieved a breakthrough on',
    success:     'advanced toward',
    successBut:  'made progress on, but with complications —',
    failBut:     'stumbled on, yet gained something from —',
    fail:        'suffered a setback on',
    critFail:    'suffered a major setback on',
};

function visibilityFromBand(band: Band, horizon: GoalHorizon): TickDelta['visibility'] {
    return VISIBILITY_RUBRIC[band]?.[horizon] ?? 'hidden';
}

function proseLine(delta: TickDelta): string {
    const who = delta.npcName ?? delta.npcId;  // WO-08: prefer name, fall back to id (pre-fix callers)
    const verb = BAND_PROSE[delta.band] ?? 'moved on';
    return `${who} ${verb} "${delta.goalText}"${delta.note ? '; ' + delta.note : ''}`;
}

function debugLine(delta: TickDelta): string {
    return `[${delta.npcId}] ${delta.band}(${delta.horizon}) "${delta.goalText}" vis=${delta.visibility}${delta.note ? ' — ' + delta.note : ''}`;
}

export function buildDigest(deltas: TickDelta[], view: DigestView): string {
    if (deltas.length === 0) return '';

    if (view === 'debug') {
        return deltas.map(debugLine).join('\n');
    }

    const surfaced = deltas.filter(d => d.visibility === 'direct' || d.visibility === 'report');
    const capped = surfaced.slice(0, DIGEST_PLAYER_CAP);
    if (capped.length === 0) return '';
    return capped.map(proseLine).join('\n');
}

export { visibilityFromBand };