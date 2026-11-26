import type { GameContext } from '../../types';
import { rollEngines as engineRollEngines } from '@narrative/engine';
import type { EngineDefaultLists, EngineRollResult, WorldTagParts } from '@narrative/engine';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHAT, DEFAULT_WORLD_WHERE,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHY
} from '../../store/useAppStore';

// The roll logic lives in @narrative/engine (shared with the mobile app).
// This wrapper supplies the desktop shell's two divergences — its default tag
// lists and its [WORLD_EVENT: …] wording — and re-exports the rest 1:1 so
// call sites are unchanged.

export { rollDiceFairness, resolveManualRoll, executeGateRoll, parseDiceExpr } from '@narrative/engine';
export type { EngineRollResult, GateRollResult, ManualRollResult } from '@narrative/engine';

const DESKTOP_DEFAULTS: EngineDefaultLists = {
    surpriseTypes: DEFAULT_SURPRISE_TYPES,
    surpriseTones: DEFAULT_SURPRISE_TONES,
    encounterTypes: DEFAULT_ENCOUNTER_TYPES,
    encounterTones: DEFAULT_ENCOUNTER_TONES,
    worldWho: DEFAULT_WORLD_WHO,
    worldWhat: DEFAULT_WORLD_WHAT,
    worldWhere: DEFAULT_WORLD_WHERE,
    worldWhy: DEFAULT_WORLD_WHY,
};

const formatWorldTag = ({ who, what, where, why }: WorldTagParts): string =>
    `[WORLD_EVENT: ${who} ${what} ${why} ${where}]`;

export function rollEngines(context: GameContext): EngineRollResult {
    return engineRollEngines(context, { defaults: DESKTOP_DEFAULTS, formatWorldTag });
}
