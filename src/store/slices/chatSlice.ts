import type { StateCreator } from 'zustand';
import type { ArchiveIndexEntry, ChatMessage, CondenserState, GameContext, DivergenceRegister, DivergenceEntry, DivergenceCategory, TopicClusters, PinnedExcerpt } from '../../types';
import { debouncedSaveCampaignState } from './campaignSlice';
import { uid } from '../../utils/uid';
import { countTokens } from '../../services/infrastructure/tokenizer';

const PINNED_EXCERPTS_TOKEN_CAP = 3000;

// WO-J (8879041): the lore-check / rename selection is captured from the RENDERED bubble
// text, which has markdown stripped and NPC name brackets removed. The stored content
// still holds raw markdown, so a literal `content.includes(selectedText)` misses whenever
// the span contains formatting. locateRawSpan normalises the raw content the same way the
// renderer does (drop * _ ` # [ ] and collapse whitespace) while keeping an index map back
// to raw offsets, so we can find and splice the real span even when it was formatted.
const MD_MARKER = /[*_`[\]#]/;

function normalizeWithMap(raw: string): { norm: string; start: number[]; end: number[] } {
    const norm: string[] = [];
    const start: number[] = [];
    const end: number[] = [];
    let i = 0;
    while (i < raw.length) {
        const c = raw[i];
        if (/\s/.test(c)) {
            const runStart = i;
            while (i < raw.length && /\s/.test(raw[i])) i++;
            norm.push(' ');
            start.push(runStart);
            end.push(i);
            continue;
        }
        if (MD_MARKER.test(c)) { i++; continue; }
        norm.push(c);
        start.push(i);
        end.push(i + 1);
        i++;
    }
    return { norm: norm.join(''), start, end };
}

function normalizeLoose(s: string): string {
    return s.replace(/[*_`[\]#]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the raw [start, end) span in `raw` corresponding to `target`, tolerating the
 * markdown/bracket/whitespace differences introduced by rendering. Returns null if
 * the target can't be located even loosely (e.g. the text was already edited away).
 */
export function locateRawSpan(raw: string, target: string): { start: number; end: number } | null {
    if (!target) return null;
    const exact = raw.indexOf(target);
    if (exact !== -1) return { start: exact, end: exact + target.length };

    const targetNorm = normalizeLoose(target);
    if (!targetNorm) return null;

    const { norm, start, end } = normalizeWithMap(raw);
    const idx = norm.indexOf(targetNorm);
    if (idx === -1) return null;

    let s = start[idx];
    let e = end[idx + targetNorm.length - 1];
    // Swallow markdown markers that hug the span but were dropped during normalisation
    // (e.g. the leading "[**" of an NPC name), so they aren't orphaned after splicing.
    while (s > 0 && MD_MARKER.test(raw[s - 1])) s--;
    while (e < raw.length && MD_MARKER.test(raw[e])) e++;
    return { start: s, end: e };
}

// ── Slice type ─────────────────────────────────────────────────────────

export type ChatSlice = {
    messages: ChatMessage[];
    isStreaming: boolean;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    /**
     * Patches the LAST assistant message (scanning back from the tail, so a
     * trailing tool / system message doesn't intercept the patch). Use this
     * instead of `updateLastMessage` whenever the caller intends to stamp
     * state on the assistant bubble that produced the turn — e.g. swipeSet,
     * pendingCommit, sceneId, reasoning_content, tool_calls. The literal
     * `updateLastMessage` operates on `messages[length-1]`, which after a
     * tool call is the tool message (desktop reuses the same assistant id
     * across tool iterations instead of pushing a fresh bubble per call like
     * mobile does), causing the swipe set + pendingCommit to land on the
     * tool message and the swipe UI to silently disappear.
     */
    updateLastAssistantMessage: (patch: Partial<ChatMessage>) => void;
    updateMessageContent: (id: string, content: string) => void;
    /** Returns true if the span was located and spliced; false if the original text could not be found. */
    replaceMessageText: (messageId: string, oldText: string, newText: string) => boolean;
    deleteMessage: (id: string) => void;
    deleteMessagesFrom: (id: string) => void;
    setStreaming: (v: boolean) => void;
    clearChat: () => void;
    clearArchive: () => void;

    condenser: CondenserState;
    setCondensed: (upToIndex: number) => void;
    resetCondenser: () => void;
    setCondenser: (state: CondenserState) => void;

    divergenceRegister: DivergenceRegister;
    setDivergenceRegister: (register: DivergenceRegister) => void;
    toggleDivergenceChapter: (chapterId: string, on: boolean) => void;
    toggleDivergenceCategory: (chapterId: string, category: DivergenceCategory, on: boolean) => void;
    pinDivergenceFact: (entryId: string) => void;
    editDivergenceFact: (entryId: string, text: string) => void;
    /** Set who knows a fact. undefined = public, [] = secret, tokens = scoped. */
    editDivergenceKnownBy: (entryId: string, knownBy: string[] | undefined) => void;
    /** Apply non-destructive subjectToken updates from Find-Similarity clustering. */
    applySubjectTokens: (updates: Array<{ id: string; subjectToken: string }>) => void;
    deleteDivergenceFact: (entryId: string) => void;
    addDivergenceEntry: (entry: DivergenceEntry) => void;
    dismissDivergenceReviewFlag: (entryId: string) => void;
    confirmReviewEntry: (id: string) => void;
    toggleDivergenceFact: (factId: string) => void;
    deleteDivergenceChapter: (sceneId: string) => void;
    resetDivergenceRegister: () => void;
    updateMessageDivergence: (messageId: string, divergenceIds: string[]) => void;
    deleteReviewedEntry: (id: string) => void;
    setTopicClusters: (clusters: TopicClusters) => void;
    setManyFactsEnabled: (updates: Array<{ id: string; enabled: boolean }>) => void;

    pinnedExcerpts: PinnedExcerpt[];
    addPinnedExcerpt: (sourceMessageId: string, text: string, isFullMessage: boolean) => { ok: true } | { ok: false; reason: string };
    removePinnedExcerpt: (id: string) => void;
    clearPinnedExcerpts: () => void;

    renameModalOpen: boolean;
    renameModalText: string;
    openRenameModal: (text: string) => void;
    closeRenameModal: () => void;
    renameAcrossMessages: (from: string, to: string) => number;
    /**
     * First-name-only rename on the LATEST assistant message. Replaces the leading
     * token of `from` (e.g. "Pell" from "Pell Gravatt") with the leading token of
     * `to` in the most recent GM narration only. Whole-word, case-insensitive.
     * Returns 1 if the last assistant message was touched, 0 otherwise. Single-token
     * `from` (no surname) returns 0 — full-name tier already handles that case.
     */
    renameFirstNameInLatestAssistant: (from: string, to: string) => number;
    // Inline Scene Image V1 attachment actions
    addMessageAttachment: (messageId: string, attachment: import('../../types').SceneImageAttachment) => void;
    updateMessageAttachment: (messageId: string, attachmentId: string, patch: Partial<import('../../types').SceneImageAttachment>) => void;
    deleteMessageAttachment: (messageId: string, attachmentId: string) => void;
};

// ── Cross-slice dependencies ───────────────────────────────────────────

type ChatDeps = ChatSlice & {
    activeCampaignId: string | null;
    context: GameContext;
    archiveIndex: ArchiveIndexEntry[];
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createChatSlice: StateCreator<ChatDeps, [], [], ChatSlice> = (set) => ({
    // Condenser defaults
    condenser: {
        condensedUpToIndex: -1,
    },
    setCondensed: (upToIndex) =>
        set((s) => {
            const newCondenser = { ...s.condenser, condensedUpToIndex: upToIndex };
            debouncedSaveCampaignState();
            return { condenser: newCondenser };
        }),
    resetCondenser: () =>
        set(() => {
            const newCondenser = { condensedUpToIndex: -1 };
            debouncedSaveCampaignState();
            return { condenser: newCondenser };
        }),
    setCondenser: (state) =>
        set(() => {
            debouncedSaveCampaignState();
            return { condenser: state };
        }),

    divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
    setDivergenceRegister: (register) =>
        set(() => {
            debouncedSaveCampaignState();
            return { divergenceRegister: register };
        }),
    toggleDivergenceChapter: (chapterId, on) =>
        set((s) => {
            const chapterToggles = { ...s.divergenceRegister.chapterToggles, [chapterId]: on };
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, chapterToggles, lastUpdatedAt: Date.now() } };
        }),
    toggleDivergenceCategory: (chapterId, category, on) => {
        set((s) => {
            const existing = s.divergenceRegister.categoryToggles[chapterId] ?? {};
            const categoryToggles = {
                ...s.divergenceRegister.categoryToggles,
                [chapterId]: { ...existing, [category]: on },
            };
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, categoryToggles, lastUpdatedAt: Date.now() } };
        });
    },
    pinDivergenceFact: (entryId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === entryId ? { ...e, pinned: !e.pinned } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    editDivergenceFact: (entryId, text) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === entryId ? { ...e, text, source: 'manual' as const } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    editDivergenceKnownBy: (entryId, knownBy) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === entryId ? { ...e, knownBy } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    applySubjectTokens: (updates) =>
        set((s) => {
            if (updates.length === 0) return {};
            const updateMap = new Map(updates.map(u => [u.id, u.subjectToken]));
            const entries = s.divergenceRegister.entries.map(e => {
                const tok = updateMap.get(e.id);
                return tok !== undefined ? { ...e, subjectToken: tok } : e;
            });
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    deleteDivergenceFact: (entryId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.filter(e => e.id !== entryId);
            let topicClusters = s.divergenceRegister.topicClusters;
            if (topicClusters) {
                const groups = topicClusters.groups.map(g => ({
                    ...g,
                    factIds: g.factIds.filter(id => id !== entryId),
                })).filter(g => g.factIds.length > 0);
                topicClusters = { ...topicClusters, groups };
            }
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, topicClusters, lastUpdatedAt: Date.now() } };
        }),
    addDivergenceEntry: (entry) =>
        set((s) => {
            const entries = [...s.divergenceRegister.entries, entry];
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    dismissDivergenceReviewFlag: (entryId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === entryId ? { ...e, reviewFlag: undefined, unrecognizedNpcNames: undefined } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    confirmReviewEntry: (id) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === id ? { ...e, reviewFlag: undefined, unrecognizedNpcNames: undefined } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    toggleDivergenceFact: (factId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === factId ? { ...e, enabled: !(e.enabled !== false) } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    deleteDivergenceChapter: (sceneId) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.filter(
                e => e.sceneRef !== sceneId || e.source === 'manual'
            );
            const chapterToggles = { ...s.divergenceRegister.chapterToggles };
            delete chapterToggles[sceneId];
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, chapterToggles, lastUpdatedAt: Date.now() } };
        }),
    resetDivergenceRegister: () =>
        set(() => {
            debouncedSaveCampaignState();
            return { divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: Date.now(), version: 2 } };
        }),
    updateMessageDivergence: (messageId, divergenceIds) =>
        set((s) => {
            const messages = s.messages.map(msg =>
                msg.id === messageId ? { ...msg, divergenceIds } : msg
            );
            debouncedSaveCampaignState();
            return { messages };
        }),
    deleteReviewedEntry: (id) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.filter(e => e.id !== id);
            const prunedLog = (s.divergenceRegister.prunedLog ?? []).filter(e => e.id !== id);
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, prunedLog, lastUpdatedAt: Date.now() } };
        }),
    setTopicClusters: (clusters) =>
        set((s) => {
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, topicClusters: clusters, lastUpdatedAt: Date.now() } };
        }),
    setManyFactsEnabled: (updates) =>
        set((s) => {
            const updateMap = new Map(updates.map(u => [u.id, u.enabled]));
            const entries = s.divergenceRegister.entries.map(e => {
                const enabled = updateMap.get(e.id);
                return enabled !== undefined ? { ...e, enabled } : e;
            });
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),

    // Chat defaults
    messages: [],
    isStreaming: false,
    addMessage: (msg) =>
        set((s) => ({ messages: [...s.messages, msg] })),
    updateLastAssistant: (content) =>
        set((s) => {
            const msgs = [...s.messages];
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') {
                    msgs[i] = { ...msgs[i], content };
                    return { messages: msgs };
                }
            }
            return { messages: msgs };
        }),
    updateLastMessage: (patch) =>
        set((s) => {
            const msgs = [...s.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0) {
                msgs[lastIdx] = { ...msgs[lastIdx], ...patch };
            }
            return { messages: msgs };
        }),
    updateLastAssistantMessage: (patch) =>
        set((s) => {
            const msgs = [...s.messages];
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') {
                    msgs[i] = { ...msgs[i], ...patch };
                    return { messages: msgs };
                }
            }
            return { messages: msgs };
        }),
    updateMessageContent: (id, content) =>
        set((s) => {
            const msgs = s.messages.map(m => m.id === id ? { ...m, content } : m);
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    replaceMessageText: (messageId, oldText, newText) => {
        let applied = false;
        set((s) => {
            const msgs = s.messages.map(msg => {
                if (msg.id !== messageId) return msg;
                const next = { ...msg };
                if (typeof msg.content === 'string') {
                    const span = locateRawSpan(msg.content, oldText);
                    if (span) {
                        next.content = msg.content.slice(0, span.start) + newText + msg.content.slice(span.end);
                        applied = true;
                    }
                }
                if (typeof msg.displayContent === 'string') {
                    const span = locateRawSpan(msg.displayContent, oldText);
                    if (span) {
                        next.displayContent = msg.displayContent.slice(0, span.start) + newText + msg.displayContent.slice(span.end);
                        applied = true;
                    }
                }
                return next;
            });
            if (!applied) return {};
            debouncedSaveCampaignState();
            return { messages: msgs };
        });
        return applied;
    },
    deleteMessage: (id) =>
        set((s) => {
            const msgs = s.messages.filter(m => m.id !== id);
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    deleteMessagesFrom: (id) =>
        set((s) => {
            const index = s.messages.findIndex(m => m.id === id);
            if (index === -1) return { messages: s.messages };
            const msgs = s.messages.slice(0, index);
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    setStreaming: (v) => set({ isStreaming: v } as Partial<ChatDeps>),
    clearChat: () => set((_s) => {
        const newCondenser = { condensedUpToIndex: -1 };
        const newDivReg = { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 };
        debouncedSaveCampaignState();
        return { messages: [], condenser: newCondenser, divergenceRegister: newDivReg, context: { ..._s.context, notebook: [] } } as Partial<ChatDeps>;
    }),
    clearArchive: () => set({ archiveIndex: [] } as Partial<ChatDeps>),

    pinnedExcerpts: [],
    addPinnedExcerpt: (sourceMessageId, text, isFullMessage) => {
        let result: { ok: true } | { ok: false; reason: string } = { ok: true };
        set((s) => {
            const newTokens = countTokens(text);
            const currentTotal = s.pinnedExcerpts.reduce((sum, e) => sum + countTokens(e.text), 0);
            if (currentTotal + newTokens > PINNED_EXCERPTS_TOKEN_CAP) {
                result = { ok: false, reason: 'Pinned memories full — unpin something first' };
                return s;
            }
            const excerpt: PinnedExcerpt = {
                id: `pin_${uid()}`,
                sourceMessageId,
                text,
                createdAt: Date.now(),
                isFullMessage,
            };
            const pinnedExcerpts = [...s.pinnedExcerpts, excerpt];
            debouncedSaveCampaignState();
            return { pinnedExcerpts };
        });
        return result;
    },
    removePinnedExcerpt: (id) =>
        set((s) => {
            const pinnedExcerpts = s.pinnedExcerpts.filter(e => e.id !== id);
            debouncedSaveCampaignState();
            return { pinnedExcerpts };
        }),
    clearPinnedExcerpts: () =>
        set(() => {
            debouncedSaveCampaignState();
            return { pinnedExcerpts: [] };
        }),

    renameModalOpen: false,
    renameModalText: '',
    openRenameModal: (text) => set({ renameModalOpen: true, renameModalText: text }),
    closeRenameModal: () => set({ renameModalOpen: false, renameModalText: '' }),
    renameAcrossMessages: (from, to) => {
        const fromTrim = from.trim();
        if (!fromTrim || !to.trim()) return 0;
        const pat = `\\b${fromTrim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        let changed = 0;
        set((s) => {
            const msgs = s.messages.map(m => {
                const next = { ...m };
                let touched = false;
                if (typeof m.content === 'string') {
                    const rep = m.content.replace(new RegExp(pat, 'gi'), to);
                    if (rep !== m.content) { next.content = rep; touched = true; }
                }
                if (typeof m.displayContent === 'string') {
                    const rep = m.displayContent.replace(new RegExp(pat, 'gi'), to);
                    if (rep !== m.displayContent) { next.displayContent = rep; touched = true; }
                }
                if (touched) changed++;
                return next;
            });
            if (changed === 0) return {};
            debouncedSaveCampaignState();
            return { messages: msgs };
        });
        return changed;
    },
    renameFirstNameInLatestAssistant: (from, to) => {
        const fromTrim = from.trim();
        const toTrim = to.trim();
        if (!fromTrim || !toTrim) return 0;
        const firstName = fromTrim.split(/\s+/)[0];
        const replacement = toTrim.split(/\s+/)[0];
        // Single-token `from` has no separate first-name tier — the full-name
        // pass (renameAcrossMessages) already covered it.
        if (!firstName || !replacement || fromTrim.split(/\s+/).length === 1) return 0;
        const pat = `\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
        let changed = 0;
        set((s) => {
            // Find the LAST assistant message (not messages[length-1] — that may be
            // a trailing system message).
            let lastIdx = -1;
            for (let i = s.messages.length - 1; i >= 0; i--) {
                if (s.messages[i].role === 'assistant') { lastIdx = i; break; }
            }
            if (lastIdx === -1) return {};
            const m = s.messages[lastIdx];
            const next = { ...m };
            let touched = false;
            if (typeof m.content === 'string') {
                const rep = m.content.replace(new RegExp(pat, 'gi'), replacement);
                if (rep !== m.content) { next.content = rep; touched = true; }
            }
            if (typeof m.displayContent === 'string') {
                const rep = m.displayContent.replace(new RegExp(pat, 'gi'), replacement);
                if (rep !== m.displayContent) { next.displayContent = rep; touched = true; }
            }
            if (!touched) return {};
            const msgs = s.messages.slice();
            msgs[lastIdx] = next;
            changed = 1;
            debouncedSaveCampaignState();
            return { messages: msgs };
        });
        return changed;
    },
    addMessageAttachment: (messageId, attachment) =>
        set((s) => {
            const messages = s.messages.map(m => {
                if (m.id !== messageId) return m;
                const existing = m.attachments ?? [];
                // Deduplicate by attachment id
                const filtered = existing.filter(a => a.id !== attachment.id);
                return { ...m, attachments: [...filtered, attachment] };
            });
            debouncedSaveCampaignState();
            return { messages };
        }),
    updateMessageAttachment: (messageId, attachmentId, patch) =>
        set((s) => {
            const messages = s.messages.map(m => {
                if (m.id !== messageId || !m.attachments) return m;
                const attachments = m.attachments.map(a =>
                    a.id === attachmentId ? { ...a, ...patch } : a
                );
                return { ...m, attachments };
            });
            debouncedSaveCampaignState();
            return { messages };
        }),
    deleteMessageAttachment: (messageId, attachmentId) =>
        set((s) => {
            const messages = s.messages.map(m => {
                if (m.id !== messageId || !m.attachments) return m;
                const attachments = m.attachments.filter(a => a.id !== attachmentId);
                return { ...m, attachments };
            });
            debouncedSaveCampaignState();
            return { messages };
        }),
});