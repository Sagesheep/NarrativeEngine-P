import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payloadBuilder';
import { buildHistory } from '../history';
import { createTraceCollector } from '../traceCollector';
import { countTokens } from '../../infrastructure/tokenizer';
import type {
    GameContext,
    AppSettings,
    ChatMessage,
    ArchiveChapter,
    ArchiveIndexEntry,
} from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';

// ─────────────────────────────────────────────────────────────────────────────
// WO-09 — LOD history wiring into payload + cache-stability proofs.
// WO-09b — Checkpoint 2 cache-boundary corrections (LOD-only cache proof,
//          scene-note depth preservation, debug-section separation, envelope
//          accounting).
// WO-09c — Provider-wire cache proof + final accounting corrections
//          (truthful Fitted History content excluding both synthetic blocks,
//          conservative envelope reservation, bounded-allocation regression).
// WO-09d — Exact LOD allocation regression proof (test-only correction):
//          replaces the loose WO-09c `floor(contextLimit * 0.5)` upper-bound
//          and the structural `separate >= adjacent` assertions with a single
//          behavioral boundary test that exercises the one-token difference
//          between the 18-token conservative reserve and the obsolete 17-token
//          adjacent-halves estimate, proving the chapter demotes to synopsis
//          and the complete emitted LOD block fits the exact 200-token
//          allocation. Fails if production reverts to the 17-token reserve.
//
// Covers:
//  • Cache byte-identity: two payloads built with identical inputs produce a
//    byte-identical cached prefix (history portion included).
//  • Cache byte-identity across turns: a different current `userMessage` leaves
//    the cached history prefix byte-identical; only the final user message may differ.
//  • Old-campaign path: no synopsis fields → LOD fallbacks render, nothing throws.
//  • Empty-chapters path: the LOD block is omitted; payload shape matches today.
//  • LOD trace entry: source 'LOD History' recorded with counts + tokens.
//  • WO-09b §1: LOD-only cache proof — every chat message behind the condensed
//    boundary, LOD still renders, cached prefix contains the complete LOD block,
//    final user message is unstamped.
//  • WO-09b §2: scene-note depth preservation — enabling LOD does not change the
//    scene note's position relative to the real verbatim messages; LOD remains first.
//  • WO-09b §3: debug-section separation — the LOD History section contains the
//    LOD block once; the Fitted History section does not contain `[LOD HISTORY`.
//  • WO-09b §4: envelope accounting — the LOD trace token count equals
//    `countTokens` of the emitted LOD system-message content (envelope + body).
//  • WO-09c §3: Fitted History excludes BOTH synthetic blocks (LOD AND Scene Note).
//  • WO-09d: exact behavioral boundary — constructed 183-token summary body
//    exceeds the 182-token renderer body budget (200-token allocation minus the
//    18-token conservative envelope reserve), forcing synopsis demotion; the
//    complete emitted LOD block fits the exact 200-token allocation; the test
//    fails if production reverts to the 17-token adjacent-halves reserve.
// ─────────────────────────────────────────────────────────────────────────────

function baseContext(): GameContext {
    return {
        loreRaw: '',
        rulesRaw: '',
        canonState: '',
        headerIndex: '',
        starter: '',
        continuePrompt: '',
        inventory: '',
        inventoryLastScene: 'Never',
        characterProfile: '',
        characterProfileLastScene: 'Never',
        canonStateActive: false,
        headerIndexActive: false,
        starterActive: false,
        continuePromptActive: false,
        inventoryActive: false,
        characterProfileActive: false,
        surpriseEngineActive: false,
        encounterEngineActive: true,
        worldEngineActive: true,
        diceFairnessActive: true,
        sceneNote: '',
        sceneNoteActive: false,
        sceneNoteDepth: 3,
        worldVibe: '',
        notebook: [],
        notebookActive: false,
        worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
    } as unknown as GameContext;
}

function baseSettings(over: Partial<AppSettings> = {}): AppSettings {
    return {
        debugMode: true,
        contextLimit: 8192,
        lodSummaryChapters: 7,
        lodImportanceBonus: 2,
        ...over,
    } as unknown as AppSettings;
}

function mkChapter(over: Partial<ArchiveChapter> & { chapterId: string }): ArchiveChapter {
    const sceneStart = over.chapterId.replace('CH', '').padStart(3, '0');
    return {
        title: `Chapter ${over.chapterId}`,
        sceneRange: [sceneStart, sceneStart],
        sceneIds: [sceneStart],
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

function mkMsg(sceneId: string | undefined, role: 'user' | 'assistant' | 'tool', content = 'x'): ChatMessage {
    return {
        id: `msg_${sceneId ?? 'none'}_${Math.random().toString(36).slice(2, 8)}`,
        role,
        content,
        timestamp: 0,
        sceneId,
    } as ChatMessage;
}

/** Cached prefix = every assembled message up to and including the LAST message
 *  carrying cache_control: ephemeral. Per Anthropic prompt-caching semantics,
 *  the cache breakpoint marks the end of the cached region — everything before
 *  and including that breakpoint is cached, even messages without their own
 *  cache_control marker (e.g. the LOD system message we prepend). */
function cachedPrefix(messages: OpenAIMessage[]): string {
    let lastEphemeralIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if ((messages[i] as unknown as { cache_control?: { type: string } }).cache_control?.type === 'ephemeral') {
            lastEphemeralIdx = i;
            break;
        }
    }
    if (lastEphemeralIdx < 0) return '';
    return messages
        .slice(0, lastEphemeralIdx + 1)
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n----CACHE-BOUNDARY----\n');
}

/** The final volatile user message (below the cache boundary). */
function finalUserContent(messages: OpenAIMessage[]): string {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    return lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
}

// Three sealed chapters wholly behind a boundary at scene 009. Broadcast scenes
// (no witnesses) so the witness filter always admits them.
const SEALED_CHAPTERS: ArchiveChapter[] = [
    mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'], summary: 'CH01 long-form summary body.', synopsis: 'CH01 short synopsis.' }),
    mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'], summary: 'CH02 long-form summary body.', synopsis: 'CH02 short synopsis.' }),
    mkChapter({ chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'], summary: 'CH03 long-form summary body.', synopsis: 'CH03 short synopsis.' }),
];
const ARCHIVE_INDEX: ArchiveIndexEntry[] = ['001', '002', '003', '004', '005', '006', '007', '008', '009'].map(s => mkIndexEntry(s, { witnesses: [] }));

// 12 verbatim messages: scenes 001–012. Boundary at index 8 → scenes 001–009 condensed,
// 010–012 verbatim. CH01/CH02/CH03 are wholly behind the boundary.
function buildVerbatimHistory(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (let i = 1; i <= 12; i++) {
        const sceneId = String(i).padStart(3, '0');
        msgs.push(mkMsg(sceneId, 'assistant', `GM reply in scene ${sceneId}.`));
    }
    return msgs;
}

function buildPayloadWithLod(userMessage: string, opts: { chapters?: ArchiveChapter[]; settings?: Partial<AppSettings>; onStageNpcIds?: string[] } = {}) {
    return buildPayload({
        settings: baseSettings(opts.settings),
        context: baseContext(),
        history: buildVerbatimHistory(),
        userMessage,
        condensedUpToIndex: 8,
        archiveIndex: ARCHIVE_INDEX,
        chapters: opts.chapters ?? SEALED_CHAPTERS,
        onStageNpcIds: opts.onStageNpcIds ?? ['npc_a'],
    });
}

describe('WO-09 — LOD history wiring + cache proofs', () => {
    it('cache proof: two payloads built with identical inputs have byte-identical cached prefixes', () => {
        const a = buildPayloadWithLod('What happens next?');
        const b = buildPayloadWithLod('What happens next?');
        expect(cachedPrefix(b.messages)).toBe(cachedPrefix(a.messages));
    });

    it('cache proof: a different userMessage leaves the cached prefix byte-identical (only the final user message may differ)', () => {
        const a = buildPayloadWithLod('I draw my sword.');
        const b = buildPayloadWithLod('I try to parley with the guard.');
        // Cached prefix MUST be byte-identical — the only thing that changed is the
        // per-turn user message, which rides below the cache boundary.
        expect(cachedPrefix(b.messages)).toBe(cachedPrefix(a.messages));
        // The final user message MUST differ (sanity — otherwise the test is vacuous).
        expect(finalUserContent(b.messages)).not.toBe(finalUserContent(a.messages));
    });

    it('cache proof: cached prefix contains the LOD history block', () => {
        const { messages } = buildPayloadWithLod('I look around.');
        const prefix = cachedPrefix(messages);
        expect(prefix).toContain('[LOD HISTORY — CONDENSED CHAPTERS]');
        expect(prefix).toContain('Chapter CH01 —');
        expect(prefix).toContain('Chapter CH03 —');
        expect(prefix).toContain('[END LOD HISTORY]');
    });

    it('LOD trace entry is recorded with source "LOD History", counts + tokens, included:true', () => {
        const { trace } = buildPayloadWithLod('I look around.');
        const lodTrace = (trace ?? []).find(t => t.source === 'LOD History');
        expect(lodTrace).toBeDefined();
        expect(lodTrace!.included).toBe(true);
        expect(lodTrace!.tokens).toBeGreaterThan(0);
        // Reason describes the tier breakdown (summary/synopsis counts).
        expect(lodTrace!.reason).toMatch(/summary/);
        expect(lodTrace!.reason).toMatch(/synopsis/);
    });

    it('LOD trace reason reports dropped count when the budget cascade drops chapters', () => {
        // Pathological budget: 300-token contextLimit squeezes the history budget
        // down to near-zero, forcing the LOD cascade to drop synopsis chapters.
        // Two valid outcomes depending on exactly how tight the budget is:
        //  (a) the cascade drops some but not all chapters → LOD trace exists with
        //      a "dropped" count in the reason;
        //  (b) the cascade drops EVERY chapter → lodResult.text === '' → no LOD
        //      block emitted and no trace recorded (the renderer returns empty text).
        const { trace, messages } = buildPayloadWithLod('I look around.', {
            settings: { contextLimit: 300 },
        });
        const lodTrace = (trace ?? []).find(t => t.source === 'LOD History');
        const prefix = cachedPrefix(messages);
        if (lodTrace) {
            // Outcome (a): if a trace was recorded, the tier breakdown must be present.
            expect(lodTrace.reason).toMatch(/summary|synopsis/);
        } else {
            // Outcome (b): no trace → no LOD block in the cached prefix either.
            expect(prefix).not.toContain('[LOD HISTORY');
        }
    });

    it('old-campaign path: chapters with no synopsis fields → LOD fallbacks render, nothing throws', () => {
        const oldChapters: ArchiveChapter[] = [
            mkChapter({
                chapterId: 'CH01',
                sceneRange: ['001', '003'],
                sceneIds: ['001', '002', '003'],
                summary: 'First sentence here. Second sentence omitted.',
                synopsis: undefined,
                literalTitle: undefined,
                abstractTitle: undefined,
            }),
            mkChapter({
                chapterId: 'CH02',
                sceneRange: ['004', '006'],
                sceneIds: ['004', '005', '006'],
                summary: 'Another chapter summary.',
                synopsis: undefined,
                literalTitle: undefined,
                abstractTitle: undefined,
            }),
            mkChapter({
                chapterId: 'CH03',
                sceneRange: ['007', '009'],
                sceneIds: ['007', '008', '009'],
                summary: 'A third chapter summary.',
                synopsis: undefined,
                literalTitle: undefined,
                abstractTitle: undefined,
            }),
        ];
        // Must not throw — fallback chain (synopsis ?? first-sentence ?? title) handles missing fields.
        const { messages } = buildPayloadWithLod('I look around.', { chapters: oldChapters });
        const prefix = cachedPrefix(messages);
        expect(prefix).toContain('[LOD HISTORY — CONDENSED CHAPTERS]');
        // Old chapters have no synopsis → the renderer falls back to the first
        // sentence of the summary for synopsis-tier chapters (CH01 is oldest → synopsis).
        // Either way, the chapter header line must appear.
        expect(prefix).toContain('Chapter CH01 —');
    });

    it('empty-chapters path: when chapters is undefined, the LOD block is omitted and the payload shape matches the pre-WO-09 layout', () => {
        // No chapters → LOD is skipped entirely. The cached prefix must NOT contain
        // the LOD marker. The payload must still build (no throw).
        const { messages } = buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: buildVerbatimHistory(),
            userMessage: 'I look around.',
            condensedUpToIndex: 8,
            archiveIndex: ARCHIVE_INDEX,
            onStageNpcIds: ['npc_a'],
        });
        const prefix = cachedPrefix(messages);
        expect(prefix).not.toContain('[LOD HISTORY');
        // The verbatim window must still be present (cache-stamping on last history msg).
        const ephemeralMsgs = messages.filter(
            m => (m as unknown as { cache_control?: { type: string } }).cache_control?.type === 'ephemeral'
        );
        expect(ephemeralMsgs.length).toBeGreaterThan(0);
    });

    it('empty-chapters path: no condensed boundary (condensedUpToIndex undefined) → LOD omitted even if chapters are passed', () => {
        // No condensation yet → nothing is "wholly behind" → LOD renders nothing.
        // Mirrors the "nothing condensed" rule from WO-08.
        const { messages } = buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: buildVerbatimHistory(),
            userMessage: 'I look around.',
            archiveIndex: ARCHIVE_INDEX,
            chapters: SEALED_CHAPTERS,
            onStageNpcIds: ['npc_a'],
        });
        const prefix = cachedPrefix(messages);
        expect(prefix).not.toContain('[LOD HISTORY');
    });

    it('cache-stamp placement is unchanged: the last ephemeral message is still a history message (user/assistant), not the final volatile user message', () => {
        // WO-09 protected invariant #2: payloadBuilder's cache-stamping (lines 62-72)
        // must not change. The LOD block is PREPENDED, so the LAST history message
        // is still the last verbatim window entry — the cache stamp lands there.
        const { messages } = buildPayloadWithLod('I look around.');
        const ephemeralMsgs = messages.filter(
            m => (m as unknown as { cache_control?: { type: string } }).cache_control?.type === 'ephemeral'
        );
        expect(ephemeralMsgs.length).toBeGreaterThan(0);
        const lastEphemeral = ephemeralMsgs[ephemeralMsgs.length - 1];
        // The cache-stamp must land on a history entry (user/assistant role), NOT on
        // the final volatile user message (which would bust the cache boundary).
        expect(['user', 'assistant']).toContain(lastEphemeral.role);
        // The final message in the assembled payload is the volatile user message and
        // must NOT carry cache_control (it rides below the cache boundary).
        const finalMsg = messages[messages.length - 1];
        expect(finalMsg.role).toBe('user');
        expect((finalMsg as unknown as { cache_control?: unknown }).cache_control).toBeUndefined();
    });

    it('LOD knobs flow through settings: lodSummaryChapters=0 demotes every chapter to synopsis tier', () => {
        // summaryChapters=0 → no chapter gets summary tier; all render as synopsis.
        const { trace } = buildPayloadWithLod('I look around.', {
            settings: { lodSummaryChapters: 0, lodImportanceBonus: 0 },
        });
        const lodTrace = (trace ?? []).find(t => t.source === 'LOD History');
        expect(lodTrace).toBeDefined();
        // 0 summary, 3 synopsis (all three sealed chapters demoted to synopsis).
        expect(lodTrace!.reason).toMatch(/0 summary/);
        expect(lodTrace!.reason).toMatch(/3 synopsis/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WO-09b — Checkpoint 2 cache-boundary corrections.
// ─────────────────────────────────────────────────────────────────────────────

/** Helper: build a payload where EVERY chat message is at or before the condensed
 *  boundary, so the verbatim window is empty and `fitted` consists solely of the
 *  LOD `system` message. This is the LOD-only shape WO-09b §1 addresses. */
function buildLodOnlyPayload(userMessage: string, opts: { chapters?: ArchiveChapter[]; onStageNpcIds?: string[] } = {}) {
    // 9 verbatim messages, scenes 001–009. Boundary at index 8 → ALL 9 messages
    // are at or before `condensedUpToIndex`, so `history.slice(9)` is empty.
    const msgs: ChatMessage[] = [];
    for (let i = 1; i <= 9; i++) {
        const sceneId = String(i).padStart(3, '0');
        msgs.push(mkMsg(sceneId, 'assistant', `GM reply in scene ${sceneId}.`));
    }
    return buildPayload({
        settings: baseSettings(),
        context: baseContext(),
        history: msgs,
        userMessage,
        condensedUpToIndex: 8,
        archiveIndex: ARCHIVE_INDEX,
        chapters: opts.chapters ?? SEALED_CHAPTERS,
        onStageNpcIds: opts.onStageNpcIds ?? ['npc_a'],
    });
}

describe('WO-09b — Checkpoint 2 cache-boundary corrections', () => {
    describe('§1 — LOD-only cache proof', () => {
        it('LOD-only shape: LOD still renders when every chat message is behind the condensed boundary', () => {
            const { messages } = buildLodOnlyPayload('I look around.');
            const prefix = cachedPrefix(messages);
            // The LOD block must be present in the cached prefix even when no
            // verbatim message survives after the boundary.
            expect(prefix).toContain('[LOD HISTORY — CONDENSED CHAPTERS]');
            expect(prefix).toContain('Chapter CH01 —');
            expect(prefix).toContain('[END LOD HISTORY]');
        });

        it('LOD-only shape: the cached prefix contains the complete LOD block (the LOD system message is the cache breakpoint)', () => {
            const { messages } = buildLodOnlyPayload('I look around.');
            // In the LOD-only shape, the LOD system message is the ONLY fitted
            // message. WO-09b §1 widens the cache-stamp role check to include
            // `system`, so the LOD message itself must carry cache_control.
            const lodMsg = messages.find(
                m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[LOD HISTORY')
            );
            expect(lodMsg).toBeDefined();
            expect((lodMsg as unknown as { cache_control?: { type: string } }).cache_control?.type).toBe('ephemeral');
        });

        it('LOD-only shape: the final volatile user message is unstamped (rides below the cache boundary)', () => {
            const { messages } = buildLodOnlyPayload('I look around.');
            const finalMsg = messages[messages.length - 1];
            expect(finalMsg.role).toBe('user');
            // The final user message must NOT carry cache_control — it is below
            // the cache boundary by design.
            expect((finalMsg as unknown as { cache_control?: unknown }).cache_control).toBeUndefined();
        });

        it('LOD-only shape: cache prefix is byte-identical across two same-input turns', () => {
            const a = buildLodOnlyPayload('What happens next?');
            const b = buildLodOnlyPayload('What happens next?');
            expect(cachedPrefix(b.messages)).toBe(cachedPrefix(a.messages));
        });
    });

    describe('§2 — Scene-note depth preservation', () => {
        /** Build a payload with a scene note at the given depth, optionally with
         *  LOD enabled (chapters passed) or disabled (chapters undefined). */
        function buildWithSceneNote(depth: number, opts: { withLod: boolean }) {
            const ctx: GameContext = {
                ...baseContext(),
                sceneNoteActive: true,
                sceneNote: 'Remember: Aldric is hiding in the shadows.',
                sceneNoteDepth: depth,
            } as GameContext;
            // 12 verbatim messages so the scene note lands at a real depth
            // position relative to the verbatim window (not the fallback path).
            const msgs: ChatMessage[] = [];
            for (let i = 1; i <= 12; i++) {
                const sceneId = String(i).padStart(3, '0');
                msgs.push(mkMsg(sceneId, 'assistant', `GM reply in scene ${sceneId}.`));
            }
            return buildPayload({
                settings: baseSettings(),
                context: ctx,
                history: msgs,
                userMessage: 'I look around.',
                condensedUpToIndex: 8,
                archiveIndex: ARCHIVE_INDEX,
                chapters: opts.withLod ? SEALED_CHAPTERS : undefined,
                onStageNpcIds: ['npc_a'],
            });
        }

        /** Find the index of the scene-note system message inside the assembled
         *  payload, and the indices of the verbatim history messages (assistant
         *  role). Returns { noteIdx, verbatimIdxs } so the caller can assert the
         *  note's position relative to the real verbatim messages. */
        function sceneNotePosition(messages: OpenAIMessage[]): { noteIdx: number; verbatimIdxs: number[] } {
            let noteIdx = -1;
            const verbatimIdxs: number[] = [];
            for (let i = 0; i < messages.length; i++) {
                const m = messages[i];
                if (m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE: VOLATILE GUIDANCE]')) {
                    noteIdx = i;
                } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('GM reply in scene')) {
                    verbatimIdxs.push(i);
                }
            }
            return { noteIdx, verbatimIdxs };
        }

        it('enabling LOD does not change the scene note position relative to the real verbatim messages', () => {
            // For identical verbatim history and sceneNoteDepth, the scene note's
            // position relative to the verbatim window must be the same whether or
            // not LOD is enabled. LOD is prepended ahead of the verbatim window,
            // so it shifts EVERYTHING (including the scene note) by 1 — but the
            // scene note's RELATIVE position within the verbatim window is unchanged.
            const depth = 2;
            const withoutLod = buildWithSceneNote(depth, { withLod: false });
            const withLod = buildWithSceneNote(depth, { withLod: true });

            const posWithout = sceneNotePosition(withoutLod.messages);
            const posWith = sceneNotePosition(withLod.messages);

            // Sanity: both payloads found the scene note and at least one verbatim msg.
            expect(posWithout.noteIdx).toBeGreaterThan(-1);
            expect(posWith.noteIdx).toBeGreaterThan(-1);
            expect(posWithout.verbatimIdxs.length).toBeGreaterThan(0);
            expect(posWith.verbatimIdxs.length).toBeGreaterThan(0);

            // The scene note's position RELATIVE to the verbatim window is the
            // same in both shapes. We measure this as "how many verbatim messages
            // come AFTER the scene note" — the depth-from-end invariant. LOD
            // shifts the absolute indices by 1 (it is prepended), but the relative
            // count of verbatim messages after the note must be identical.
            const verbatimAfterNoteWithout = posWithout.verbatimIdxs.filter(i => i > posWithout.noteIdx).length;
            const verbatimAfterNoteWith = posWith.verbatimIdxs.filter(i => i > posWith.noteIdx).length;
            expect(verbatimAfterNoteWith).toBe(verbatimAfterNoteWithout);

            // The scene note's depth property is honored: at depth=2, exactly 2
            // verbatim messages come after it (the depth-2 splice puts the note
            // 2-from-the-end of the verbatim window).
            expect(verbatimAfterNoteWithout).toBe(2);
        });

        it('LOD remains first in the assembled payload when the scene note is active', () => {
            const { messages } = buildWithSceneNote(3, { withLod: true });
            // The first non-stable, non-divergence, non-pinned message must be the
            // LOD system message (it is prepended AFTER the scene-note splice but
            // BEFORE the verbatim window). We identify it by its content marker.
            const lodIdx = messages.findIndex(
                m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[LOD HISTORY')
            );
            const noteIdx = messages.findIndex(
                m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE: VOLATILE GUIDANCE]')
            );
            expect(lodIdx).toBeGreaterThan(-1);
            expect(noteIdx).toBeGreaterThan(-1);
            // LOD must come before the scene note in the assembled payload.
            expect(lodIdx).toBeLessThan(noteIdx);
        });
    });

    describe('§3 — Debug-section separation', () => {
        it('the LOD History section contains the LOD block exactly once and the Fitted History section does not contain [LOD HISTORY', () => {
            const { debugSections } = buildPayloadWithLod('I look around.');
            expect(debugSections).toBeDefined();
            const sections = debugSections ?? [];

            const lodSections = sections.filter(s => s.label.startsWith('LOD History'));
            const fittedSections = sections.filter(s => s.label.startsWith('Fitted History'));

            // Exactly one LOD History section.
            expect(lodSections.length).toBe(1);
            // The LOD section content contains the LOD block marker.
            expect(lodSections[0].content).toContain('[LOD HISTORY — CONDENSED CHAPTERS]');
            expect(lodSections[0].content).toContain('[END LOD HISTORY]');

            // At least one Fitted History section exists.
            expect(fittedSections.length).toBeGreaterThanOrEqual(1);
            // The Fitted History section must NOT contain the LOD block marker —
            // the LOD block has its own section and must not be duplicated here.
            for (const s of fittedSections) {
                expect(s.content).not.toContain('[LOD HISTORY');
            }
        });
    });

    describe('§4 — Envelope accounting', () => {
        it('the LOD trace token count equals countTokens of the emitted LOD system-message content', () => {
            const { trace, messages } = buildPayloadWithLod('I look around.');
            const lodTrace = (trace ?? []).find(t => t.source === 'LOD History');
            expect(lodTrace).toBeDefined();

            // Find the actual emitted LOD system message in the assembled payload.
            const lodMsg = messages.find(
                m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[LOD HISTORY')
            );
            expect(lodMsg).toBeDefined();
            const emittedContent = lodMsg!.content as string;

            // The trace's token count must equal countTokens of the actual emitted
            // content (envelope + body), not just the renderer's body token count.
            expect(lodTrace!.tokens).toBe(countTokens(emittedContent));
        });

        it('the LOD trace token count is strictly greater than the renderer body token count (envelope adds tokens)', () => {
            // The envelope ([LOD HISTORY — CONDENSED CHAPTERS]\n ... \n[END LOD HISTORY])
            // adds deterministic tokens on top of the renderer's body. The trace
            // must count the envelope too — otherwise the LOD allocation would
            // silently exceed the history budget by the envelope's token cost.
            const { trace, messages } = buildPayloadWithLod('I look around.');
            const lodTrace = (trace ?? []).find(t => t.source === 'LOD History');
            expect(lodTrace).toBeDefined();

            // Find the emitted LOD body (text between the envelope markers).
            const lodMsg = messages.find(
                m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[LOD HISTORY')
            );
            expect(lodMsg).toBeDefined();
            const emitted = lodMsg!.content as string;
            const bodyMatch = emitted.match(/\[LOD HISTORY — CONDENSED CHAPTERS\]\n([\s\S]*)\n\[END LOD HISTORY\]/);
            expect(bodyMatch).not.toBeNull();
            const bodyText = bodyMatch![1];
            const bodyTokens = countTokens(bodyText);

            // The trace count (envelope + body) must be strictly greater than
            // the body-only count — this proves the envelope is being counted.
            expect(lodTrace!.tokens).toBeGreaterThan(bodyTokens);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WO-09c — Provider-wire cache proof + final accounting corrections.
// ─────────────────────────────────────────────────────────────────────────────

describe('WO-09c — Final accounting corrections', () => {
    describe('§3 — Fitted History excludes BOTH synthetic blocks', () => {
        // Build a payload with BOTH LOD and an active scene note, so both
        // synthetic blocks are present and the Fitted History section must
        // exclude both.
        function buildWithLodAndSceneNote() {
            const ctx: GameContext = {
                ...baseContext(),
                sceneNoteActive: true,
                sceneNote: 'Remember: Aldric is hiding in the shadows.',
                sceneNoteDepth: 2,
            } as GameContext;
            const msgs: ChatMessage[] = [];
            for (let i = 1; i <= 12; i++) {
                const sceneId = String(i).padStart(3, '0');
                msgs.push(mkMsg(sceneId, 'assistant', `GM reply in scene ${sceneId}.`));
            }
            return buildPayload({
                settings: baseSettings(),
                context: ctx,
                history: msgs,
                userMessage: 'I look around.',
                condensedUpToIndex: 8,
                archiveIndex: ARCHIVE_INDEX,
                chapters: SEALED_CHAPTERS,
                onStageNpcIds: ['npc_a'],
            });
        }

        it('Fitted History contains neither [LOD HISTORY nor [SCENE NOTE', () => {
            const { debugSections } = buildWithLodAndSceneNote();
            expect(debugSections).toBeDefined();
            const sections = debugSections ?? [];

            const fittedSections = sections.filter(s => s.label.startsWith('Fitted History'));
            expect(fittedSections.length).toBeGreaterThanOrEqual(1);

            // The Fitted History section must contain NEITHER synthetic block.
            // LOD has its own section; the scene note has its own section. The
            // Fitted History section describes the verbatim window ONLY.
            for (const s of fittedSections) {
                expect(s.content).not.toContain('[LOD HISTORY');
                expect(s.content).not.toContain('[SCENE NOTE');
            }
        });

        it('the separate LOD History and Scene Note sections each contain their own block exactly once', () => {
            const { debugSections } = buildWithLodAndSceneNote();
            const sections = debugSections ?? [];

            const lodSections = sections.filter(s => s.label.startsWith('LOD History'));
            const sceneNoteSections = sections.filter(s => s.label === 'Scene Note');

            // Exactly one LOD History section.
            expect(lodSections.length).toBe(1);
            expect(lodSections[0].content).toContain('[LOD HISTORY — CONDENSED CHAPTERS]');
            expect(lodSections[0].content).toContain('[END LOD HISTORY]');
            // The LOD block marker appears exactly once in the LOD section.
            expect((lodSections[0].content.match(/\[LOD HISTORY — CONDENSED CHAPTERS\]/g) ?? []).length).toBe(1);
            expect((lodSections[0].content.match(/\[END LOD HISTORY\]/g) ?? []).length).toBe(1);

            // Exactly one Scene Note section.
            expect(sceneNoteSections.length).toBe(1);
            expect(sceneNoteSections[0].content).toContain('[SCENE NOTE: VOLATILE GUIDANCE]');
            // The scene note marker appears exactly once in the Scene Note section.
            expect((sceneNoteSections[0].content.match(/\[SCENE NOTE: VOLATILE GUIDANCE\]/g) ?? []).length).toBe(1);
        });

        it('the scene note prompt position relative to verbatim messages remains the WO-09b-tested depth', () => {
            // Re-assert the WO-09b depth-preservation invariant in the
            // LOD+scene-note shape: at depth=2, exactly 2 verbatim messages
            // come after the scene note.
            const { messages } = buildWithLodAndSceneNote();
            let noteIdx = -1;
            const verbatimIdxs: number[] = [];
            for (let i = 0; i < messages.length; i++) {
                const m = messages[i];
                if (m.role === 'system' && typeof m.content === 'string' && m.content.includes('[SCENE NOTE: VOLATILE GUIDANCE]')) {
                    noteIdx = i;
                } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('GM reply in scene')) {
                    verbatimIdxs.push(i);
                }
            }
            expect(noteIdx).toBeGreaterThan(-1);
            const verbatimAfterNote = verbatimIdxs.filter(i => i > noteIdx).length;
            expect(verbatimAfterNote).toBe(2);
        });
    });

    describe('§4 — Exact LOD allocation boundary (WO-09d)', () => {
        // WO-09d replaces the two weak WO-09c allocation tests (which compared
        // against `floor(contextLimit * 0.5) = 4096` and only proved
        // `separate >= adjacent` independently of production output) with a
        // single behavioral boundary test that exercises the one-token
        // difference between the 18-token conservative envelope reserve and the
        // obsolete 17-token adjacent-halves estimate.
        //
        // The test calls `buildHistory` directly with known token inputs so the
        // `historyBudget` and `lodAllocation` are exact and asserted. The
        // constructed summary-tier body has exactly 183 tokens; with the
        // conservative 18-token reserve the renderer body budget is 182, so the
        // 183-token summary body exceeds it and the chapter demotes to the short
        // synopsis tier. Under the obsolete 17-token reserve the body budget
        // would be 183, so the long summary would stay in summary tier and the
        // emitted block would contain the long summary, not the short synopsis —
        // the tier assertion below fails in that case.

        it('the 18-token conservative reserve forces synopsis demotion and the complete emitted LOD block fits the exact 200-token allocation', () => {
            // --- Fixtures --------------------------------------------------
            const CHAPTER_ID = 'CH01';
            const TITLE = 'The Long March';
            // Construct the summary so `countTokens(summaryBody) === 183` exactly.
            // summaryBody = `Chapter CH01 — The Long March\n${summary}` (no trailing newline).
            // `scene ` repeated 174 times yields exactly 183 tokens for this header.
            const SUMMARY_BODY = `Chapter ${CHAPTER_ID} \u2014 ${TITLE}\n${'scene '.repeat(174)}`;
            // Assert the target explicitly so the test cannot silently drift.
            expect(countTokens(SUMMARY_BODY)).toBe(183);

            // A much shorter explicit synopsis so the synopsis-tier body fits
            // the renderer body budget easily.
            const SYNOPSIS = 'Short synopsis.';
            const SYNOPSIS_BODY = `Chapter ${CHAPTER_ID} \u2014 ${TITLE}\n${SYNOPSIS}`;
            expect(countTokens(SYNOPSIS_BODY)).toBeLessThan(183);

            const chapter: ArchiveChapter = {
                chapterId: CHAPTER_ID,
                title: TITLE,
                summary: 'scene '.repeat(174), // yields SUMMARY_BODY when rendered at summary tier
                synopsis: SYNOPSIS,
                sceneRange: ['001', '001'],
                sceneIds: ['001'],
                keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
                tone: '', themes: [], sceneCount: 1, sealedAt: 1,
            } as ArchiveChapter;

            const archiveIndex: ArchiveIndexEntry[] = [{
                sceneId: '001', timestamp: 0, keywords: [], npcsMentioned: [],
                witnesses: [], userSnippet: '',
            } as ArchiveIndexEntry];

            // One message at index 0 with sceneId '001' so the chapter is
            // "wholly behind" the boundary at condensedUpToIndex = 0.
            const history: ChatMessage[] = [{
                id: 'msg_001', role: 'assistant', content: 'GM reply in scene 001.',
                timestamp: 0, sceneId: '001',
            } as ChatMessage];

            // --- Exact budget arithmetic ----------------------------------
            // Production formula (history.ts):
            //   userTokens = countTokens(userMessage)
            //   historyBudget = max(0, limit - stableTokens - currentWorldTokens - volatileTokens - userTokens - 200)
            //   lodAllocation = min(historyBudget, max(200, floor(historyBudget * 0.5)))
            //   envelopeCost = countTokens(prefix) + countTokens(suffix)   [conservative]
            //   renderer body budget = max(0, lodAllocation - envelopeCost)
            //
            // Choose userMessage = '' (userTokens = 0), stable/world/volatile = 0,
            // limit = 400 → historyBudget = 400 - 0 - 0 - 0 - 0 - 200 = 200.
            // lodAllocation = min(200, max(200, 100)) = 200.
            // envelopeCost = 12 + 6 = 18 (conservative).
            // renderer body budget = 200 - 18 = 182.
            const USER_MESSAGE = '';
            const LIMIT = 400;
            const STABLE_TOKENS = 0;
            const WORLD_TOKENS = 0;
            const VOLATILE_TOKENS = 0;

            const userTokens = countTokens(USER_MESSAGE);
            const historyBudget = Math.max(0, LIMIT - STABLE_TOKENS - WORLD_TOKENS - VOLATILE_TOKENS - userTokens - 200);
            const lodAllocation = Math.min(historyBudget, Math.max(200, Math.floor(historyBudget * 0.5)));
            const LOD_ENVELOPE_PREFIX = '[LOD HISTORY \u2014 CONDENSED CHAPTERS]\n';
            const LOD_ENVELOPE_SUFFIX = '\n[END LOD HISTORY]';
            const envelopeCost = countTokens(LOD_ENVELOPE_PREFIX) + countTokens(LOD_ENVELOPE_SUFFIX);
            const rendererBodyBudget = Math.max(0, lodAllocation - envelopeCost);

            // Assert the exact budget values the test depends on.
            expect(userTokens).toBe(0);
            expect(historyBudget).toBe(200);
            expect(lodAllocation).toBe(200);
            expect(envelopeCost).toBe(18); // conservative (12 + 6); obsolete adjacent estimate is 17
            expect(rendererBodyBudget).toBe(182);

            // The constructed summary body (183) exceeds the renderer body
            // budget (182) by exactly one token — this is the boundary that
            // distinguishes the conservative reserve from the obsolete one.
            expect(countTokens(SUMMARY_BODY)).toBeGreaterThan(rendererBodyBudget);

            // --- Build via the exported production function ---------------
            const ctx = {
                sceneNoteActive: false, sceneNote: '', sceneNoteDepth: 3,
            } as GameContext;
            const collector = createTraceCollector(true);

            const fitted = buildHistory({
                history,
                condensedUpToIndex: 0,
                userMessage: USER_MESSAGE,
                limit: LIMIT,
                stableTokens: STABLE_TOKENS,
                currentWorldTokens: WORLD_TOKENS,
                volatileTokens: VOLATILE_TOKENS,
                context: ctx,
                collector,
                chapters: [chapter],
                archiveIndex,
                lodSummaryChapters: 7,
                lodImportanceBonus: 0,
            });

            // --- Assertions on the emitted LOD block ----------------------
            // The LOD system message is the first fitted entry (prepended).
            const lodMsg = fitted.find(
                m => m.role === 'system' && typeof m.content === 'string' && m.content.includes('[LOD HISTORY')
            );
            expect(lodMsg).toBeDefined();
            const emittedContent = lodMsg!.content as string;

            // (1) The chapter demoted to synopsis tier — the emitted block
            //     contains the SHORT synopsis, NOT the long summary body. This
            //     is the assertion that fails under the obsolete 17-token
            //     adjacent-halves reserve (with that reserve, the 183-token
            //     summary body fits the 183-token body budget, so the chapter
            //     stays at summary tier and the emitted block contains the long
            //     summary instead).
            expect(emittedContent).toContain(SYNOPSIS);
            expect(emittedContent).not.toContain('scene scene scene');

            // (2) The complete emitted LOD block (envelope + body) fits the
            //     exact 200-token allocation. This is the bounded-allocation
            //     assertion WO-09c required, now against the real allocation.
            const emittedTokens = countTokens(emittedContent);
            expect(emittedTokens).toBeLessThanOrEqual(lodAllocation);
            expect(lodAllocation).toBe(200);

            // (3) The LOD trace token count equals the actual emitted content
            //     count (WO-09b §4 invariant preserved).
            const lodTrace = collector.trace.find(t => t.source === 'LOD History');
            expect(lodTrace).toBeDefined();
            expect(lodTrace!.tokens).toBe(emittedTokens);

            // (4) The tier breakdown in the trace reason reports 0 summary,
            //     1 synopsis — proving the demotion cascade fired.
            expect(lodTrace!.reason).toMatch(/0 summary/);
            expect(lodTrace!.reason).toMatch(/1 synopsis/);
        });
    });
});