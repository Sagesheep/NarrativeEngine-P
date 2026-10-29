/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import type { ArchiveChapter, ArchiveIndexEntry, NPCEntry } from '../../../types';
import type { TurnState } from '../../turn/turnOrchestrator';
import {
    buildSlottedRagSnippets,
    gatherSlottedRag,
    renderSlottedRagBlock,
    type SlottedRagSnippet,
} from '../slottedRag';

function mkChapter(over: Partial<ArchiveChapter> & { chapterId: string }): ArchiveChapter {
    return {
        title: `Chapter ${over.chapterId}`,
        sceneRange: [over.chapterId.replace('CH', '').padStart(3, '0'), over.chapterId.replace('CH', '').padStart(3, '0')],
        sceneIds: [over.chapterId.replace('CH', '').padStart(3, '0')],
        summary: `Summary of ${over.chapterId}.`,
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 1,
        sealedAt: 1,
        ...over,
    } as ArchiveChapter;
}

function mkIndexEntry(sceneId: string, over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry {
    return {
        sceneId,
        timestamp: 0,
        keywords: [],
        npcsMentioned: [],
        witnesses: [],
        userSnippet: '',
        ...over,
    } as ArchiveIndexEntry;
}

function mkNpc(id: string, name: string, archived = false): NPCEntry {
    return { id, name, aliases: '', archived, affinity: 50 } as unknown as NPCEntry;
}

function makeState(overrides: Partial<TurnState> = {}): TurnState {
    return {
        input: 'remember the battle',
        displayInput: 'remember the battle',
        settings: {
            aiTier: 'max',
            lodSummaryChapters: 7,
            lodImportanceBonus: 2,
            lodElevateScenes: 2,
            lodSlottedMaxPerScene: 2,
        } as any,
        context: {} as any,
        messages: [],
        condenser: { condensedUpToIndex: -1 },
        loreChunks: [],
        npcLedger: [mkNpc('npc_a', 'Aldric')],
        archiveIndex: [],
        activeCampaignId: 'c1',
        provider: undefined,
        getMessages: () => [],
        getFreshProvider: () => undefined,
        chapters: [],
        pinnedChapterIds: [],
        clearPinnedChapters: vi.fn(),
        setChapters: vi.fn(),
        incrementBookkeepingTurnCounter: vi.fn().mockReturnValue(1),
        resetBookkeepingTurnCounter: vi.fn(),
        autoBookkeepingInterval: 5,
        getFreshContext: () => ({}) as any,
        ...overrides,
    } as any as TurnState;
}

describe('WO-12 / WO-12b — Slotted RAG', () => {
    describe('buildSlottedRagSnippets — elevated exclusion + caps', () => {
        it('excludes elevated scenes (only non-elevated hits contribute snippets)', () => {
            const chapters = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
                mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
            ];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'User snippet for 001.' }),
                mkIndexEntry('002', { userSnippet: 'User snippet for 002.' }),
                mkIndexEntry('004', { userSnippet: 'User snippet for 004.' }),
                mkIndexEntry('005', { userSnippet: 'User snippet for 005.' }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['004', '002', '001', '005'],
                elevatedSceneIds: new Set(['004', '002']), // WO-11 elevated these
                archiveIndex,
                chapters,
                npcLedger: [mkNpc('npc_a', 'Aldric')],
                onStageNpcIds: ['npc_a'],
            });

            const ids = result.snippets.map(s => s.sceneId);
            expect(ids).not.toContain('004');
            expect(ids).not.toContain('002');
            expect(ids).toContain('001');
            expect(ids).toContain('005');
        });

        it('caps at 4 scenes total', () => {
            const chapters = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '010'], sceneIds: ['001', '002', '003', '004', '005', '006', '007', '008'] }),
            ];
            const archiveIndex = ['001', '002', '003', '004', '005', '006', '007', '008'].map(s =>
                mkIndexEntry(s, { userSnippet: `Snippet ${s}.` }),
            );

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001', '002', '003', '004', '005', '006', '007', '008'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            const distinctScenes = new Set(result.snippets.map(s => s.sceneId));
            expect(distinctScenes.size).toBe(4);
        });

        it('caps long snippets at ~200 chars', () => {
            const chapters = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '001'], sceneIds: ['001'] }),
            ];
            const longSnippet = 'x'.repeat(500);
            const archiveIndex = [mkIndexEntry('001', { userSnippet: longSnippet })];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].snippet.length).toBe(200);
        });

        it('skips scenes not in the archive index', () => {
            const chapters = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
            ];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'Has snippet.' }),
                // 002 is missing from the index
                mkIndexEntry('003', { userSnippet: 'Also has snippet.' }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001', '002', '003'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            const ids = result.snippets.map(s => s.sceneId);
            expect(ids).not.toContain('002');
        });

        it('respects rankedSceneIds order (best-first) — fills the 4-scene cap from the front', () => {
            const chapters = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '010'], sceneIds: ['001', '002', '003', '004', '005', '006', '007', '008'] }),
            ];
            const archiveIndex = ['001', '002', '003', '004', '005', '006', '007', '008'].map(s =>
                mkIndexEntry(s, { userSnippet: `Snippet ${s}.` }),
            );

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['008', '007', '006', '005', '004', '003', '002', '001'], // best-first reversed
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            const ids = result.snippets.map(s => s.sceneId);
            expect(ids).toEqual(['008', '007', '006', '005']); // front 4, in ranked order
        });

        it('empty rankedSceneIds → no snippets', () => {
            const result = buildSlottedRagSnippets({
                rankedSceneIds: [],
                elevatedSceneIds: new Set(),
                archiveIndex: [],
                chapters: [],
                npcLedger: [],
                onStageNpcIds: [],
            });
            expect(result.snippets).toEqual([]);
        });

        it('maxScenes = 0 → no snippets', () => {
            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex: [mkIndexEntry('001', { userSnippet: 'x' })],
                chapters: [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })],
                npcLedger: [],
                onStageNpcIds: [],
                maxScenes: 0,
            });
            expect(result.snippets).toEqual([]);
        });

        it('all ranked scenes elevated → no snippets (every hit was elevated)', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [mkIndexEntry('001', { userSnippet: 'x' })];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(['001']),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            expect(result.snippets).toEqual([]);
        });

        it('attaches the correct chapterId via the scene→chapter map', () => {
            const chapters = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
                mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
            ];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'one' }),
                mkIndexEntry('004', { userSnippet: 'four' }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001', '004'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            const byId = new Map(result.snippets.map(s => [s.sceneId, s]));
            expect(byId.get('001')?.chapterId).toBe('CH01');
            expect(byId.get('004')?.chapterId).toBe('CH02');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // WO-12b Correction 1 — strict on-stage witness authorization.
    //
    // The authorization set is `onStageNpcIds` ONLY. A non-archived but
    // off-stage NPC in the ledger does NOT authorize a flash. `witnessedBy`
    // carries only the matching on-stage witness names, in archive entry
    // witness order.
    // ─────────────────────────────────────────────────────────────────────────
    describe('buildSlottedRagSnippets — WO-12b Correction 1: strict on-stage witness authorization', () => {
        it('a non-archived off-stage NPC in the ledger is the only witness → scene is DROPPED', () => {
            // The off-stage NPC is present in the ledger, non-archived, and is
            // the scene's only witness. Under the WO-12 bug, the non-archived
            // ledger NPC would authorize the flash. Under WO-12b, only
            // `onStageNpcIds` authorizes — and the off-stage NPC is NOT in it.
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'Off-stage only.', witnesses: ['npc_offstage'] }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [mkNpc('npc_offstage', 'Offstage', /* archived = */ false)],
                onStageNpcIds: ['npc_a'], // npc_offstage is NOT on stage
            });

            expect(result.snippets).toEqual([]);
        });

        it('the same NPC ID added to onStageNpcIds makes the scene PASS', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'Now on-stage.', witnesses: ['npc_offstage'] }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [mkNpc('npc_offstage', 'Offstage', false)],
                onStageNpcIds: ['npc_offstage'], // now on stage — authorizes
            });

            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].sceneId).toBe('001');
            expect(result.snippets[0].witnessedBy).toEqual(['Offstage']);
        });

        it('with no on-stage NPCs, a witnessed scene is dropped and a broadcast scene passes', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001', '002'] })];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'Witnessed.', witnesses: ['npc_x'] }),
                mkIndexEntry('002', { userSnippet: 'Broadcast.', witnesses: [] }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001', '002'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [mkNpc('npc_x', 'Xavier', false)],
                onStageNpcIds: [], // no one on stage
            });

            const ids = result.snippets.map(s => s.sceneId);
            expect(ids).not.toContain('001'); // witnessed, no on-stage NPC — dropped
            expect(ids).toContain('002');     // broadcast — passes
        });

        it('mixed on-stage/off-stage witnesses: scene passes, witnessedBy contains ONLY on-stage names in archive entry order', () => {
            // Archive entry lists [npc_offstageA, npc_a, npc_offstageB, npc_b].
            // Only npc_a and npc_b are on stage. witnessedBy must be
            // ['Aldric', 'Bram'] — in archive entry order (npc_a before npc_b),
            // excluding the off-stage witnesses.
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [
                mkIndexEntry('001', {
                    userSnippet: 'Mixed.',
                    witnesses: ['npc_offstageA', 'npc_a', 'npc_offstageB', 'npc_b'],
                }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [
                    mkNpc('npc_offstageA', 'OffA', false),
                    mkNpc('npc_a', 'Aldric', false),
                    mkNpc('npc_offstageB', 'OffB', false),
                    mkNpc('npc_b', 'Bram', false),
                ],
                onStageNpcIds: ['npc_a', 'npc_b'],
            });

            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].witnessedBy).toEqual(['Aldric', 'Bram']);
        });

        it('broadcast scene (no witnesses) passes and is labeled "all"', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [mkIndexEntry('001', { userSnippet: 'x', witnesses: [] })];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            expect(result.snippets[0].witnessedBy).toBe('all');
        });

        it('witness filter is not applied when no scene in the index carries witness data', () => {
            const chapters = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
            ];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'one', witnesses: [] }),
                mkIndexEntry('002', { userSnippet: 'two', witnesses: [] }),
                mkIndexEntry('003', { userSnippet: 'three', witnesses: [] }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001', '002', '003'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            expect(result.snippets.map(s => s.sceneId)).toEqual(['001', '002', '003']);
        });

        it('archived on-stage NPC: still authorizes if its ID is in onStageNpcIds (ledger archived flag is irrelevant to authorization)', () => {
            // WO-12b: authorization is purely onStageNpcIds — the ledger's
            // archived flag is NOT consulted. This pins that the archived flag
            // on the ledger entry does not strip authorization from an
            // on-stage ID. (If a future WO wants archived IDs auto-stripped
            // from onStageNpcIds, that is an upstream call-site change, not
            // a slottedRag change.)
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'Witnessed by archived-on-stage.', witnesses: ['npc_arch'] }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [mkNpc('npc_arch', 'Archie', /* archived = */ true)],
                onStageNpcIds: ['npc_arch'], // archived but still on stage
            });

            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].witnessedBy).toEqual(['Archie']);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // WO-12b Correction 2 — verbatim index snippets only.
        it('witnesses stored as names resolve to on-stage NPCs, and the label uses ledger names', () => {
            // Real archives store witness names ("Rin"), never ledger ids.
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001', '002'] })];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'Rin was there.', witnesses: ['Rin', 'Grey'] }),
                mkIndexEntry('002', { userSnippet: 'Only Grey saw it.', witnesses: ['Grey'] }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001', '002'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [mkNpc('npc_rin', 'Rin Holmes'), mkNpc('npc_grey', 'Grey Holmes')],
                onStageNpcIds: ['npc_rin'],
            });

            expect(result.snippets).toEqual([
                { sceneId: '001', chapterId: 'CH01', snippet: 'Rin was there.', witnessedBy: ['Rin Holmes'] },
            ]);
        });

    //
    // The sole snippet candidate is trimmed `ArchiveIndexEntry.userSnippet`
    // (capped at 200 chars). `SceneEvent.text` and other extracted/generated
    // metadata are NOT authorized snippet sources. Blank `userSnippet` → skip.
    // Under the current archive-index schema, at most one snippet line per
    // scene is emitted. `maxPerScene` is kept as an off switch and for forward
    // compatibility.
    // ─────────────────────────────────────────────────────────────────────────
    describe('buildSlottedRagSnippets — WO-12b Correction 2: verbatim userSnippet only', () => {
        it('userSnippet plus events emits exactly the userSnippet line and NEVER event text', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [
                mkIndexEntry('001', {
                    userSnippet: 'User snippet.',
                    events: [
                        { eventType: 'combat', importance: 9, text: 'A mighty clash.' },
                        { eventType: 'discovery', importance: 7, text: 'A hidden cache.' },
                    ],
                }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
                maxPerScene: 2,
            });

            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].snippet).toBe('User snippet.');
            // Event text must NOT appear as a snippet line.
            const snippetTexts = result.snippets.map(s => s.snippet);
            expect(snippetTexts).not.toContain('A mighty clash.');
            expect(snippetTexts).not.toContain('A hidden cache.');
        });

        it('blank userSnippet plus events emits NO snippet (events are not an authorized source)', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [
                mkIndexEntry('001', {
                    userSnippet: '',
                    events: [
                        { eventType: 'combat', importance: 9, text: 'A mighty clash.' },
                        { eventType: 'discovery', importance: 7, text: 'A hidden cache.' },
                    ],
                }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
                maxPerScene: 2,
            });

            expect(result.snippets).toEqual([]);
        });

        it('maxPerScene: 0 emits none (off switch)', () => {
            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex: [mkIndexEntry('001', { userSnippet: 'x' })],
                chapters: [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })],
                npcLedger: [],
                onStageNpcIds: [],
                maxPerScene: 0,
            });
            expect(result.snippets).toEqual([]);
        });

        it('maxPerScene: 1 emits the single available verbatim line', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [
                mkIndexEntry('001', {
                    userSnippet: 'User snippet.',
                    events: [{ eventType: 'combat', importance: 9, text: 'A clash.' }],
                }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
                maxPerScene: 1,
            });

            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].snippet).toBe('User snippet.');
        });

        it('maxPerScene: 2 emits the single available verbatim line (no second line is synthesized from events)', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const archiveIndex = [
                mkIndexEntry('001', {
                    userSnippet: 'User snippet.',
                    events: [
                        { eventType: 'combat', importance: 9, text: 'A clash.' },
                        { eventType: 'discovery', importance: 7, text: 'A cache.' },
                    ],
                }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
                maxPerScene: 2,
            });

            // Only one verbatim candidate exists under the current schema.
            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].snippet).toBe('User snippet.');
        });

        it('whitespace-only userSnippet is treated as blank → scene skipped', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001', '002'] })];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: '   ', events: [{ eventType: 'combat', importance: 9, text: 'A clash.' }] }),
                mkIndexEntry('002', { userSnippet: 'Real snippet.' }),
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['001', '002'],
                elevatedSceneIds: new Set(),
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            const ids = result.snippets.map(s => s.sceneId);
            expect(ids).not.toContain('001');
            expect(ids).toContain('002');
        });

        it('the four-scene cap, ranked order, elevated exclusion, and 200-character cap remain green together', () => {
            // Combined regression: 6 scenes, 2 elevated, 1 over the 4-cap, 1 long snippet.
            const chapters = [
                mkChapter({ chapterId: 'CH01', sceneIds: ['001', '002', '003', '004', '005', '006'] }),
            ];
            const archiveIndex = [
                mkIndexEntry('001', { userSnippet: 'one' }),
                mkIndexEntry('002', { userSnippet: 'two' }),
                mkIndexEntry('003', { userSnippet: 'three' }),
                mkIndexEntry('004', { userSnippet: 'four' }),
                mkIndexEntry('005', { userSnippet: 'five' }),
                mkIndexEntry('006', { userSnippet: 'x'.repeat(500) }), // long — capped at 200
            ];

            const result = buildSlottedRagSnippets({
                rankedSceneIds: ['006', '005', '004', '003', '002', '001'], // best-first
                elevatedSceneIds: new Set(['005', '003']), // 2 elevated
                archiveIndex,
                chapters,
                npcLedger: [],
                onStageNpcIds: [],
            });

            // 6 ranked − 2 elevated = 4 candidates; 4-scene cap admits all 4.
            expect(result.snippets).toHaveLength(4);
            // Ranked order preserved (elevated skipped): 006, 004, 002, 001.
            expect(result.snippets.map(s => s.sceneId)).toEqual(['006', '004', '002', '001']);
            // 200-char cap on scene 006.
            expect(result.snippets[0].snippet.length).toBe(200);
        });
    });

    describe('gatherSlottedRag — tier gating', () => {
        it('lite tier: no-op even with full state', () => {
            const state = makeState({ settings: { aiTier: 'lite', lodSlottedMaxPerScene: 2 } as any });
            const result = gatherSlottedRag(state, {
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                chapters: [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })],
            });
            expect(result.snippets).toEqual([]);
        });

        it('pro tier: no-op even with full state', () => {
            const state = makeState({ settings: { aiTier: 'pro', lodSlottedMaxPerScene: 2 } as any });
            const result = gatherSlottedRag(state, {
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                chapters: [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })],
            });
            expect(result.snippets).toEqual([]);
        });

        it('max tier: produces snippets when inputs are valid', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const state = makeState({
                settings: { aiTier: 'max', lodSlottedMaxPerScene: 2 } as any,
                archiveIndex: [mkIndexEntry('001', { userSnippet: 'User snippet.' })],
                chapters,
            });
            const result = gatherSlottedRag(state, {
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                chapters,
            });
            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].snippet).toBe('User snippet.');
        });

        it('empty archiveIndex → no-op', () => {
            const state = makeState({
                settings: { aiTier: 'max', lodSlottedMaxPerScene: 2 } as any,
                archiveIndex: [],
            });
            const result = gatherSlottedRag(state, {
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                chapters: [],
            });
            expect(result.snippets).toEqual([]);
        });

        it('empty rankedSceneIds → no-op', () => {
            const state = makeState({
                settings: { aiTier: 'max', lodSlottedMaxPerScene: 2 } as any,
                archiveIndex: [mkIndexEntry('001', { userSnippet: 'x' })],
            });
            const result = gatherSlottedRag(state, {
                rankedSceneIds: [],
                elevatedSceneIds: new Set(),
                chapters: [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })],
            });
            expect(result.snippets).toEqual([]);
        });

        it('lodSlottedMaxPerScene undefined → defaults to 2 (forward-compat setting preserved)', () => {
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const state = makeState({
                settings: { aiTier: 'max', lodSlottedMaxPerScene: undefined } as any,
                archiveIndex: [
                    mkIndexEntry('001', {
                        userSnippet: 'User snippet.',
                        events: [
                            { eventType: 'combat', importance: 9, text: 'A clash.' },
                        ],
                    }),
                ],
                chapters,
            });

            const result = gatherSlottedRag(state, {
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                chapters,
            });

            // Default 2: only the one verbatim userSnippet candidate exists.
            // Events are NOT a snippet source under WO-12b.
            expect(result.snippets).toHaveLength(1);
            expect(result.snippets[0].snippet).toBe('User snippet.');
        });

        it('max tier with off-stage-only witness: scene is dropped (strict on-stage authorization via gatherSlottedRag)', () => {
            // End-to-end: the off-stage NPC is in the ledger, non-archived, and
            // is the scene's only witness. state.onStageNpcIds does NOT include
            // it. Under WO-12b, the scene is dropped.
            const chapters = [mkChapter({ chapterId: 'CH01', sceneIds: ['001'] })];
            const state = makeState({
                settings: { aiTier: 'max', lodSlottedMaxPerScene: 2 } as any,
                archiveIndex: [mkIndexEntry('001', { userSnippet: 'Off-stage.', witnesses: ['npc_offstage'] })],
                npcLedger: [mkNpc('npc_offstage', 'Offstage', false)],
                onStageNpcIds: ['npc_a'],
                chapters,
            });

            const result = gatherSlottedRag(state, {
                rankedSceneIds: ['001'],
                elevatedSceneIds: new Set(),
                chapters,
            });

            expect(result.snippets).toEqual([]);
        });
    });

    describe('renderSlottedRagBlock — [FABLE-AUTHORED] format', () => {
        it('renders the verbatim [ARCHIVE FLASHES] format', () => {
            const snippets: SlottedRagSnippet[] = [
                { sceneId: '001', chapterId: 'CH01', snippet: 'A snippet.', witnessedBy: 'all' },
            ];

            const text = renderSlottedRagBlock(snippets);
            expect(text).toBe('[ARCHIVE FLASHES]\n- (Chapter CH01, witnessed by all) "A snippet."');
        });

        it('renders multiple snippets as separate lines', () => {
            const snippets: SlottedRagSnippet[] = [
                { sceneId: '001', chapterId: 'CH01', snippet: 'First.', witnessedBy: 'all' },
                { sceneId: '003', chapterId: 'CH01', snippet: 'Second.', witnessedBy: ['Aldric', 'Bram'] },
            ];

            const text = renderSlottedRagBlock(snippets);
            expect(text).toBe(
                '[ARCHIVE FLASHES]\n' +
                '- (Chapter CH01, witnessed by all) "First."\n' +
                '- (Chapter CH01, witnessed by Aldric, Bram) "Second."',
            );
        });

        it('joins witness names with ", "', () => {
            const snippets: SlottedRagSnippet[] = [
                { sceneId: '001', chapterId: 'CH01', snippet: 'x', witnessedBy: ['Aldric', 'Bram', 'Ciri'] },
            ];
            const text = renderSlottedRagBlock(snippets);
            expect(text).toContain('witnessed by Aldric, Bram, Ciri');
        });

        it('empty snippets → no block emitted (empty string)', () => {
            expect(renderSlottedRagBlock([])).toBe('');
        });

        it('preserves the exact header and line shape from the spec', () => {
            const snippets: SlottedRagSnippet[] = [
                { sceneId: '001', chapterId: 'CH02', snippet: 'The gates fell.', witnessedBy: 'all' },
            ];
            const text = renderSlottedRagBlock(snippets);
            // Spec format:
            //   [ARCHIVE FLASHES]
            //   - (Chapter {id}, witnessed by {names|"all"}) "{snippet}"
            expect(text).toContain('[ARCHIVE FLASHES]');
            expect(text).toContain('- (Chapter CH02, witnessed by all) "The gates fell."');
        });
    });
});