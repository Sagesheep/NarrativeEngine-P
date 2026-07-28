import type { AiTier, EndpointConfig, ProviderConfig, EnemyEntry, EnemySuggestion } from '../../types';
import { tierAllows, ENEMY_DISCOVERY_COOLDOWN } from '../turn/aiTier';
import { detectEnemySuggestions, type EnemySuggestionDraft } from './enemySuggestions';

export type EnemyDiscoveryProviderChain = {
    utilityProvider?: EndpointConfig | ProviderConfig | undefined;
    auxiliaryProvider?: EndpointConfig | ProviderConfig | undefined;
    summariserProvider?: EndpointConfig | ProviderConfig | undefined;
    storyProvider?: EndpointConfig | ProviderConfig | undefined;
};

export type EnemyDiscoveryContext = {
    campaignId: string;
    tier: AiTier | undefined;
    enabled: boolean;
    sceneNumber: number;
    lastScanScene: number;
    inFlight: boolean;
    enemyCompendium: EnemyEntry[];
    providers: EnemyDiscoveryProviderChain;
};

export type EnemyDiscoveryDecision =
    | { kind: 'skip'; reason: 'disabled' | 'tier-blocked' | 'cooldown' | 'in-flight' | 'no-provider' }
    | { kind: 'run'; provider: EndpointConfig | ProviderConfig; providerSource: 'utility' | 'auxiliary' | 'summariser' | 'story' };

const usable = (provider: EndpointConfig | ProviderConfig | undefined): provider is EndpointConfig | ProviderConfig =>
    Boolean(provider && (provider as EndpointConfig).endpoint && (provider as EndpointConfig).modelName);

/**
 * Provider precedence for enemy discovery:
 *   Utility → Auxiliary/Context → Summariser → Story fallback.
 *
 * The Story AI is selected ONLY when all three secondary endpoints are absent
 * or unusable. A secondary endpoint missing its model name is treated as absent
 * (not silently promoted to the Story provider) — this is the safety fix for
 * the helper that returned Story while appearing auxiliary.
 *
 * IMPORTANT: callers MUST pass the raw secondary endpoints (the results of
 * `getActiveUtilityEndpoint` / `getActiveAuxiliaryEndpoint` /
 * `getActiveSummarizerEndpoint`), NOT `getFreshAuxiliaryProvider`, which
 * silently returns the Story provider when the auxiliary endpoint has no model
 * name. Passing `getFreshAuxiliaryProvider` here would defeat the precedence
 * chain.
 */
export function resolveDiscoveryProvider(chain: EnemyDiscoveryProviderChain): {
    provider: EndpointConfig | ProviderConfig | undefined;
    source: 'utility' | 'auxiliary' | 'summariser' | 'story' | 'none';
} {
    if (usable(chain.utilityProvider)) return { provider: chain.utilityProvider, source: 'utility' };
    if (usable(chain.auxiliaryProvider)) return { provider: chain.auxiliaryProvider, source: 'auxiliary' };
    if (usable(chain.summariserProvider)) return { provider: chain.summariserProvider, source: 'summariser' };
    // Story is the final fallback ONLY when no secondary endpoint is configured.
    // The `source` field makes this fallback explicit to callers and tests.
    if (usable(chain.storyProvider)) return { provider: chain.storyProvider, source: 'story' };
    return { provider: undefined, source: 'none' };
}

/**
 * Decides whether a discovery scan should run for this turn. Returns the
 * resolved provider and source, or a skip reason. Enforces:
 * - disabled flag (default OFF)
 * - tier gate (Lite is runtime-blocked even if the persisted flag is true)
 * - per-campaign cooldown (Pro: 5 scenes, Max: 0)
 * - single-flight (skip if a scan is already pending/running for this campaign)
 */
export function decideDiscoveryScan(ctx: EnemyDiscoveryContext): EnemyDiscoveryDecision {
    if (!ctx.enabled) return { kind: 'skip', reason: 'disabled' };
    if (!tierAllows(ctx.tier, 'enemyDiscovery')) return { kind: 'skip', reason: 'tier-blocked' };
    if (ctx.inFlight) return { kind: 'skip', reason: 'in-flight' };
    const cooldown = ENEMY_DISCOVERY_COOLDOWN[ctx.tier ?? 'pro'];
    if (ctx.sceneNumber - ctx.lastScanScene < cooldown) return { kind: 'skip', reason: 'cooldown' };
    const { provider, source } = resolveDiscoveryProvider(ctx.providers);
    if (!provider || source === 'none') return { kind: 'skip', reason: 'no-provider' };
    return { kind: 'run', provider, providerSource: source };
}

/**
 * Wraps the per-campaign single-flight + cooldown lifecycle around a discovery
 * scan. The caller provides the campaign's current in-flight flag and
 * last-accepted scene number; this controller enforces the decision before the
 * LLM call and clears the flag after the call settles (success or failure).
 *
 * `onSuggestions` is invoked ONLY when the active campaign is still the one
 * that started the scan (the caller passes a verification callback). This is
 * the second campaign-switch guard — the first is the queue guard before the
 * scan starts.
 */
export async function runDiscoveryScan(
    ctx: EnemyDiscoveryContext,
    narrative: string,
    apply: (drafts: EnemySuggestionDraft[], context: string) => void,
    isActiveCampaign: () => boolean,
    setInFlight: (inFlight: boolean) => void,
    setLastScanScene: (scene: number) => void,
): Promise<void> {
    const decision = decideDiscoveryScan(ctx);
    if (decision.kind !== 'run') return;
    setInFlight(true);
    try {
        const drafts = await detectEnemySuggestions(decision.provider, narrative, ctx.enemyCompendium);
        if (!drafts.length) return;
        if (!isActiveCampaign()) return;
        apply(drafts, narrative);
    } catch (error) {
        console.warn('[Enemy Discovery] Scan failed:', error);
    } finally {
        setInFlight(false);
        if (isActiveCampaign()) setLastScanScene(ctx.sceneNumber);
    }
}

/** Helper to build EnemySuggestion records (with id/firstSeen/context) from drafts. */
export function toEnemySuggestions(
    drafts: EnemySuggestionDraft[],
    now: number,
    createId: () => string,
): EnemySuggestion[] {
    return drafts.map(draft => ({
        ...draft,
        id: createId(),
        firstSeen: now,
        context: undefined,
    }));
}