// ─── Arc Engine (System 2 / Oracle Function) Types ──────────────────────────
// Phase 3 port: an arc is a staged track — a 5–12 rung ladder authored once at
// spawn, advanced by dice, bent by player stance, surfaced indirectly. The
// engine owns currentRung + tickDC; the LLM only authors the ladder at birth
// and narrates the rung through the existing GM call.

export type ArcType =
    | 'economic' | 'political' | 'factional' | 'social'
    | 'supernatural' | 'criminal' | 'environmental';

export type ArcStance = 'opposed' | 'aided' | 'ignored' | 'fled' | 'unaware';

export type ArcSurfaceTier = 'ambient' | 'rumor' | 'direct';
// Mobile code calls this `ArcSurface`; keep the alias for faithful port.
export type ArcSurface = ArcSurfaceTier;

export type ArcStage = {
    label: string;          // authored-once prose, ONE rung of the ladder
    surface: ArcSurfaceTier; // how this rung reaches the player
};

export type ArcRecord = {
    id: string;
    type: ArcType;
    title: string;          // short, for logs/debug — NOT shown to the player as-is
    seed: string;           // the one grounding sentence the ladder grew from
    ladder: ArcStage[];     // 5–12 rungs, quiet → crisis (LADDER_MIN..LADDER_MAX)
    currentRung: number;    // engine-owned index into ladder; starts 0
    tickDC: number;         // escalating-DC tempo timer; starts ARC_TICK_DC.initial
    stance: ArcStance;      // last value from scanArcStance; defaults 'unaware'
    status: 'active' | 'resolved' | 'boiled_over' | 'defused';
    bornScene: string;      // sceneId at spawn
    lastTickScene: string;  // sceneId of the last rung change (recency signal)
};

export type ArcWorldState = 'live' | 'stalled' | 'dry';