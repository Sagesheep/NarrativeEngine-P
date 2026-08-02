// Type declarations for the Arc Engine compute mod (WO-P5-12 §7 Step 3).
// The mod is a .js file in mods/arc.compute.js; these declarations let the
// oracle test (src/services/arc/arc.test.ts) import the pure functions with
// full type safety. The runtime values come from the .js file; the types here
// mirror the ArcRecord shapes from src/types/arc.ts.
//
// The declarations are the EXACT signatures of the in-tree functions that moved
// into the mod (arcDice.ts, arcStance.ts, arcSurface.ts, arcWorldState.ts,
// arcEngine.ts). The oracle test asserts the mod's behaviour is byte-identical
// to the deleted in-tree copies; these types make that assertion type-safe.

import type { ArcRecord, ArcStance, ArcWorldState, NPCPressure } from '../src/types/arc';
import type { DivergenceEntry } from '../src/types';

export const ARC_TICK_DC: { initial: number; reduction: number; floor: number };
export const LADDER_MIN: number;
export const LADDER_MAX: number;
export const MAX_ACTIVE_ARCS: number;
export const TYPE_COOLDOWN_SEAMS: number;
export const ARC_LIVE_RECENCY: number;
export const ARC_STANCE_MOD: Record<ArcStance, number>;
export const ARC_BAND_RUNG_DELTA: Record<string, number>;
export const ARC_SURFACE_EMIT_MIN: 'ambient' | 'rumor' | 'direct';
export const ARC_SURFACE_TIER: Record<string, number>;
export const ARC_LIVE_PRESSURE_THRESHOLD: number;

export function rollArcTick(
    arc: Pick<ArcRecord, 'tickDC'>,
    rng?: () => number,
): { fired: boolean; nextDc: number };

export function rollArcOutcome(
    arc: Pick<ArcRecord, 'stance'>,
    rng?: () => number,
): { band: string };

export function advanceRung(arc: ArcRecord, band: string): ArcRecord;

export function arcSurfaceLine(arc: ArcRecord): string;

export function scanArcStance(
    playerInput: string,
    gmText: string,
    activeArcs: ArcRecord[],
): { arcId: string; stance: ArcStance }[];

export function arcWorldState(
    arcs: ArcRecord[],
    openThreads: { text: string }[],
    pressure: Record<string, NPCPressure>,
    nowScene: number,
): ArcWorldState;

export interface ArcTickResult {
    arcs: ArcRecord[] | null;
    arcDigest: string | null;
    divergenceFacts: DivergenceEntry[];
}

export function runArcTick(
    arcs: ArcRecord[],
    archiveIndex: { sceneId: string }[],
    aiTier: unknown,
    displayInput: string,
    lastAssistantContent: string,
): ArcTickResult;