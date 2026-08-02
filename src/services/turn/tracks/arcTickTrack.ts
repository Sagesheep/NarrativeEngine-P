// WO-P5-12 §7 Step 2 — the Arc Engine tick as a post-turn compute track.
//
// Previously this ran inline in `postTurnPipeline.ts` inside its own hand-written
// `try/catch`, *outside* the `Promise.allSettled` group. Moving it into the track
// registry inherits the containment WO-P5-10 hardened (a throwing track cannot
// abort a sibling or the turn) and deletes the hand-written try/catch — a small,
// concrete measure of the architecture paying for itself (WO-P5-12 §5).
//
// The track is still shipped in-tree in this step (Step 3 extracts it to
// `mods/arc.compute.js`). It reads arcs from the store's `modTables` map
// (`mod.arc.arcs`, the mod-declared table from Step 1) and persists the tick's
// writes through the host facade:
//   - arcs → setModTable (the mod table)
//   - arcDigest → facade.write.updateContext (stays on context; §3: a prompt
//     contribution, not engine state)
//   - divergence facts → facade.write.setDivergenceRegister (or addMessage fallback)
//
// `shouldRun` is true whenever the arc mod's table is present in the store. A
// campaign with no arcs (or with the arc mod uninstalled) has an empty/absent
// table; the pure `runArcTick` no-ops on an empty array, so `shouldRun` only
// gates the dynamic-import cost, not correctness.

import { useAppStore } from '../../../store/useAppStore';
import { tierAllows } from '../aiTier';
import { uid } from '../../../utils/uid';
import type { ArcRecord } from '../../../types/arc';
import type { PostTurnTrack, PostTurnTrackContext } from './types';

const ARC_TABLE_KEY = 'mod.arc.arcs';

async function runArcTickTrack(ctx: PostTurnTrackContext): Promise<void> {
    const facade = ctx.facade;
    if (!facade) throw new Error('[ArcTick Track] missing host facade');
    const config = facade.config;
    if (!tierAllows(config.aiTier, 'arcTick')) return;

    const arcs = (useAppStore.getState().getModTable(ARC_TABLE_KEY) as ArcRecord[] | undefined) ?? [];
    if (!arcs || arcs.length === 0) return;

    const { runArcTick, applyArcDivergenceFacts } = await import('../../arc/arcEngine');
    const result = runArcTick(
        arcs,
        facade.data.archiveIndex,
        config.aiTier,
        ctx.displayInput,
        ctx.lastAssistantContent,
    );

    if (result.arcs) {
        useAppStore.getState().setModTable(ARC_TABLE_KEY, result.arcs);
    }
    if (result.arcDigest !== null) {
        facade.write.updateContext({ arcDigest: result.arcDigest });
    }
    if (result.divergenceFacts.length > 0) {
        const sceneId = facade.data.archiveIndex.length > 0
            ? facade.data.archiveIndex[facade.data.archiveIndex.length - 1].sceneId
            : '000';
        const merged = applyArcDivergenceFacts(
            facade.data.divergenceRegister,
            result.divergenceFacts,
            sceneId,
        );
        if (merged) {
            facade.write.setDivergenceRegister(merged);
            console.log(`[ArcTick] ${result.divergenceFacts.length} arc divergence fact(s) written`);
        } else {
            // No live register / callback this turn — surface the facts as a system
            // marker so they aren't lost (rare; the seal seam usually has the register).
            for (const f of result.divergenceFacts) {
                facade.write.addMessage({
                    id: uid(),
                    role: 'system',
                    name: 'arc-fact',
                    content: `[World moved] ${f.text}`,
                    timestamp: Date.now(),
                });
            }
        }
    }
}

export const arcTickTrack: PostTurnTrack<PostTurnTrackContext> = {
    id: 'track.arc-tick',
    name: 'Arc Engine Tick',
    description: 'Rolls tempo per active arc, advances the ladder, runs stance scan, and folds the surface line into the next GM call.',
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: false,
    shouldRun: (ctx) => {
        if (!ctx.facade) return false;
        // The arc mod's table is present in the store when the mod is installed.
        // Empty/absent → the tick has nothing to do; skip the dynamic import.
        // Defensive against stores that do not expose getModTable (e.g. partial
        // test states) — the runner contains a throw, but a clean false is quieter.
        const store = useAppStore.getState();
        if (typeof store.getModTable !== 'function') return false;
        const arcs = store.getModTable(ARC_TABLE_KEY);
        return Array.isArray(arcs) && arcs.length > 0;
    },
    run: runArcTickTrack,
};