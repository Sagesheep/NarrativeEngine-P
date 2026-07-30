import type { TurnState, TurnCallbacks } from '../turnOrchestrator';
import { useAppStore } from '../../../store/useAppStore';
import { backgroundQueue } from '../../infrastructure/backgroundQueue';
import { detectEnemySuggestions } from '../../enemy/enemySuggestions';
import {
    decideDiscoveryScan,
    type EnemyDiscoveryContext,
} from '../../enemy/enemyDiscoveryController';
import type { PostTurnTrack, PostTurnTrackContext } from './types';

// WO-P2-03 — moved verbatim from `postTurnPipeline.ts` (was the enemy-discovery
// single-flight state + `runEnemySuggestionTrack`, L937-1045). Body, parameter list,
// guard placement and logging are byte-for-byte the original; only the surrounding
// import paths changed. `clearEnemyDiscoveryState` is re-exported from
// `postTurnPipeline.ts` so the campaign-switch caller's dynamic import still resolves.

/**
 * Per-campaign enemy-discovery single-flight + cooldown state. At most one
 * discovery request may be pending or running per campaign; an eligible turn
 * that arrives while one is in flight is skipped (never queued as a backlog).
 * `lastScanScene` records the scene number of the last accepted scan so the
 * tier cooldown (Pro: 5, Max: 0, Lite: blocked) is enforced.
 *
 * Cleared on campaign switch via `clearEnemyDiscoveryState` (called from the
 * campaign-switch path so a stale in-flight flag from a closed campaign does
 * not block a reopened one).
 */
const enemyDiscoveryState = new Map<string, { inFlight: boolean; lastScanScene: number }>();

export function clearEnemyDiscoveryState(campaignId: string | null | undefined): void {
    if (!campaignId) return;
    enemyDiscoveryState.delete(campaignId);
}

function getDiscoveryState(campaignId: string): { inFlight: boolean; lastScanScene: number } {
    let entry = enemyDiscoveryState.get(campaignId);
    if (!entry) {
        entry = { inFlight: false, lastScanScene: -Infinity };
        enemyDiscoveryState.set(campaignId, entry);
    }
    return entry;
}

/**
 * Runs the conservative utility-model enemy scan after a committed turn.
 *
 * Tier + flag + cooldown + single-flight gating happens in `decideDiscoveryScan`
 * BEFORE the background task is queued, so an ineligible turn never enters the
 * queue (no discovery backlog). The background task re-verifies the active
 * campaign before writing suggestions (second guard), and the controller clears
 * the in-flight flag in a `finally` so a crashed scan never permanently blocks
 * the campaign.
 *
 * Provider precedence (utility → auxiliary → story-only-as-final-fallback) is
 * enforced by `resolveDiscoveryProvider`. The Story AI is only used when no
 * secondary endpoint exists, and that choice is made explicit in the decision.
 */
async function runEnemySuggestionTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    activeCampaignId: string,
): Promise<void> {
    if (!callbacks.addEnemySuggestions) return;

    const discoveryState = getDiscoveryState(activeCampaignId);
    const sceneNumber = state.archiveIndex.length > 0
        ? parseInt(state.archiveIndex[state.archiveIndex.length - 1].sceneId, 10) || 0
        : 0;

    const discoveryCtx: EnemyDiscoveryContext = {
        campaignId: activeCampaignId,
        tier: state.settings.aiTier,
        enabled: state.enemyCombatConfig?.enemyDiscoveryEnabled === true,
        sceneNumber,
        lastScanScene: discoveryState.lastScanScene,
        inFlight: discoveryState.inFlight,
        enemyCompendium: state.enemyCompendium ?? [],
        providers: {
            utilityProvider: state.getUtilityEndpoint?.(),
            // Raw secondary endpoints — NOT getFreshAuxiliaryProvider, which
            // silently returns the Story provider when the auxiliary endpoint
            // has no model name. Discovery must never use the Story AI unless
            // all secondary endpoints are absent or unusable, so we read the
            // raw getRawAuxiliaryProvider/getRawSummariserProvider resolvers here.
            auxiliaryProvider: state.getRawAuxiliaryProvider?.(),
            summariserProvider: state.getRawSummariserProvider?.(),
            storyProvider: state.getFreshProvider(),
        },
    };

    const decision = decideDiscoveryScan(discoveryCtx);
    if (decision.kind !== 'run') return;

    // Mark in-flight immediately so a concurrent eligible turn skips (single-flight).
    discoveryState.inFlight = true;

    backgroundQueue.push('Enemy-Discovery', async () => {
        try {
            // Re-verify the active campaign before starting the queued request.
            if (useAppStore.getState().activeCampaignId !== activeCampaignId) {
                console.warn('[Enemy Discovery] Skipping queued scan — campaign changed before start.');
                return;
            }
            const suggestions = await detectEnemySuggestions(decision.provider, lastAssistantContent, state.enemyCompendium ?? []);
            if (!suggestions.length) return;
            // Re-verify the active campaign before writing suggestions.
            if (useAppStore.getState().activeCampaignId !== activeCampaignId) {
                console.warn('[Enemy Discovery] Dropping suggestions because the active campaign changed.');
                return;
            }
            callbacks.addEnemySuggestions?.(suggestions, lastAssistantContent);
        } catch (error) {
            console.warn('[Enemy Discovery] Background scan failed:', error);
        } finally {
            const current = enemyDiscoveryState.get(activeCampaignId);
            if (current) {
                current.inFlight = false;
                if (useAppStore.getState().activeCampaignId === activeCampaignId) {
                    current.lastScanScene = sceneNumber;
                }
            }
        }
    }).catch(error => console.warn('[Enemy Discovery] Background scan failed:', error));
}

/**
 * Race-guards: the two inline `useAppStore.getState().activeCampaignId !== activeCampaignId`
 * re-verifications inside the queued closure (one before the LLM request, one before the
 * suggestion write) plus the third in the `finally` that gates the `lastScanScene` stamp.
 * All three moved with the body, in the same places.
 *
 * `shouldRun` mirrors the body's own opening guard (`!callbacks.addEnemySuggestions`). The
 * guard is deliberately left in the body too: the body is a verbatim move, and the
 * duplication means calling `run` directly is still safe.
 */
export const enemySuggestionTrack: PostTurnTrack<PostTurnTrackContext> = {
    id: 'track.enemy-suggestion',
    name: 'Enemy Discovery',
    description: 'Scans the GM reply for creatures worth adding to the enemy compendium and queues them for review.',
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => !!ctx.callbacks.addEnemySuggestions,
    run: (ctx) => runEnemySuggestionTrack(
        ctx.state,
        ctx.callbacks,
        ctx.lastAssistantContent,
        ctx.activeCampaignId,
    ),
};
