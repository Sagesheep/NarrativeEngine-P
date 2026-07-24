/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DivergenceEntry, DivergenceRegister, ArchiveChapter } from '../../types';

vi.mock('../../components/Toast', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('../infrastructure/tokenizer', () => ({ countTokens: vi.fn(() => 100) }));

import { toast } from '../../components/Toast';
import {
    EMPTY_REGISTER,
    DIVERGENCE_CATEGORIES,
    CATEGORY_LABELS,
    CATEGORY_DEFINITIONS,
    coerceCategory,
    stripReasoning,
    mergeSealEntries,
    renderRegisterForPayload,
    mergeLifecycleEntries,
    getDivergenceSceneIds,
    toggleChapter,
    toggleCategory,
    pinFact,
    editFact,
    deleteFact,
    dismissReviewFlag,
    getEntriesForChapter,
    getEntriesForNpc,
    migrateV1ToV2,
    countRegisterTokens,
} from '../campaign-state/divergenceRegister';

function makeEntry(overrides: Partial<DivergenceEntry> = {}): DivergenceEntry {
    return {
        id: 'div_001',
        chapterId: 'CH01',
        category: 'locations',
        text: 'Eastern gate destroyed',
        sceneRef: '014',
        npcIds: [],
        pinned: false,
        source: 'auto',
        ...overrides,
    };
}

function makeRegister(overrides: Partial<DivergenceRegister> = {}): DivergenceRegister {
    return {
        entries: [],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: '',
        lastUpdatedAt: 0,
        version: 2,
        ...overrides,
    };
}

describe('divergenceRegister v2', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('EMPTY_REGISTER', () => {
        it('has version 2 and empty fields', () => {
            expect(EMPTY_REGISTER.version).toBe(2);
            expect(EMPTY_REGISTER.entries).toEqual([]);
            expect(EMPTY_REGISTER.chapterToggles).toEqual({});
            expect(EMPTY_REGISTER.categoryToggles).toEqual({});
        });
    });

    describe('DIVERGENCE_CATEGORIES', () => {
        it('has 7 categories', () => {
            expect(DIVERGENCE_CATEGORIES).toHaveLength(7);
            expect(DIVERGENCE_CATEGORIES).toContain('locations');
            expect(DIVERGENCE_CATEGORIES).toContain('npc_events');
            expect(DIVERGENCE_CATEGORIES).toContain('promises_debts');
            expect(DIVERGENCE_CATEGORIES).toContain('world_state');
            expect(DIVERGENCE_CATEGORIES).toContain('party_facts');
            expect(DIVERGENCE_CATEGORIES).toContain('rules_lore');
            expect(DIVERGENCE_CATEGORIES).toContain('misc');
        });
    });

    describe('coerceCategory', () => {
        it('returns valid categories as-is', () => {
            expect(coerceCategory('locations')).toBe('locations');
            expect(coerceCategory('npc_events')).toBe('npc_events');
            expect(coerceCategory('promises_debts')).toBe('promises_debts');
        });

        it('normalizes spacing and hyphens', () => {
            expect(coerceCategory('npc events')).toBe('npc_events');
            expect(coerceCategory('WORLD STATE')).toBe('world_state');
            expect(coerceCategory('promises-debts')).toBe('promises_debts');
        });

        it('falls back to misc for unknown', () => {
            expect(coerceCategory('canon_override')).toBe('misc');
            expect(coerceCategory('entity_state')).toBe('misc');
            expect(coerceCategory('obligation')).toBe('misc');
            expect(coerceCategory('')).toBe('misc');
        });
    });

    describe('stripReasoning', () => {
        it('removes think tags', () => {
            expect(stripReasoning('<think>reasoning</think>actual')).toBe('actual');
        });

        it('extracts markdown fence content', () => {
            expect(stripReasoning('```json\n{"a":1}\n```')).toBe('{"a":1}');
        });
    });

    describe('mergeSealEntries', () => {
        it('appends new entries to register', () => {
            const reg = makeRegister();
            const entries = [makeEntry({ id: 'div_new' })];
            const merged = mergeSealEntries(reg, entries, '025');
            expect(merged.entries).toHaveLength(1);
            expect(merged.entries[0].id).toBe('div_new');
            expect(merged.lastUpdatedSceneId).toBe('025');
        });

        it('returns register unchanged if no new entries', () => {
            const reg = makeRegister({ entries: [makeEntry()] });
            const merged = mergeSealEntries(reg, [], '025');
            expect(merged).toBe(reg);
        });

        it('preserves chapterToggles and categoryToggles', () => {
            const reg = makeRegister({ chapterToggles: { CH01: false }, categoryToggles: { CH01: { locations: false } } });
            const merged = mergeSealEntries(reg, [makeEntry()], '025');
            expect(merged.chapterToggles).toEqual({ CH01: false });
            expect(merged.categoryToggles).toEqual({ CH01: { locations: false } });
        });
    });

    describe('renderRegisterForPayload', () => {
    describe('mergeLifecycleEntries', () => {
        it('supersedes only an active, unpinned fact in the exact same state slot', () => {
            const previous = makeEntry({
                id: 'div_mira_key',
                text: 'Mira holds the Moon Key',
                stateKey: 'item:moon-key:holder',
            });
            const replacement = makeEntry({
                id: 'div_kaelen_key',
                text: 'Kaelen holds the Moon Key',
                stateKey: 'item:moon-key:holder',
                supersedesFactId: 'div_mira_key',
            });

            const merged = mergeLifecycleEntries(makeRegister({ entries: [previous] }), [replacement], '025');

            expect(merged.entries).toHaveLength(2);
            expect(merged.entries[0]).toMatchObject({ status: 'superseded', supersededBy: 'div_kaelen_key' });
            expect(merged.entries[1]).toMatchObject({ status: 'active', stateKey: 'item:moon-key:holder' });
            expect(merged.entries[1].supersedesFactId).toBeUndefined();
        });

        it('keeps an uncertain replacement additive', () => {
            const previous = makeEntry({
                id: 'div_mira_key',
                stateKey: 'item:moon-key:holder',
            });
            const replacement = makeEntry({
                id: 'div_other',
                stateKey: 'item:other-key:holder',
                supersedesFactId: 'div_mira_key',
            });

            const merged = mergeLifecycleEntries(makeRegister({ entries: [previous] }), [replacement], '025');

            expect(merged.entries[0].status).toBeUndefined();
            expect(merged.entries[1].status).toBe('active');
        });

        it('never automatically supersedes a pinned fact', () => {
            const previous = makeEntry({ id: 'div_pinned', pinned: true, stateKey: 'npc:npc_1:status' });
            const replacement = makeEntry({ id: 'div_new', stateKey: 'npc:npc_1:status', supersedesFactId: 'div_pinned' });

            const merged = mergeLifecycleEntries(makeRegister({ entries: [previous] }), [replacement], '025');

            expect(merged.entries[0].status).toBeUndefined();
            expect(merged.entries[1].status).toBe('active');
        });
    });
        it('returns empty string for empty register', () => {
            expect(renderRegisterForPayload(EMPTY_REGISTER)).toBe('');
        });

        it('renders with ESTABLISHED FACTS label', () => {
            const reg = makeRegister({ entries: [makeEntry()] });
            const text = renderRegisterForPayload(reg);
            expect(text).toContain('[ESTABLISHED FACTS]');
            expect(text).toContain('[END ESTABLISHED FACTS]');
            expect(text).toContain('Eastern gate destroyed');
        });

        it('uses chapter titles when chapters provided', () => {
            const reg = makeRegister({ entries: [makeEntry({ chapterId: 'CH01' })] });
            const chapters: ArchiveChapter[] = [{ chapterId: 'CH01', title: 'The Siege', sceneIds: [], sceneRange: ['001', '025'], summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 25 }];
            const text = renderRegisterForPayload(reg, chapters);
            expect(text).toContain('The Siege');
        });

        it('omits entries from toggled-off chapters (unless pinned)', () => {
            const reg = makeRegister({
                entries: [
                    makeEntry({ id: 'div_1', chapterId: 'CH01', pinned: false, text: 'hidden' }),
                    makeEntry({ id: 'div_2', chapterId: 'CH01', pinned: true, text: 'pinned fact' }),
                ],
                chapterToggles: { CH01: false },
            });
            const text = renderRegisterForPayload(reg);
            expect(text).not.toContain('hidden');
            expect(text).toContain('pinned fact');
        });

        it('omits entries from toggled-off categories', () => {
            const reg = makeRegister({
                entries: [
                    makeEntry({ id: 'div_1', category: 'locations', text: 'loc fact' }),
                    makeEntry({ id: 'div_2', category: 'npc_events', text: 'npc fact' }),
                ],
                categoryToggles: { CH01: { locations: false } },
            });
            const text = renderRegisterForPayload(reg);
            expect(text).not.toContain('loc fact');
            expect(text).toContain('npc fact');
        });

        it('marks pinned entries with star and manual with lightning', () => {
            const reg = makeRegister({
                entries: [
                    makeEntry({ id: 'div_1', pinned: true, text: 'pinned entry' }),
                    makeEntry({ id: 'div_2', source: 'manual', text: 'manual entry' }),
                ],
            });
            const text = renderRegisterForPayload(reg);
            expect(text).toContain('★');
            expect(text).toContain('⚡');
        });
    });

    describe('toggleChapter', () => {
        it('sets chapter toggle to off', () => {
            const reg = makeRegister();
            const toggled = toggleChapter(reg, 'CH01', false);
            expect(toggled.chapterToggles['CH01']).toBe(false);
        });

        it('sets chapter toggle back to on', () => {
            const reg = makeRegister({ chapterToggles: { CH01: false } });
            const toggled = toggleChapter(reg, 'CH01', true);
            expect(toggled.chapterToggles['CH01']).toBe(true);
        });
    });

    describe('toggleCategory', () => {
        it('toggles a specific category within a chapter', () => {
            const reg = makeRegister();
            const toggled = toggleCategory(reg, 'CH01', 'locations', false);
            expect(toggled.categoryToggles['CH01']?.locations).toBe(false);
        });

        it('preserves other category toggles', () => {
            const reg = makeRegister({ categoryToggles: { CH01: { npc_events: false } } });
            const toggled = toggleCategory(reg, 'CH01', 'locations', false);
            expect(toggled.categoryToggles['CH01']?.npc_events).toBe(false);
            expect(toggled.categoryToggles['CH01']?.locations).toBe(false);
        });
    });

    describe('pinFact', () => {
        it('toggles pinned state', () => {
            const reg = makeRegister({ entries: [makeEntry({ id: 'div_1', pinned: false })] });
            const pinned = pinFact(reg, 'div_1');
            expect(pinned.entries[0].pinned).toBe(true);
            const unpinned = pinFact(pinned, 'div_1');
            expect(unpinned.entries[0].pinned).toBe(false);
        });
    });

    describe('editFact', () => {
        it('updates text and sets source to manual', () => {
            const reg = makeRegister({ entries: [makeEntry({ id: 'div_1', text: 'old text', source: 'auto' })] });
            const edited = editFact(reg, 'div_1', 'new text');
            expect(edited.entries[0].text).toBe('new text');
            expect(edited.entries[0].source).toBe('manual');
        });
    });

    describe('deleteFact', () => {
        it('removes the entry', () => {
            const reg = makeRegister({ entries: [makeEntry({ id: 'div_1' }), makeEntry({ id: 'div_2' })] });
            const deleted = deleteFact(reg, 'div_1');
            expect(deleted.entries).toHaveLength(1);
            expect(deleted.entries[0].id).toBe('div_2');
        });
    });

    describe('dismissReviewFlag', () => {
        it('clears reviewFlag and unrecognizedNpcNames', () => {
            const reg = makeRegister({ entries: [makeEntry({ id: 'div_1', reviewFlag: true, unrecognizedNpcNames: ['Bob'] })] });
            const dismissed = dismissReviewFlag(reg, 'div_1');
            expect(dismissed.entries[0].reviewFlag).toBeUndefined();
            expect(dismissed.entries[0].unrecognizedNpcNames).toBeUndefined();
        });
    });

    describe('getEntriesForChapter', () => {
        it('filters by chapterId', () => {
            const reg = makeRegister({
                entries: [
                    makeEntry({ id: 'div_1', chapterId: 'CH01' }),
                    makeEntry({ id: 'div_2', chapterId: 'CH02' }),
                ],
            });
            expect(getEntriesForChapter(reg, 'CH01')).toHaveLength(1);
            expect(getEntriesForChapter(reg, 'CH01')[0].id).toBe('div_1');
        });
    });

    describe('getEntriesForNpc', () => {
        it('filters entries containing npcId', () => {
            const reg = makeRegister({
                entries: [
                    makeEntry({ id: 'div_1', npcIds: ['npc_42'] }),
                    makeEntry({ id: 'div_2', npcIds: ['npc_99'] }),
                ],
            });
            expect(getEntriesForNpc(reg, 'npc_42')).toHaveLength(1);
            expect(getEntriesForNpc(reg, 'npc_42')[0].id).toBe('div_1');
        });
    });

    describe('getDivergenceSceneIds', () => {
        it('collects scene refs from all entries', () => {
            const reg = makeRegister({
                entries: [
                    makeEntry({ sceneRef: '014' }),
                    makeEntry({ sceneRef: '018' }),
                ],
            });
            expect(getDivergenceSceneIds(reg)).toEqual(new Set(['014', '018']));
        });
    });

    describe('migrateV1ToV2', () => {
        it('wipes entries and returns v2 register', () => {
            const v1 = {
                entries: [{ id: 'div_old', category: 'canon_override', subject: 'x' } as any],
                lastUpdatedSceneId: '010',
                lastUpdatedAt: 12345,
                version: 1,
            };
            const result = migrateV1ToV2(v1);
            expect(result.version).toBe(2);
            expect(result.entries).toEqual([]);
            expect(result.chapterToggles).toEqual({});
            expect(result.categoryToggles).toEqual({});
            expect(result.lastUpdatedSceneId).toBe('010');
            expect(toast.info).toHaveBeenCalled();
        });

        it('handles missing v1 fields', () => {
            const result = migrateV1ToV2({ entries: [], version: 1 });
            expect(result.version).toBe(2);
            expect(result.entries).toEqual([]);
        });
    });

    describe('countRegisterTokens', () => {
        it('returns token count for rendered payload', () => {
            const reg = makeRegister({ entries: [makeEntry()] });
            expect(countRegisterTokens(reg)).toBe(100); // mocked
        });
    });

    describe('CATEGORY_LABELS', () => {
        it('has label for every category', () => {
            for (const cat of DIVERGENCE_CATEGORIES) {
                expect(CATEGORY_LABELS[cat]).toBeTruthy();
            }
        });
    });

    describe('CATEGORY_DEFINITIONS', () => {
        it('has definition for every category', () => {
            for (const cat of DIVERGENCE_CATEGORIES) {
                expect(CATEGORY_DEFINITIONS[cat]).toBeTruthy();
            }
        });
    });
});