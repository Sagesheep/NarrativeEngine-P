// Arc Engine (System 2 / Oracle Function) — barrel.
// WO-P5-12 §7 Step 3 — the Arc Engine's pure logic (dice, stance scan, surface
// line, world-state read-model, tick orchestrator) moved out of `src/services/arc/`
// into the compute mod (`mods/arc.compute.js`). The mod's `postTurn` hook runs
// in the browser-worker sandbox; its state lives in the `mod.arc.arcs` table.
//
// What stays host-side (WO-P5-12 §2b, §5):
//   - `arcSpawn.ts` — the +1 LLM call, fired from the ArcInjectorButton (a React
//     component, outside the sandbox boundary per 00_PLAN.md §12a).
//   - `openThreads.ts` — used by the spawn button to pick a spawn anchor.
//   - `arcConstants.ts` — the spawn path imports it; the constants are locked
//     by the WO-01 contract. The mod has its own copy (the sandbox cannot import
//     from `src/`). Reported as a finding in the WO-P5-12 report.
// The chapter-tab rendering also stays host-side until PANELS/SCREENS.

export {
    ARC_TICK_DC,
    LADDER_MIN,
    LADDER_MAX,
    MAX_ACTIVE_ARCS,
    TYPE_COOLDOWN_SEAMS,
    ARC_LIVE_RECENCY,
    ARC_STANCE_MOD,
    ARC_BAND_RUNG_DELTA,
    ARC_SURFACE_EMIT_MIN,
    ARC_SURFACE_TIER,
    ARC_LIVE_PRESSURE_THRESHOLD,
} from './arcConstants';
export type { ArcType, ArcStance, ArcSurface } from './arcConstants';

// WO-03 — spawn (+1 LLM). Seam gate removed; now fired manually via the Arc Injector.
export { spawnArc, pickArcSpawnInput } from './arcSpawn';
export type { SpawnArcInput, SpawnArcAnchor } from './arcSpawn';

export { computeOpenThreads } from './openThreads';