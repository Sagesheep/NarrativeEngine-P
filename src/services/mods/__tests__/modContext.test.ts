/**
 * Phase 2.3 — `buildModContext` tests.
 *
 * Proves the done-when criteria from the work order:
 *
 *   - A fixture native mod reads host state, performs a write, calls a model,
 *     and reads/writes its own table — all through `getContext()`, with zero
 *     imports from `src/`.
 *   - The `.d.ts` type-checks that fixture.
 *   - Version mismatch behaves as specified (the loader rejected it before
 *     any mod code ran; `ctx.api.version` equals the app version).
 *   - Existing sandboxed mods (Arc) are unaffected — verified by the unchanged
 *     sandbox-host and arc tests, plus the loader still accepts the arc
 *     manifest's own-table capabilities.
 *
 * The surface is exactly the one in `API.md` §3. No extra fields, no "while
 * we're here" additions. The test asserts the surface shape so a future
 * addition is a conscious decision, not an accident.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildHostFacade, type HostFacade } from '../../turn/hostFacade';
import { buildModContext, type ModContext } from '../modContext';
import { budgetClaims } from '../../payload/budgetClaims';
import type {
    AppSettings,
    EndpointConfig,
    TurnCallbacks,
    TurnState,
} from '../../../types';
import type { LocationEntry } from '../../../types';
import { APP_VERSION } from '../../../version';

const endpoint = (modelName: string): EndpointConfig => ({
    endpoint: `http://${modelName}`,
    apiKey: `${modelName}-secret`,
    modelName,
});

const makeState = (activeCampaignId = 'campaign-a'): TurnState => ({
    input: 'I draw my sword and advance.',
    displayInput: 'I draw my sword and advance.',
    settings: {
        contextLimit: 8192,
        aiTier: 'max',
        archiveRecallDepth: 'deep',
        autoArchiveStaleNPCsTurns: 12,
        divergenceScanBudget: 2048,
        enableArchivePlanner: true,
        lodElevateScenes: 3,
        lodImportanceBonus: 4,
        lodSlottedMaxPerScene: 5,
        lodSummaryChapters: 8,
        apiKey: 'legacy-secret',
        providers: [{ apiKey: 'provider-secret' }],
    } as unknown as AppSettings,
    context: {
        currentPlaceId: 'place-a',
        currentFeature: 'training-yard',
        playerCharacter: { id: 'pc-1', name: 'Hero' },
        characterProfileData: { name: 'Hero', hp: 10, stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } },
        inventoryItems: [{ id: 'i-1', name: 'Sword', category: 'weapon', quantity: 1 }],
    } as unknown as TurnState['context'],
    messages: [
        { id: 'm1', role: 'user', content: 'hello' },
        { id: 'm2', role: 'assistant', content: 'The guard eyes you warily.' },
    ],
    condenser: { condensedUpToIndex: 0 } as TurnState['condenser'],
    loreChunks: [{ id: 'l1', header: 'Lore', content: 'text' }],
    npcLedger: [{ id: 'n1', name: 'Nadia' }],
    enemyCompendium: [{ id: 'e1', name: 'Goblin' }],
    enemyCombatConfig: { enemyDiscoveryEnabled: true } as TurnState['enemyCombatConfig'],
    archiveIndex: [{ sceneId: '001', summary: 'scene' }],
    activeCampaignId,
    provider: endpoint('story'),
    getMessages: () => [],
    getFreshProvider: () => endpoint('story'),
    getUtilityEndpoint: () => endpoint('utility'),
    getFreshAuxiliaryProvider: () => endpoint('auxiliary'),
    getRawAuxiliaryProvider: () => endpoint('raw-auxiliary'),
    getRawSummariserProvider: () => endpoint('raw-summariser'),
    onStageNpcIds: ['n1'],
    timeline: [{ sceneId: '001', summary: 'event' }],
    chapters: [],
    pinnedChapterIds: [],
    clearPinnedChapters: vi.fn(),
    setChapters: vi.fn(),
    incrementBookkeepingTurnCounter: vi.fn(() => 1),
    resetBookkeepingTurnCounter: vi.fn(),
    autoBookkeepingInterval: 5,
    getFreshContext: () => ({ currentPlaceId: 'place-a' } as TurnState['context']),
    divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
    semanticFacts: [{ id: 'f1', fact: 'fact' }],
});

const makeCallbacks = (): TurnCallbacks => ({
    onCheckingNotes: vi.fn(),
    addMessage: vi.fn(),
    updateLastAssistant: vi.fn(),
    updateLastMessage: vi.fn(),
    updateLastAssistantMessage: vi.fn(),
    updateContext: vi.fn(),
    getFreshLocationState: vi.fn(() => ({
        activeCampaignId: 'campaign-a',
        locationLedger: [{ id: 'place-a', name: 'Academy', broadLocation: 'Konoha', features: ['training-yard'], firstSeenScene: '001', lastSeenScene: '001', source: 'llm' as const }],
        context: {} as TurnState['context'],
    })),
    setCharacterProfileData: vi.fn(),
    setInventoryItems: vi.fn(),
    setLocationLedger: vi.fn(),
    addLocationSuggestions: vi.fn(),
    setArchiveIndex: vi.fn(),
    updateNPC: vi.fn(),
    addNPC: vi.fn(),
    setCondensed: vi.fn(),
    setStreaming: vi.fn(),
    archiveNPC: vi.fn(),
    restoreNPC: vi.fn(),
});

function makeFacade(state: TurnState = makeState(), callbacks: TurnCallbacks = makeCallbacks()): HostFacade {
    return buildHostFacade(state, callbacks);
}

function visit(value: unknown, path: string, onValue: (value: unknown, path: string) => void): void {
    onValue(value, path);
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, onValue);
}

function expectDeeplyFrozen(value: unknown): void {
    visit(value, '$', (child) => {
        if (child !== null && typeof child === 'object') {
            expect(Object.isFrozen(child)).toBe(true);
        }
    });
}

describe('Phase 2.3 — buildModContext', () => {
    describe('surface shape', () => {
        it('enumerates the stable top-level ModContext surface', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(Object.keys(ctx).sort()).toEqual(
                ['api', 'budgets', 'config', 'data', 'events', 'facts', 'log', 'macros', 'mod', 'model', 'mounts', 'refresh', 'roles', 'signal', 'subscribe', 'table', 'tokens', 'write'].sort(),
            );
        });

        it('enumerates the stable ModData fields', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(Object.keys(ctx.data).sort()).toEqual(
                ['archiveIndex', 'campaignId', 'chapters', 'characterSheet', 'divergenceRegister', 'inventory', 'location', 'loreChunks', 'messages', 'npcLedger', 'onStageNpcIds', 'playerCharacter', 'playerInput', 'timeline'].sort(),
            );
        });

        it('enumerates the stable ModWrites fields (the twelve carried over)', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(Object.keys(ctx.write).sort()).toEqual(
                ['addLocationSuggestions', 'addMessage', 'addNpcSuggestions', 'archiveNPC', 'restoreNPC', 'setCharacterSheet', 'setDivergenceRegister', 'setInventory', 'setLocationLedger', 'updateContext', 'updateNPC', 'updatePlayerCharacter'].sort(),
            );
        });

        it('does not expose the two absent writes (addEnemySuggestions, onDirectorBriefPhase)', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect((ctx.write as Record<string, unknown>).addEnemySuggestions).toBeUndefined();
            expect((ctx.write as Record<string, unknown>).onDirectorBriefPhase).toBeUndefined();
        });
    });

    describe('identity and version', () => {
        it('ctx.mod carries the mod identity without folder', () => {
            const ctx = buildModContext({
                mod: { id: 'arc', name: 'Arc Engine', version: '1.2.3' },
                facade: makeFacade(),
            });
            expect(ctx.mod).toEqual({ id: 'arc', name: 'Arc Engine', version: '1.2.3' });
            expect((ctx.mod as Record<string, unknown>).folder).toBeUndefined();
        });

        it('ctx.api.version equals the app version', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(ctx.api.version).toBe(APP_VERSION);
        });

        it('ctx.api.commitPoint defaults to "immediate" for native hooks', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(ctx.api.commitPoint).toBe('immediate');
        });

        it('ctx.api.commitPoint is "on-return" for sandboxed compute', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
                commitPoint: 'on-return',
            });
            expect(ctx.api.commitPoint).toBe('on-return');
        });
    });

    describe('reads — frozen and named', () => {
        it('deeply freezes data so a mod cannot mutate host state by writing to a read', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expectDeeplyFrozen(ctx.data);
        });

        it('renames activeCampaignId → campaignId and input → playerInput', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(ctx.data.campaignId).toBe('campaign-a');
            expect(ctx.data.playerInput).toBe('I draw my sword and advance.');
        });

        it('promotes context.playerCharacter, characterProfileData, and inventoryItems to named entries', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(ctx.data.playerCharacter).toEqual({ id: 'pc-1', name: 'Hero' });
            expect(ctx.data.characterSheet.name).toBe('Hero');
            expect(ctx.data.inventory).toHaveLength(1);
            expect(ctx.data.inventory[0].name).toBe('Sword');
        });

        it('does not expose the raw GameContext blob (data.context is absent)', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect((ctx.data as Record<string, unknown>).context).toBeUndefined();
        });

        it('does not expose enemyCompendium or enemyCombatConfig (Phase 8 deletes them)', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect((ctx.data as Record<string, unknown>).enemyCompendium).toBeUndefined();
            expect((ctx.data as Record<string, unknown>).enemyCombatConfig).toBeUndefined();
        });

        it('does not expose condenser or semanticFacts (no measured consumer)', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect((ctx.data as Record<string, unknown>).condenser).toBeUndefined();
            expect((ctx.data as Record<string, unknown>).semanticFacts).toBeUndefined();
        });
    });

    describe('data.location — the derived entry', () => {
        it('populates location from the locationState option when supplied', () => {
            const ledger: LocationEntry[] = [
                { id: 'place-a', name: 'Academy', broadLocation: 'Konoha', features: ['yard'], firstSeenScene: '001', lastSeenScene: '001', source: 'llm' },
            ];
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
                locationState: { currentPlaceId: 'place-a', currentFeature: 'yard', ledger },
            });
            expect(ctx.data.location.currentPlaceId).toBe('place-a');
            expect(ctx.data.location.currentFeature).toBe('yard');
            expect(ctx.data.location.ledger).toHaveLength(1);
            expect(ctx.data.location.ledger[0].id).toBe('place-a');
        });

        it('falls back to context.currentPlaceId / currentFeature when no locationState is supplied', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(ctx.data.location.currentPlaceId).toBe('place-a');
            expect(ctx.data.location.currentFeature).toBe('training-yard');
            expect(ctx.data.location.ledger).toEqual([]);
        });

        it('returns nulls when neither locationState nor context has a current place', () => {
            const state = makeState();
            state.context = {} as TurnState['context'];
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(state),
            });
            expect(ctx.data.location.currentPlaceId).toBeNull();
            expect(ctx.data.location.currentFeature).toBeNull();
        });

        it('freezes the location entry and the ledger array', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
                locationState: {
                    currentPlaceId: 'place-a',
                    currentFeature: 'yard',
                    ledger: [{ id: 'place-a', name: 'Academy', broadLocation: 'Konoha', features: ['yard'], firstSeenScene: '001', lastSeenScene: '001', source: 'llm' }],
                },
            });
            expect(Object.isFrozen(ctx.data.location)).toBe(true);
            expect(Object.isFrozen(ctx.data.location.ledger)).toBe(true);
        });
    });

    describe('writes — same callbacks the app uses', () => {
        it('routes setCharacterSheet to the facade setCharacterProfileData callback', () => {
            const callbacks = makeCallbacks();
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(makeState(), callbacks),
            });
            const profile = { name: 'Hero', hp: 12, stats: { str: 11, dex: 10, con: 10, int: 10, wis: 10, cha: 10 } };
            ctx.write.setCharacterSheet(profile);
            expect(callbacks.setCharacterProfileData).toHaveBeenCalledWith(profile);
        });

        it('routes setInventory to the facade setInventoryItems callback', () => {
            const callbacks = makeCallbacks();
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(makeState(), callbacks),
            });
            const items = [{ id: 'i-2', name: 'Bow', category: 'weapon', quantity: 1 }];
            ctx.write.setInventory(items);
            expect(callbacks.setInventoryItems).toHaveBeenCalledWith(items);
        });

        it('routes updateContext / addMessage / updateNPC through to the callbacks', () => {
            const callbacks = makeCallbacks();
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(makeState(), callbacks),
            });
            ctx.write.updateContext({ arcDigest: 'test' });
            ctx.write.addMessage({ id: 'x', role: 'system', content: 'c' });
            ctx.write.updateNPC('n1', { name: 'Nadia Updated' });
            expect(callbacks.updateContext).toHaveBeenCalledWith({ arcDigest: 'test' });
            expect(callbacks.addMessage).toHaveBeenCalled();
            expect(callbacks.updateNPC).toHaveBeenCalledWith('n1', { name: 'Nadia Updated' });
        });

        it('writes are synchronous and void (no promise)', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            const result = ctx.write.addNpcSuggestions(['probe']);
            expect(result).toBeUndefined();
        });
    });

    describe('model — brokered, no credentials', () => {
        it('does not expose any endpoint or apiKey on the context surface', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            const credentialPaths: string[] = [];
            visit(ctx, '$', (value, path) => {
                if (typeof value === 'string' && /apiKey|secret|bearer|authorization/i.test(value)) {
                    credentialPaths.push(path);
                }
                if (path.toLowerCase().includes('apikey') || path.toLowerCase().includes('endpoint')) {
                    credentialPaths.push(path);
                }
            });
            expect(credentialPaths).toEqual([]);
        });

        it('reports role availability through the facade', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(ctx.model.available('utility')).toBe(true);
            expect(ctx.model.available('story')).toBe(true);
        });

        it('brokers a model call through the facade without returning an endpoint', async () => {
            const state = makeState();
            const callbacks = makeCallbacks();
            const facade = buildHostFacade(state, callbacks, {
                modelCall: async (_role, request) => ({ content: request.prompt.toUpperCase() }),
            });
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade,
            });
            const response = await ctx.model.call('utility', { prompt: 'hello' });
            expect(response.content).toBe('HELLO');
        });
    });

    describe('table — per-mod namespacing', () => {
        it('accepts the bare declared name and resolves it to the namespaced name', async () => {
            const tableRead = vi.fn(async () => []);
            const facade = makeFacade();
            const ctx = buildModContext({
                mod: { id: 'arc', name: 'Arc', version: '1.0.0' },
                facade: { ...facade, table: { read: tableRead, write: vi.fn(async () => undefined) } },
            });
            await ctx.table.read('arcs');
            expect(tableRead).toHaveBeenCalledWith('mod.arc.arcs');
        });

        it('accepts the fully-qualified own name as an alias for the bare name', async () => {
            const tableRead = vi.fn(async () => []);
            const facade = makeFacade();
            const ctx = buildModContext({
                mod: { id: 'arc', name: 'Arc', version: '1.0.0' },
                facade: { ...facade, table: { read: tableRead, write: vi.fn(async () => undefined) } },
            });
            await ctx.table.read('mod.arc.arcs');
            expect(tableRead).toHaveBeenCalledWith('mod.arc.arcs');
        });

        it('rejects a cross-mod table name with a mod-named error', () => {
            const facade = makeFacade();
            const ctx = buildModContext({
                mod: { id: 'arc', name: 'Arc', version: '1.0.0' },
                facade,
            });
            expect(() => ctx.table.read('mod.other.arcs')).toThrow(
                /\[mod:arc\] a mod may not reach another mod's tables \("mod\.other\.arcs"\)/,
            );
        });

        it('rejects an empty table name', () => {
            const facade = makeFacade();
            const ctx = buildModContext({
                mod: { id: 'arc', name: 'Arc', version: '1.0.0' },
                facade,
            });
            expect(() => ctx.table.read('')).toThrow(/\[mod:arc\] table name must be a non-empty string/);
        });

        it('table.write is Promise-returning (async normalisation)', async () => {
            const tableWrite = vi.fn(async () => undefined);
            const facade = makeFacade();
            const ctx = buildModContext({
                mod: { id: 'arc', name: 'Arc', version: '1.0.0' },
                facade: { ...facade, table: { read: vi.fn(async () => []), write: tableWrite } },
            });
            const result = ctx.table.write('arcs', [{ id: 'a1' }]);
            await expect(result).resolves.toBeUndefined();
            expect(tableWrite).toHaveBeenCalledWith('mod.arc.arcs', [{ id: 'a1' }]);
        });

        it('table.subscribe throws with a Phase 2.4 pointer (declared here, implemented there)', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(() => ctx.table.subscribe('arcs', () => {})).toThrow(
                /\[mod:m\] table\.subscribe is implemented in Phase 2\.4/,
            );
        });
    });

    describe('subscribe and refresh', () => {
        it('ctx.subscribe throws with a Phase 2.4 pointer (declared here, implemented there)', () => {
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade: makeFacade(),
            });
            expect(() => ctx.subscribe('npcLedger', () => {})).toThrow(
                /\[mod:m\] ctx\.subscribe is implemented in Phase 2\.4/,
            );
        });

        it('refresh returns a fresh ModContext (full object, not a snapshot)', async () => {
            let current = makeState('campaign-a');
            const facade = buildHostFacade(current, makeCallbacks(), { getState: () => current });
            const ctx = buildModContext({
                mod: { id: 'm', name: 'M', version: '1.0.0' },
                facade,
            });
            current = makeState('campaign-b');
            const refreshed = await ctx.refresh();
            expect(refreshed).not.toBe(ctx);
            expect(refreshed.data.campaignId).toBe('campaign-b');
            expect(ctx.data.campaignId).toBe('campaign-a');
        });

        it('refresh preserves the mod identity and commitPoint', async () => {
            const facade = makeFacade();
            const ctx = buildModContext({
                mod: { id: 'arc', name: 'Arc', version: '1.0.0' },
                facade,
                commitPoint: 'on-return',
            });
            const refreshed = await ctx.refresh();
            expect(refreshed.mod).toEqual({ id: 'arc', name: 'Arc', version: '1.0.0' });
            expect(refreshed.api.commitPoint).toBe('on-return');
        });
    });

    describe('log', () => {
        it('prefixes log calls with the mod id', () => {
            const log = vi.fn();
            const facade = makeFacade();
            const ctx = buildModContext({
                mod: { id: 'arc', name: 'Arc', version: '1.0.0' },
                facade: { ...facade, log },
            });
            ctx.log('hello', 42);
            expect(log).toHaveBeenCalledWith('[mod:arc]', 'hello', 42);
        });
    });

    describe('the fixture native mod — the full surface exercised end-to-end', () => {
        // The fixture mod (`mods/example-surface-mod/index.js`) is imported
        // directly and its `onActivate` is called with a constructed
        // `ModContext`. This proves the done-when: a native mod reads host
        // state, performs a write, calls a model, and reads/writes its own
        // table — all through `getContext()`, with zero imports from `src/`.
        //
        // The fixture lives on disk so the loader's `shippedModsLoad` test
        // also accepts it, and so an author can read it as an example. The
        // test here exercises it end-to-end against a real `ModContext`.

        it('reads, writes, calls a model, and reads/writes its own table through the ModContext', async () => {
            const { exerciseSurface } = await import('../../../../mods/example-surface-mod/index.js');

            const tableRows: unknown[] = [];
            const modelCall = vi.fn(async () => ({ content: 'OK' }));
            const addNpcSuggestions = vi.fn();
            const facade = makeFacade();
            const ctx: ModContext = buildModContext({
                mod: { id: 'example-surface-mod', name: 'Example Surface Mod', version: '1.0.0' },
                facade: {
                    ...facade,
                    model: {
                        call: modelCall,
                        callJson: vi.fn(),
                        available: vi.fn(() => true),
                    },
                    table: {
                        read: async () => [...tableRows],
                        write: async (_name, rows) => {
                            tableRows.length = 0;
                            tableRows.push(...(rows as unknown[]));
                        },
                    },
                    write: { ...facade.write, addNpcSuggestions },
                },
            });

            exerciseSurface(ctx);

            // Read happened (no throw). Write happened.
            expect(addNpcSuggestions).toHaveBeenCalledWith(['surface-mod-probe'], 'Phase 2.3 fixture exercise');

            // Await the async table + model exercises (kicked off fire-and-forget).
            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(tableRows.length).toBe(1);
            expect(tableRows[0]).toMatchObject({ campaignId: 'campaign-a' });
            expect(modelCall).toHaveBeenCalledTimes(1);
            expect(modelCall).toHaveBeenCalledWith(
                'utility',
                expect.objectContaining({ prompt: 'Reply with the single word: OK' }),
            );
        });

        it('onActivate guards against undefined ctx (no-campaign load cycle)', async () => {
            const { onActivate } = await import('../../../../mods/example-surface-mod/index.js');
            expect(() => onActivate(undefined)).not.toThrow();
        });
    });
});

describe('Phase 7.4 — ctx.tokens and ctx.budgets', () => {
    it('ctx.tokens.count returns the same count as the host tokenizer', () => {
        const ctx = buildModContext({
            mod: { id: 'm', name: 'M', version: '1.0.0' },
            facade: makeFacade(),
        });
        expect(typeof ctx.tokens.count).toBe('function');
        expect(ctx.tokens.count('Hello world')).toBeGreaterThan(0);
        expect(ctx.tokens.count('')).toBe(0);
        // The tokenizer is pure and deterministic — same input, same count.
        expect(ctx.tokens.count('Hello world')).toBe(ctx.tokens.count('Hello world'));
    });

    it('ctx.tokens is frozen', () => {
        const ctx = buildModContext({
            mod: { id: 'm', name: 'M', version: '1.0.0' },
            facade: makeFacade(),
        });
        expect(Object.isFrozen(ctx.tokens)).toBe(true);
    });

    it('ctx.budgets.claim is a function', () => {
        const ctx = buildModContext({
            mod: { id: 'm', name: 'M', version: '1.0.0' },
            facade: makeFacade(),
        });
        expect(typeof ctx.budgets.claim).toBe('function');
    });

    it('ctx.budgets is frozen', () => {
        const ctx = buildModContext({
            mod: { id: 'm', name: 'M', version: '1.0.0' },
            facade: makeFacade(),
        });
        expect(Object.isFrozen(ctx.budgets)).toBe(true);
    });

    it('ctx.budgets.claim registers a budget and the unregister removes it', () => {
        const ctx = buildModContext({
            mod: { id: 'claim-test', name: 'Claim Test', version: '1.0.0' },
            facade: makeFacade(),
        });
        const unregister = ctx.budgets.claim('myBudget', () => 150);
        const map = budgetClaims.compute(10_000, undefined, false);
        expect(map.get('mod.claim-test.myBudget')).toBe(150);
        unregister();
        const mapAfter = budgetClaims.compute(10_000, undefined, false);
        expect(mapAfter.get('mod.claim-test.myBudget')).toBe(0);
    });
});
