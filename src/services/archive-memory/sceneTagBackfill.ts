import type { ArchiveIndexEntry, ProviderConfig, EndpointConfig, SceneEvent, SceneHook, SceneTags } from '../../types';
import { analyzeScene } from './sceneEventExtractor';
import { closeHookPatches, hooksNamedInText, openHooks } from './sceneTags';

/**
 * User-triggered analysis of scenes archived before tags or definitions existed, one
 * model call per scene. A scene that is already tagged only gains its definition: its
 * tags and hooks (some possibly closed since) are kept. It never starts on its own (no surprise token spend). Oldest first, so a
 * hook from one scene can be resolved by a later one. Stopping keeps finished work,
 * and running again continues with the scenes still missing something.
 */

export type SceneTagPatch = { sceneId: string; events?: SceneEvent[]; tags?: SceneTags; hooks?: SceneHook[]; definition?: string };

/** `stoppedOnErrors`: this many failures in a row means the model is unreachable, not
 *  that a few scenes were hard, so the run stops instead of failing every scene. */
export type SceneTagBackfillResult = { tagged: number; failed: number; aborted: boolean; stoppedOnErrors?: boolean };

const MAX_FAILURES_IN_A_ROW = 3;

export function scenesNeedingAnalysis(index: readonly ArchiveIndexEntry[]): ArchiveIndexEntry[] {
    return index.filter(entry => entry.tags === undefined || entry.definition === undefined);
}

export async function backfillSceneTags(params: {
    index: readonly ArchiveIndexEntry[];
    provider: ProviderConfig | EndpointConfig;
    fetchScenes: (sceneIds: string[]) => Promise<{ sceneId: string; content: string }[]>;
    patch: (patches: SceneTagPatch[]) => Promise<void>;
    isActive: () => boolean;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
}): Promise<SceneTagBackfillResult> {
    const { provider, fetchScenes, patch, isActive, signal, onProgress } = params;
    const live = params.index.map(entry => ({ ...entry }));
    const targets = scenesNeedingAnalysis(live);
    let tagged = 0;
    let failed = 0;
    let failuresInARow = 0;
    const fail = () => { failed++; failuresInARow++; return failuresInARow >= MAX_FAILURES_IN_A_ROW; };

    for (let i = 0; i < targets.length; i++) {
        if (signal?.aborted || !isActive()) return { tagged, failed, aborted: true };
        onProgress?.(i, targets.length);
        const entry = targets[i];

        try {
            const [scene] = await fetchScenes([entry.sceneId]);
            if (!scene) { if (fail()) return { tagged, failed, aborted: true, stoppedOnErrors: true }; continue; }
            const analysis = await analyzeScene(provider, scene.content, entry.sceneId, {
                signal,
                openHooks: hooksNamedInText(openHooks(live), scene.content),
            });
            if (signal?.aborted || !isActive()) return { tagged, failed, aborted: true };
            if (!analysis) { if (fail()) return { tagged, failed, aborted: true, stoppedOnErrors: true }; continue; }

            if (entry.tags !== undefined) {
                // Already tagged: only the definition is missing.
                if (!analysis.definition) { if (fail()) return { tagged, failed, aborted: true, stoppedOnErrors: true }; continue; }
                await patch([{ sceneId: entry.sceneId, definition: analysis.definition }]);
                entry.definition = analysis.definition;
                tagged++;
                failuresInARow = 0;
                continue;
            }

            const closing = closeHookPatches(live, analysis.resolvedHookIds, entry.sceneId);
            await patch([
                {
                    sceneId: entry.sceneId,
                    // Events from the chapter seal are better informed, so they are never replaced.
                    ...(entry.events === undefined && analysis.events.length > 0 ? { events: analysis.events } : {}),
                    tags: analysis.tags,
                    hooks: analysis.hooks,
                    ...(analysis.definition ? { definition: analysis.definition } : {}),
                },
                ...closing,
            ]);
            entry.tags = analysis.tags;
            entry.hooks = analysis.hooks;
            entry.definition = analysis.definition;
            for (const closed of closing) {
                const source = live.find(e => e.sceneId === closed.sceneId);
                if (source) source.hooks = closed.hooks;
            }
            tagged++;
            failuresInARow = 0;
        } catch (err) {
            if (signal?.aborted || !isActive()) return { tagged, failed, aborted: true };
            console.warn(`[SceneTagBackfill] Scene ${entry.sceneId} failed:`, err);
            if (fail()) return { tagged, failed, aborted: true, stoppedOnErrors: true };
        }
    }

    onProgress?.(targets.length, targets.length);
    return { tagged, failed, aborted: false };
}
