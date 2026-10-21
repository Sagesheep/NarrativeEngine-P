import { describe, it, expect } from 'vitest';
import { buildChatBody } from '../llmApiHelper';
import { buildPayload } from '../../services/payload/payloadBuilder';
import type { EndpointConfig, GameContext, AppSettings, ChatMessage, ArchiveChapter, ArchiveIndexEntry } from '../../types';

const claudeProvider: EndpointConfig = {
    endpoint: 'https://api.anthropic.com',
    modelName: 'claude-sonnet-4-20250514',
    apiKey: 'test-key',
    apiFormat: 'claude',
};

const openAIProvider: EndpointConfig = {
    endpoint: 'https://api.openai.com/v1',
    modelName: 'gpt-4o',
    apiKey: 'test-key',
    apiFormat: 'openai',
};

const ollamaProvider: EndpointConfig = {
    endpoint: 'http://localhost:11434',
    modelName: 'llama3',
    apiFormat: 'ollama',
} as EndpointConfig;

const cacheControlEphemeral = { type: 'ephemeral' as const };

describe('buildChatBody — cache_control handling', () => {
    it('Claude: system message with cache_control emits system as array of blocks with cache_control', () => {
        const messages = [
            { role: 'system', content: 'You are a helpful GM.', cache_control: cacheControlEphemeral },
            { role: 'system', content: 'Established facts here.' },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(claudeProvider, messages, { stream: false });
        const system = body.system as { type: string; text: string; cache_control?: { type: string } }[];
        expect(Array.isArray(system)).toBe(true);
        expect(system[0].type).toBe('text');
        expect(system[0].text).toBe('You are a helpful GM.');
        expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(system[1].cache_control).toBeUndefined();
    });

    it('Claude: system message without any cache_control emits system as plain string', () => {
        const messages = [
            { role: 'system', content: 'You are a helpful GM.' },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(claudeProvider, messages, { stream: false });
        expect(typeof body.system).toBe('string');
    });

    it('Claude: stable and divergence blocks get cache_control, world block does not', () => {
        const messages = [
            { role: 'system', content: 'Rules text here.', cache_control: cacheControlEphemeral },
            { role: 'system', content: 'Divergence facts.', cache_control: cacheControlEphemeral },
            { role: 'system', content: '[WORLD LORE]\nSome lore content.' },
            { role: 'system', content: '[GM REMINDER: ...]' },
            { role: 'user', content: 'I look around' },
        ];
        const body = buildChatBody(claudeProvider, messages, { stream: false });
        const system = body.system as { type: string; text: string; cache_control?: { type: string } }[];
        expect(system.length).toBe(4);
        expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
        expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
        expect(system[2].cache_control).toBeUndefined();
        expect(system[3].cache_control).toBeUndefined();
    });

    it('OpenAI: cache_control is stripped from messages in request body', () => {
        const messages = [
            { role: 'system', content: 'Rules text here.', cache_control: cacheControlEphemeral },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(openAIProvider, messages, { stream: false });
        const bodyMessages = body.messages as { role: string; content: string; cache_control?: unknown }[];
        expect(bodyMessages[0].cache_control).toBeUndefined();
        expect(bodyMessages[0].content).toBe('Rules text here.');
    });

    it('Ollama: cache_control is stripped from messages in request body', () => {
        const messages = [
            { role: 'system', content: 'Rules text here.', cache_control: cacheControlEphemeral },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(ollamaProvider, messages, { stream: false });
        const bodyMessages = body.messages as { role: string; content: string; cache_control?: unknown }[];
        expect(bodyMessages[0].cache_control).toBeUndefined();
    });

    it('Gemini: system messages are collected into systemInstruction (cache_control irrelevant for Gemini)', () => {
        const geminiProvider: EndpointConfig = {
            endpoint: 'https://generativelanguage.googleapis.com',
            modelName: 'gemini-2.0-flash',
            apiKey: 'test-key',
            apiFormat: 'gemini',
        };
        const messages = [
            { role: 'system', content: 'You are a GM.', cache_control: cacheControlEphemeral },
            { role: 'user', content: 'Hello' },
        ];
        const body = buildChatBody(geminiProvider, messages, { stream: false });
        const si = body.systemInstruction as { parts: { text: string }[] };
        expect(si).toBeDefined();
        expect(si.parts[0].text).toContain('You are a GM.');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WO-09c — Provider-wire cache proof.
//
// Assembly-level cache tests (WO-09/09b) prove the breakpoint is placed on the
// last fitted history message in the assembled `OpenAIMessage[]`. This block
// proves the breakpoint survives `transformClaudeMessages` and lands on the
// actual Claude wire body — the pre-transform array is NOT sufficient because
// `transformClaudeMessages` previously re-emitted user/assistant messages
// without copying the marker.
// ─────────────────────────────────────────────────────────────────────────────

describe('WO-09c — Claude wire preserves history breakpoints', () => {
    describe('§1 — stamped non-system messages carry cache_control onto the wire', () => {
        it('a stamped plain user history message becomes a Claude text block carrying cache_control: { type: "ephemeral" }', () => {
            const messages = [
                { role: 'system', content: 'Rules.', cache_control: cacheControlEphemeral },
                { role: 'user', content: 'Earlier user turn', cache_control: cacheControlEphemeral },
                { role: 'user', content: 'Final volatile user message' },
            ];
            const body = buildChatBody(claudeProvider, messages, { stream: false });
            const conv = body.messages as { role: string; content: string | { type: string; text?: string; cache_control?: { type: string } }[] }[];

            // The stamped user message (index 0 in conv after system hoisting)
            // must emit as an array with a single text block carrying cache_control.
            const stampedUser = conv[0];
            expect(stampedUser.role).toBe('user');
            expect(Array.isArray(stampedUser.content)).toBe(true);
            const blocks = stampedUser.content as { type: string; text?: string; cache_control?: { type: string } }[];
            expect(blocks.length).toBe(1);
            expect(blocks[0].type).toBe('text');
            expect(blocks[0].text).toBe('Earlier user turn');
            expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
        });

        it('a stamped plain assistant history message becomes a Claude text block carrying cache_control: { type: "ephemeral" }', () => {
            const messages = [
                { role: 'system', content: 'Rules.', cache_control: cacheControlEphemeral },
                { role: 'user', content: 'User turn' },
                { role: 'assistant', content: 'GM reply', cache_control: cacheControlEphemeral },
                { role: 'user', content: 'Final volatile user message' },
            ];
            const body = buildChatBody(claudeProvider, messages, { stream: false });
            const conv = body.messages as { role: string; content: string | { type: string; text?: string; cache_control?: { type: string } }[] }[];

            // The stamped assistant message is at index 1 in conv (after the user turn).
            const stampedAssistant = conv[1];
            expect(stampedAssistant.role).toBe('assistant');
            expect(Array.isArray(stampedAssistant.content)).toBe(true);
            const blocks = stampedAssistant.content as { type: string; text?: string; cache_control?: { type: string } }[];
            expect(blocks.length).toBe(1);
            expect(blocks[0].type).toBe('text');
            expect(blocks[0].text).toBe('GM reply');
            expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
        });

        it('a stamped assistant message with tool calls carries exactly one marker on its final emitted block while preserving all existing blocks', () => {
            const toolCall = { id: 'tc_1', type: 'function', function: { name: 'roll_dice', arguments: '{"dice":"2d6"}' } };
            const messages = [
                { role: 'system', content: 'Rules.', cache_control: cacheControlEphemeral },
                { role: 'user', content: 'I attack' },
                { role: 'assistant', content: 'Let me roll.', tool_calls: [toolCall], cache_control: cacheControlEphemeral },
                { role: 'user', content: 'Final volatile user message' },
            ];
            const body = buildChatBody(claudeProvider, messages, { stream: false });
            const conv = body.messages as { role: string; content: string | { type: string; text?: string; id?: string; name?: string; input?: unknown; cache_control?: { type: string } }[] }[];

            // The stamped assistant-with-tool-calls message is at index 1 in conv.
            const stampedAssistant = conv[1];
            expect(stampedAssistant.role).toBe('assistant');
            expect(Array.isArray(stampedAssistant.content)).toBe(true);
            const blocks = stampedAssistant.content as { type: string; text?: string; id?: string; name?: string; input?: unknown; cache_control?: { type: string } }[];

            // All existing blocks are preserved: one text block + one tool_use block.
            expect(blocks.length).toBe(2);
            expect(blocks[0].type).toBe('text');
            expect(blocks[0].text).toBe('Let me roll.');
            expect(blocks[1].type).toBe('tool_use');
            expect(blocks[1].id).toBe('tc_1');
            expect(blocks[1].name).toBe('roll_dice');

            // Exactly ONE marker, on the FINAL emitted block (the tool_use block).
            const markers = blocks.filter(b => b.cache_control?.type === 'ephemeral');
            expect(markers.length).toBe(1);
            expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
            // The text block must NOT carry the marker (no duplication).
            expect(blocks[0].cache_control).toBeUndefined();
        });

        it('an unstamped final user message remains a plain, unmarked wire message', () => {
            const messages = [
                { role: 'system', content: 'Rules.', cache_control: cacheControlEphemeral },
                { role: 'user', content: 'User turn' },
                { role: 'assistant', content: 'GM reply', cache_control: cacheControlEphemeral },
                { role: 'user', content: 'Final volatile user message' },
            ];
            const body = buildChatBody(claudeProvider, messages, { stream: false });
            const conv = body.messages as { role: string; content: string | unknown[] }[];

            // The final user message is the last entry. It has no marker in the
            // assembled payload, so it must emit as a plain string (not an array
            // of content blocks) and contain no cache_control field.
            const finalUser = conv[conv.length - 1];
            expect(finalUser.role).toBe('user');
            expect(typeof finalUser.content).toBe('string');
            expect(finalUser.content).toBe('Final volatile user message');
        });

        it('an unstamped plain user message retains its plain-string representation (no array wrapping)', () => {
            // An unstamped user history message (not the final volatile one) must
            // keep the current plain-string shape — the cache_control propagation
            // only applies to messages that actually carry the marker.
            const messages = [
                { role: 'system', content: 'Rules.' },
                { role: 'user', content: 'Plain unstamped user turn' },
                { role: 'assistant', content: 'GM reply' },
            ];
            const body = buildChatBody(claudeProvider, messages, { stream: false });
            const conv = body.messages as { role: string; content: string | unknown[] }[];
            const unstampedUser = conv[0];
            expect(unstampedUser.role).toBe('user');
            expect(typeof unstampedUser.content).toBe('string');
            expect(unstampedUser.content).toBe('Plain unstamped user turn');
        });

        it('an unstamped plain assistant message retains its plain-string representation (no array wrapping)', () => {
            const messages = [
                { role: 'system', content: 'Rules.' },
                { role: 'user', content: 'User turn' },
                { role: 'assistant', content: 'Plain unstamped GM reply' },
            ];
            const body = buildChatBody(claudeProvider, messages, { stream: false });
            const conv = body.messages as { role: string; content: string | unknown[] }[];
            const unstampedAssistant = conv[1];
            expect(unstampedAssistant.role).toBe('assistant');
            expect(typeof unstampedAssistant.content).toBe('string');
            expect(unstampedAssistant.content).toBe('Plain unstamped GM reply');
        });
    });

    describe('§2 — end-to-end: a normal WO-09 payload (LOD + verbatim history) through buildChatBody', () => {
        // Build a normal WO-09 payload with LOD + surviving verbatim history,
        // then pass the assembled messages through buildChatBody with a Claude
        // provider and inspect the provider request body (not just the
        // pre-transform OpenAIMessage[]).

        function baseContext(): GameContext {
            return {
                loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
                starter: '', continuePrompt: '',
                inventory: '', inventoryLastScene: 'Never',
                characterProfile: '', characterProfileLastScene: 'Never',
                canonStateActive: false, headerIndexActive: false, starterActive: false,
                continuePromptActive: false, inventoryActive: false, characterProfileActive: false,
                surpriseEngineActive: false, encounterEngineActive: true, worldEngineActive: true,
                diceFairnessActive: true,
                sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
                worldVibe: '', notebook: [], notebookActive: false,
                worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
            } as unknown as GameContext;
        }

        function baseSettings(): AppSettings {
            return {
                debugMode: true, contextLimit: 8192,
                lodSummaryChapters: 7, lodImportanceBonus: 2,
            } as unknown as AppSettings;
        }

        function mkChapter(over: Partial<ArchiveChapter> & { chapterId: string }): ArchiveChapter {
            const sceneStart = over.chapterId.replace('CH', '').padStart(3, '0');
            return {
                title: `Chapter ${over.chapterId}`,
                sceneRange: [sceneStart, sceneStart],
                sceneIds: [sceneStart],
                summary: `Summary of ${over.chapterId}.`,
                keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
                tone: '', themes: [], sceneCount: 1, sealedAt: 1,
                ...over,
            } as ArchiveChapter;
        }

        function mkIndexEntry(sceneId: string): ArchiveIndexEntry {
            return {
                sceneId, timestamp: 0, keywords: [], npcsMentioned: [],
                witnesses: [], userSnippet: '',
            } as ArchiveIndexEntry;
        }

        it('the final fitted-history breakpoint survives in the Claude wire body; the final volatile user message is after it and unmarked; LOD is before the breakpoint', () => {
            const sealedChapters: ArchiveChapter[] = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'], summary: 'CH01 summary.', synopsis: 'CH01 synopsis.' }),
                mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'], summary: 'CH02 summary.', synopsis: 'CH02 synopsis.' }),
                mkChapter({ chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'], summary: 'CH03 summary.', synopsis: 'CH03 synopsis.' }),
            ];
            const archiveIndex: ArchiveIndexEntry[] = ['001', '002', '003', '004', '005', '006', '007', '008', '009'].map(s => mkIndexEntry(s));

            // 12 verbatim messages: scenes 001–012. Boundary at index 8 → 010–012 verbatim.
            const history: ChatMessage[] = [];
            for (let i = 1; i <= 12; i++) {
                const sceneId = String(i).padStart(3, '0');
                history.push({
                    id: `msg_${sceneId}`, role: 'assistant',
                    content: `GM reply in scene ${sceneId}.`, timestamp: 0, sceneId,
                } as ChatMessage);
            }

            const assembled = buildPayload({
                settings: baseSettings(),
                context: baseContext(),
                history: history,
                userMessage: 'I look around.',
                condensedUpToIndex: 8,
                archiveIndex: archiveIndex,
                chapters: sealedChapters,
                onStageNpcIds: ['npc_a'],
            });

            // Pass the assembled messages through buildChatBody with a Claude provider.
            const body = buildChatBody(claudeProvider, assembled.messages, { stream: false });
            const conv = body.messages as { role: string; content: string | { type: string; text?: string; cache_control?: { type: string } }[] }[];

            // Find the LOD system message (it is in the `system` blocks, not `conv`).
            // The system field is an array because at least the stable block carries cache_control.
            const systemBlocks = body.system as { type: string; text: string; cache_control?: { type: string } }[];
            const lodSystemBlock = systemBlocks.find(b => b.text.includes('[LOD HISTORY — CONDENSED CHAPTERS]'));
            expect(lodSystemBlock).toBeDefined();
            // The LOD block is in the cached prefix — its system block carries cache_control.
            // (The LOD system message itself may or may not be the breakpoint depending on
            // whether verbatim history survives after it; in this shape verbatim history
            // DOES survive, so the breakpoint lands on the last verbatim assistant message,
            // not on the LOD block. The LOD block is still in the cached prefix because the
            // breakpoint is AFTER it.)
            expect(lodSystemBlock!.cache_control).toBeUndefined(); // not the breakpoint — verbatim follows

            // Find the breakpoint in the conversation: the last block carrying cache_control.
            let breakpointConvIdx = -1;
            let breakpointBlockIdx = -1;
            for (let i = 0; i < conv.length; i++) {
                if (Array.isArray(conv[i].content)) {
                    const blocks = conv[i].content as { cache_control?: { type: string } }[];
                    for (let j = 0; j < blocks.length; j++) {
                        if (blocks[j].cache_control?.type === 'ephemeral') {
                            breakpointConvIdx = i;
                            breakpointBlockIdx = j;
                        }
                    }
                }
            }
            expect(breakpointConvIdx).toBeGreaterThan(-1);
            expect(breakpointBlockIdx).toBeGreaterThanOrEqual(0);

            // The breakpoint must be on a verbatim assistant message (not on the
            // LOD block, which is in the system field, and not on the final user
            // message, which rides below the cache boundary).
            expect(conv[breakpointConvIdx].role).toBe('assistant');

            // The final conversation entry must be the volatile user message,
            // and it must come AFTER the breakpoint.
            const finalIdx = conv.length - 1;
            expect(finalIdx).toBeGreaterThan(breakpointConvIdx);
            expect(conv[finalIdx].role).toBe('user');
            // The final user message must be a plain string (no array wrapping,
            // no cache_control).
            expect(typeof conv[finalIdx].content).toBe('string');
            expect((conv[finalIdx].content as string)).toContain('I look around');

            // The LOD content (in the system field) is BEFORE the breakpoint
            // (which is in the conversation). The system field is always
            // serialized before `messages` in the Claude request body, so this
            // is structurally guaranteed — we assert the LOD block exists in the
            // system field and the breakpoint exists in the conversation, which
            // together prove the LOD content is before the breakpoint.
            expect(lodSystemBlock).toBeDefined();
            expect(breakpointConvIdx).toBeGreaterThan(-1);
        });
    });
});
describe('service tier', () => {
    const messages = [{ role: 'user' as const, content: 'Hello' }];
    const nano: EndpointConfig = { endpoint: 'https://nano-gpt.com/api/v1', apiKey: 'k', modelName: 'openai/gpt-5.5', apiFormat: 'openai' };
    const router: EndpointConfig = { endpoint: 'https://openrouter.ai/api/v1', apiKey: 'k', modelName: 'openai/gpt-5.5', apiFormat: 'openrouter' };

    it('sends nothing when unset', () => {
        expect(buildChatBody(nano, messages).service_tier).toBeUndefined();
        expect(buildChatBody(router, messages).service_tier).toBeUndefined();
    });

    it('sends flex and fast to NanoGPT', () => {
        expect(buildChatBody({ ...nano, serviceTier: 'flex' }, messages).service_tier).toBe('flex');
        expect(buildChatBody({ ...nano, serviceTier: 'priority' }, messages).service_tier).toBe('fast');
    });

    it('sends flex and priority to OpenRouter, in either API format', () => {
        expect(buildChatBody({ ...router, serviceTier: 'flex' }, messages).service_tier).toBe('flex');
        expect(buildChatBody({ ...router, apiFormat: 'openai', serviceTier: 'priority' }, messages).service_tier).toBe('priority');
    });

    it('sends nothing to other hosts or formats', () => {
        expect(buildChatBody({ ...nano, endpoint: 'https://api.openai.com/v1', serviceTier: 'flex' }, messages).service_tier).toBeUndefined();
        expect(buildChatBody({ ...router, apiFormat: 'claude', serviceTier: 'flex' }, messages).service_tier).toBeUndefined();
    });
});
