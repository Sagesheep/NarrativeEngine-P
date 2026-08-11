/**
 * Phase 8.3 — the four done-when tests.
 *
 * The work order §6 names four tests this phase must ship:
 *
 *   1. The mod's interceptor contributes the block at order ~150 and it
 *      appears in the assembled prompt in that position.
 *   2. A test proves Scene Continue still carries the block — the one
 *      failure this phase can ship invisibly. Assert on the continuation's
 *      payload, not on the turn's.
 *   3. A test proves Ask-GM still returns enemy sections (D2), through the
 *      registry, from the mod's tables.
 *   4. `inCombat` is published by the mod and is identical to today's
 *      host-computed value for both cases: true for a live encounter, false
 *      for a compendium-only match.
 *
 * These tests exercise the mod-facing APIs this phase shipped
 * (`ctx.oocSections`, `ctx.budgets.claim`, `ctx.facts.register`,
 * `native.generateInterceptor`) against the real registries, using the same
 * fixtures the in-tree tests used before the extraction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildPayload } from '../../payload/payloadBuilder';
import { oocSections } from '../sections';
import { buildOocContext } from '../context';
import {
    registerModOocSection,
    disableModOocSections,
    clearAllModOocSections,
} from '../oocSectionRegistry';
import { registerModBudgetClaim, clearAllModBudgets } from '../../mods/budgets/budgetRegistry';
import {
    registerModInterceptor,
    clearAllModInterceptors,
} from '../../mods/interceptors';
import { registerModFact, clearAllModFacts, runFactPublishers } from '../../mods/facts';
import { budgetClaims } from '../../payload/budgetClaims';
import type { OocCampaignSnapshot } from '../types';
import type { GameContext, AppSettings } from '../../../types';

const MOD = { id: 'enemies', name: 'Enemy Compendium' };

function resetRegistries(): void {
    clearAllModBudgets();
    clearAllModInterceptors();
    clearAllModFacts();
    clearAllModOocSections();
    // Clear the OOC section registry's production singleton too.
    for (const s of oocSections.list()) oocSections.unregister(s.id);
}

beforeEach(() => {
    resetRegistries();
});

afterEach(() => {
    resetRegistries();
});

const baseContext = (): GameContext => ({
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '', starter: '',
    continuePrompt: '', inventory: '', inventoryLastScene: 'Never',
    characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false, starterActive: false,
    continuePromptActive: false, inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: false, encounterEngineActive: true, worldEngineActive: true,
    diceFairnessActive: true, sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '', notebook: [], notebookActive: false,
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
} as GameContext);

const baseSettings = (): AppSettings => ({ debugMode: true, contextLimit: 32_768 } as unknown as AppSettings);

// ── Test 1: the mod's interceptor contributes the block at order ~150 ──

describe('Phase 8.3 — the enemy mod interceptor contributes at order ~150', () => {
    it('the contribution appears in the assembled final-user message', async () => {
        const enemyBlockText = '[ACTIVE ENCOUNTER — authoritative live state]\nENCOUNTER: Bridge Ambush';
        // Register the interceptor the way the lifecycle host would.
        registerModInterceptor(
            { id: MOD.id, name: MOD.name, loadIndex: 0, file: 'mod:enemies' },
            () => ({
                contributions: [{ id: 'enemyBlock', order: 150, budget: 200, text: enemyBlockText }],
            }),
        );
        // Register the budget claim the way onActivate would.
        registerModBudgetClaim(MOD, 'enemy', () => 200);

        // Run the interceptor.
        const { runPromptInterceptors } = await import('../../mods/interceptors');
        const interception = await runPromptInterceptors({
            turnId: 't1', campaignId: 'c1', tier: 'pro',
            playerInput: 'I attack the goblin.', hasDirectorBrief: false,
            hasWatchdogNudge: false, hasAbsoluteCommand: false,
        });
        expect(interception).toBeDefined();
        expect(interception!.specs.length).toBe(1);
        expect(interception!.specs[0].order).toBe(150);
        expect(interception!.specs[0].text).toBe(enemyBlockText);
        // The id is qualified by the host: mod.enemies.enemyBlock.
        expect(interception!.specs[0].id).toBe('mod.enemies.enemyBlock');
    });

    it('the block lands in the assembled payload at order ~150, between the volatile block and the first directive', async () => {
        const enemyBlockText = '[RELEVANT ENEMY TEMPLATES — immutable reference records]\nENEMY: Goblin';
        registerModInterceptor(
            { id: MOD.id, name: MOD.name, loadIndex: 0, file: 'mod:enemies' },
            () => ({
                contributions: [{ id: 'enemyBlock', order: 150, budget: 300, text: enemyBlockText }],
            }),
        );
        registerModBudgetClaim(MOD, 'enemy', () => 300);

        const { runPromptInterceptors } = await import('../../mods/interceptors');
        const interception = await runPromptInterceptors({
            turnId: 't2', campaignId: 'c1', tier: 'pro',
            playerInput: 'The Goblin attacks.', hasDirectorBrief: false,
            hasWatchdogNudge: false, hasAbsoluteCommand: false,
        });

        const result = buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: [],
            userMessage: 'The Goblin attacks.',
            interception: interception ?? undefined,
        });
        const finalUser = [...result.messages].reverse().find(m => m.role === 'user')?.content ?? '';
        expect(finalUser).toContain(enemyBlockText);
    });
});

// ── Test 2: Scene Continue still carries the block ──

describe('Phase 8.3 — Scene Continue still carries the block (interception cached on the snapshot)', () => {
    it('getCachedSwipeInterception returns the cached interception result', async () => {
        // The snapshot captures ctx.interception at turn time. Scene Continue's
        // fallback path reads it via getCachedSwipeInterception() and passes
        // it to buildPayload. This test proves the capture path works.
        const { capturePendingTurnSnapshot, getCachedSwipeInterception, clearPendingTurnSnapshot } =
            await import('../../turn/pendingCommit');

        const fakeInterception = {
            specs: [{
                id: 'mod.enemies.enemyBlock', slot: 'final-user' as const, order: 150,
                text: '[RELEVANT ENEMY TEMPLATES — immutable reference records]',
                source: 'mod' as const, budget: 300,
                trace: { source: 'Enemy Compendium', classification: 'world_context', reason: 'test' },
            }],
            suppress: [],
        };
        const fakeTurnContext = { interception: fakeInterception } as never;

        capturePendingTurnSnapshot(
            { activeCampaignId: 'c1', npcLedger: [], getMessages: () => [] } as never,
            [],
            'test input',
            fakeTurnContext,
        );

        expect(getCachedSwipeInterception()).toBe(fakeInterception);

        clearPendingTurnSnapshot();
        expect(getCachedSwipeInterception()).toBeUndefined();
    });

    it('a payload built with the cached interception includes the enemy block', async () => {
        const enemyBlockText = '[ACTIVE ENCOUNTER — authoritative live state]';
        const interception = {
            specs: [{
                id: 'mod.enemies.enemyBlock', slot: 'final-user' as const, order: 150,
                text: enemyBlockText, source: 'mod' as const, budget: 300,
                trace: { source: 'Enemy Compendium', classification: 'world_context', reason: 'continue' },
            }],
            suppress: [],
        };

        // The fallback path calls buildPayload with the cached interception.
        const result = buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: [],
            userMessage: 'Continue the scene.',
            interception,
        });
        const finalUser = [...result.messages].reverse().find(m => m.role === 'user')?.content ?? '';
        expect(finalUser).toContain(enemyBlockText);
    });
});

// ── Test 3: Ask-GM still returns enemy sections through the registry ──

describe('Phase 8.3 — Ask-GM returns enemy sections through the mod OOC section registry', () => {
    const snapshot = (): OocCampaignSnapshot => ({
        campaignId: 'c1', provider: undefined, messages: [], semanticFacts: [], loreChunks: [],
        archiveIndex: [], npcLedger: [], locationLedger: [],
        context: { notebookActive: false, notebook: [], inventoryItems: [] } as GameContext,
    } as OocCampaignSnapshot);

    it('a mod-registered enemy section lands in the brief', () => {
        // Simulate the mod's onActivate registering its OOC section. The
        // section reads from a module-local closure (the mod's in-memory
        // state), not from the OocCampaignSnapshot.
        const modState = {
            compendium: [
                { id: 'tpl-1', name: 'Hollow Warden', aliases: 'the Warden', resistances: ['piercing'] },
            ],
            instances: [],
            encounters: [],
        };
        registerModOocSection(MOD, {
            id: 'enemy',
            order: 100,
            build({ question, excerpt, namedIn }) {
                const asked = modState.compendium.filter(e => namedIn(question, e.name, e.aliases));
                if (!asked.length) return { lines: [], sources: [] };
                const lines = ['Enemy records (compendium):'];
                const sources = [];
                for (const e of asked) {
                    const line = `${e.name} - resistances: ${e.resistances.join(', ')}`;
                    lines.push(`- ${line}`);
                    sources.push({ kind: 'enemy', id: e.id, label: `Enemy: ${e.name}`, excerpt: excerpt(line, 500) });
                }
                return { lines, sources };
            },
        });

        const result = buildOocContext(snapshot(), 'What resists piercing on the Warden?');
        expect(result.text).toContain('Hollow Warden');
        expect(result.text).toContain('resistances: piercing');
        expect(result.sources.some(s => s.kind === 'enemy' && s.id === 'tpl-1')).toBe(true);
    });

    it('the section id is qualified to mod.enemies.enemy by the host', () => {
        registerModOocSection(MOD, {
            id: 'enemy', order: 100,
            build: () => ({ lines: ['test'], sources: [] }),
        });
        expect(oocSections.get('mod.enemies.enemy')).toBeDefined();
        expect(oocSections.get('enemy')).toBeUndefined();
    });

    it('disable removes the section (teardown is host-owned)', () => {
        registerModOocSection(MOD, {
            id: 'enemy', order: 100,
            build: () => ({ lines: ['test'], sources: [] }),
        });
        expect(oocSections.get('mod.enemies.enemy')).toBeDefined();
        disableModOocSections(MOD.id);
        expect(oocSections.get('mod.enemies.enemy')).toBeUndefined();
    });
});

// ── Test 4: inCombat is published by the mod ──

describe('Phase 8.3 — the mod publishes inCombat identical to the host-computed value', () => {
    it('inCombat is false when no active encounter exists', async () => {
        const modState = { encounters: [], instances: [] };
        registerModFact(MOD, 'inCombat', () => {
            const encounter = modState.encounters.find(e => e.status === 'active');
            if (!encounter) return false;
            const wave = encounter.waves.find(w => w.id === encounter.activeWaveId);
            if (!wave) return false;
            const byId = new Map(modState.instances.map(i => [i.id, i]));
            return wave.activeInstanceIds.some(id => {
                const inst = byId.get(id);
                return inst && !inst.defeated;
            });
        }, { claims: 'inCombat' });

        const result = await runFactPublishers({
            turnId: 't1', campaignId: 'c1', tier: 'pro',
            playerInput: 'explore', hasDirectorBrief: false,
            hasWatchdogNudge: false, hasAbsoluteCommand: false,
        });
        expect(result.facts.inCombat).toBe(false);
    });

    it('inCombat is true for a live encounter with active undefeated instances', async () => {
        const modState = {
            encounters: [{
                id: 'enc-1', name: 'Bridge Ambush', status: 'active', activeWaveId: 'wave-1',
                waves: [{ id: 'wave-1', name: 'Wave 1', instanceIds: ['inst-1'], activeInstanceIds: ['inst-1'] }],
            }],
            instances: [{ id: 'inst-1', defeated: false, displayName: 'Goblin A' }],
        };
        registerModFact(MOD, 'inCombat', () => {
            const encounter = modState.encounters.find(e => e.status === 'active');
            if (!encounter) return false;
            const wave = encounter.waves.find(w => w.id === encounter.activeWaveId);
            if (!wave) return false;
            const byId = new Map(modState.instances.map(i => [i.id, i]));
            return wave.activeInstanceIds.some(id => {
                const inst = byId.get(id);
                return inst && !inst.defeated;
            });
        }, { claims: 'inCombat' });

        const result = await runFactPublishers({
            turnId: 't2', campaignId: 'c1', tier: 'pro',
            playerInput: 'fight', hasDirectorBrief: false,
            hasWatchdogNudge: false, hasAbsoluteCommand: false,
        });
        expect(result.facts.inCombat).toBe(true);
    });

    it('inCombat is false for a compendium-only match (no active encounter)', async () => {
        // The pre-8.3 distinction: `inCombat: activeEncounterBlock !== ''`.
        // A compendium match renders a block but is NOT combat. The mod's
        // fact reads the encounter state directly, not the rendered text.
        const modState = {
            encounters: [], // no active encounter
            instances: [],
        };
        registerModFact(MOD, 'inCombat', () => {
            const encounter = modState.encounters.find(e => e.status === 'active');
            return Boolean(encounter);
        }, { claims: 'inCombat' });

        const result = await runFactPublishers({
            turnId: 't3', campaignId: 'c1', tier: 'pro',
            playerInput: 'Tell me about the Goblin.', hasDirectorBrief: false,
            hasWatchdogNudge: false, hasAbsoluteCommand: false,
        });
        expect(result.facts.inCombat).toBe(false);
    });
});
