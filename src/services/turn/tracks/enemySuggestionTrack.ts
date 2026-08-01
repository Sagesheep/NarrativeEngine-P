import type { EndpointConfig } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { backgroundQueue } from '../../infrastructure/backgroundQueue';
import { detectEnemySuggestions } from '../../enemy/enemySuggestions';
import {
    decideDiscoveryScan,
    type EnemyDiscoveryContext,
} from '../../enemy/enemyDiscoveryController';
import { buildHostFacade, hasHostModelRole, type HostFacade, type ModelRequest, type ModelRole } from '../hostFacade';
import type { PostTurnTrack, PostTurnTrackContext } from './types';

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

function getFacade(ctx: PostTurnTrackContext): { facade: HostFacade; useBroker: boolean } {
    if (ctx.facade) return { facade: ctx.facade, useBroker: true };
    if (!ctx.state || !ctx.callbacks) throw new Error('[Enemy Discovery] missing host facade');
    return { facade: buildHostFacade(ctx.state, ctx.callbacks), useBroker: false };
}

const sourceRole: Record<'utility' | 'auxiliary' | 'summariser' | 'story', ModelRole> = {
    utility: 'utility',
    auxiliary: 'raw-auxiliary',
    summariser: 'raw-summariser',
    story: 'story',
};

function placeholder(role: ModelRole): EndpointConfig {
    return { endpoint: `facade:${role}`, apiKey: '', modelName: role };
}

async function runEnemySuggestionTrack(ctx: PostTurnTrackContext): Promise<void> {
    const { facade, useBroker } = getFacade(ctx);
    const state = ctx.state;
    const activeCampaignId = ctx.activeCampaignId;
    const discoveryState = getDiscoveryState(activeCampaignId);
    const archiveIndex = facade.data.archiveIndex;
    const sceneNumber = archiveIndex.length > 0
        ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
        : 0;

    if (!facade.write.addEnemySuggestions) return;

    const discoveryCtx: EnemyDiscoveryContext = {
        campaignId: activeCampaignId,
        tier: facade.config.aiTier,
        enabled: facade.data.enemyCombatConfig?.enemyDiscoveryEnabled === true,
        sceneNumber,
        lastScanScene: discoveryState.lastScanScene,
        inFlight: discoveryState.inFlight,
        enemyCompendium: facade.data.enemyCompendium,
        providers: useBroker
            ? {
                utilityProvider: hasHostModelRole(facade, 'utility') ? placeholder('utility') : undefined,
                auxiliaryProvider: hasHostModelRole(facade, 'raw-auxiliary') ? placeholder('raw-auxiliary') : undefined,
                summariserProvider: hasHostModelRole(facade, 'raw-summariser') ? placeholder('raw-summariser') : undefined,
                storyProvider: hasHostModelRole(facade, 'story') ? placeholder('story') : undefined,
            }
            : {
                utilityProvider: state?.getUtilityEndpoint?.(),
                auxiliaryProvider: state?.getRawAuxiliaryProvider?.(),
                summariserProvider: state?.getRawSummariserProvider?.(),
                storyProvider: state?.getFreshProvider(),
            },
    };

    const decision = decideDiscoveryScan(discoveryCtx);
    if (decision.kind !== 'run') return;

    const modelRole = useBroker ? sourceRole[decision.providerSource] : undefined;
    const modelCall = modelRole
        ? (request: ModelRequest) => facade.model.call(modelRole, request)
        : undefined;
    discoveryState.inFlight = true;

    backgroundQueue.push('Enemy-Discovery', async () => {
        try {
            if (useAppStore.getState().activeCampaignId !== activeCampaignId) {
                console.warn('[Enemy Discovery] Skipping queued scan — campaign changed before start.');
                return;
            }
            const suggestions = await detectEnemySuggestions(
                useBroker ? undefined : decision.provider,
                ctx.lastAssistantContent,
                facade.data.enemyCompendium,
                modelCall,
            );
            if (!suggestions.length) return;
            if (useAppStore.getState().activeCampaignId !== activeCampaignId) {
                console.warn('[Enemy Discovery] Dropping suggestions because the active campaign changed.');
                return;
            }
            facade.write.addEnemySuggestions(suggestions, ctx.lastAssistantContent);
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

export const enemySuggestionTrack: PostTurnTrack<PostTurnTrackContext> = {
    id: 'track.enemy-suggestion',
    name: 'Enemy Discovery',
    description: 'Scans the GM reply for creatures worth adding to the enemy compendium and queues them for review.',
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => !!ctx.callbacks?.addEnemySuggestions || !!ctx.facade,
    run: runEnemySuggestionTrack,
};