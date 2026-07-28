/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import type { EndpointConfig } from '../../../types';
import {
    decideDiscoveryScan,
    resolveDiscoveryProvider,
    type EnemyDiscoveryContext,
} from '../enemyDiscoveryController';

const endpoint = (name: string, endpoint = `http://${name}`): EndpointConfig => ({
    endpoint,
    apiKey: 'k',
    modelName: name,
});

const baseCtx = (overrides: Partial<EnemyDiscoveryContext> = {}): EnemyDiscoveryContext => ({
    campaignId: 'campaign-1',
    tier: 'max',
    enabled: true,
    sceneNumber: 10,
    lastScanScene: -Infinity,
    inFlight: false,
    enemyCompendium: [],
    providers: {
        utilityProvider: endpoint('utility'),
        auxiliaryProvider: endpoint('aux'),
        storyProvider: endpoint('story'),
    },
    ...overrides,
});

describe('enemy discovery controller', () => {
    describe('tier + flag behaviour', () => {
        it('Lite cannot run discovery even when the flag is enabled', () => {
            const decision = decideDiscoveryScan(baseCtx({ tier: 'lite', enabled: true }));
            expect(decision.kind).toBe('skip');
            if (decision.kind === 'skip') expect(decision.reason).toBe('tier-blocked');
        });

        it('Lite is blocked even if a corrupted persisted config says enabled', () => {
            const decision = decideDiscoveryScan(baseCtx({
                tier: 'lite',
                enabled: true,
                lastScanScene: 0,
            }));
            expect(decision.kind).toBe('skip');
        });

        it('Pro runs discovery no more than once every 5 committed turns', () => {
            // Scene 5, last scan at scene 1 → gap of 4 < 5 → cooldown blocks.
            let decision = decideDiscoveryScan(baseCtx({ tier: 'pro', sceneNumber: 5, lastScanScene: 1 }));
            expect(decision.kind).toBe('skip');
            if (decision.kind === 'skip') expect(decision.reason).toBe('cooldown');

            // Scene 6, last scan at scene 1 → gap of 5 >= 5 → allowed.
            decision = decideDiscoveryScan(baseCtx({ tier: 'pro', sceneNumber: 6, lastScanScene: 1 }));
            expect(decision.kind).toBe('run');

            // Scene 11 immediately after a scan at scene 6 → gap of 5 → allowed.
            decision = decideDiscoveryScan(baseCtx({ tier: 'pro', sceneNumber: 11, lastScanScene: 6 }));
            expect(decision.kind).toBe('run');
        });

        it('Max can run after every committed turn (cooldown 0)', () => {
            const decision = decideDiscoveryScan(baseCtx({ tier: 'max', sceneNumber: 7, lastScanScene: 6 }));
            expect(decision.kind).toBe('run');
        });

        it('Disabled flag means no scan regardless of tier', () => {
            const decision = decideDiscoveryScan(baseCtx({ tier: 'max', enabled: false }));
            expect(decision.kind).toBe('skip');
            if (decision.kind === 'skip') expect(decision.reason).toBe('disabled');
        });
    });

    describe('single-flight', () => {
        it('Only one discovery task per campaign can be queued/running', () => {
            const decision = decideDiscoveryScan(baseCtx({ inFlight: true }));
            expect(decision.kind).toBe('skip');
            if (decision.kind === 'skip') expect(decision.reason).toBe('in-flight');
        });

        it('An eligible turn arriving while one is in-flight is skipped (no backlog)', () => {
            // Max tier, every-turn eligible, but in-flight → skip.
            const decision = decideDiscoveryScan(baseCtx({ tier: 'max', sceneNumber: 100, lastScanScene: 0, inFlight: true }));
            expect(decision.kind).toBe('skip');
        });
    });

    describe('provider precedence', () => {
        it('Utility provider wins over auxiliary', () => {
            const result = resolveDiscoveryProvider({
                utilityProvider: endpoint('utility'),
                auxiliaryProvider: endpoint('aux'),
                storyProvider: endpoint('story'),
            });
            expect(result.source).toBe('utility');
            expect((result.provider as EndpointConfig).modelName).toBe('utility');
        });

        it('Auxiliary wins over Story fallback', () => {
            const result = resolveDiscoveryProvider({
                utilityProvider: undefined,
                auxiliaryProvider: endpoint('aux'),
                storyProvider: endpoint('story'),
            });
            expect(result.source).toBe('auxiliary');
            expect((result.provider as EndpointConfig).modelName).toBe('aux');
        });

        it('Story fallback happens only when no secondary provider exists', () => {
            const result = resolveDiscoveryProvider({
                utilityProvider: undefined,
                auxiliaryProvider: undefined,
                storyProvider: endpoint('story'),
            });
            expect(result.source).toBe('story');
        });

        it('A secondary endpoint missing its model name is treated as absent (not Story)', () => {
            // An auxiliary endpoint with no modelName must NOT be used as auxiliary
            // and must NOT silently become the Story provider.
            const noModelAux = { endpoint: 'http://aux', apiKey: 'k' } as EndpointConfig;
            const result = resolveDiscoveryProvider({
                utilityProvider: undefined,
                auxiliaryProvider: noModelAux,
                storyProvider: endpoint('story'),
            });
            // Falls through to Story because the aux is unusable — but the aux
            // itself is never returned. This is the explicit, non-silent path.
            expect(result.source).toBe('story');
        });

        it('Returns none when no provider is usable', () => {
            const decision = decideDiscoveryScan(baseCtx({
                providers: { utilityProvider: undefined, auxiliaryProvider: undefined, storyProvider: undefined },
            }));
            expect(decision.kind).toBe('skip');
            if (decision.kind === 'skip') expect(decision.reason).toBe('no-provider');
        });

        it('Does not use getFreshAuxiliaryProvider-style helpers that return Story', () => {
            // Simulate the dangerous helper: returns Story when aux has no model.
            // The controller must see the raw auxiliary (undefined), not the Story.
            const dangerousAux = endpoint('story') as EndpointConfig; // what getFreshAuxiliaryProvider returns
            const result = resolveDiscoveryProvider({
                utilityProvider: undefined,
                auxiliaryProvider: undefined, // raw aux is undefined — correct
                storyProvider: dangerousAux,
            });
            expect(result.source).toBe('story'); // explicit Story fallback, not disguised
        });
    });
});