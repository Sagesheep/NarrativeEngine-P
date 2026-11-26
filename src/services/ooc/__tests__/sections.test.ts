import { describe, expect, it, afterEach } from 'vitest';
import { buildOocContext } from '../context';
import { createOocSectionRegistry, oocSections, type OocSection } from '../sections';
import type { OocCampaignSnapshot } from '../types';

/**
 * Phase 7.5 — the OOC section registry (`ROLES.md` §7.1, "thread that tears #1").
 *
 * The Ask-GM brief is a second prompt-assembly path that the contribution
 * registry never reached, and it rendered the enemy sections inline. When the
 * subsystem leaves, the brief must lose those sections *quietly and completely*
 * — not half-render, not throw, and not leave a dead `OocSourceKind` member
 * behind. These tests hold both halves: the registry's contract, and the brief
 * with nothing registered.
 */

const snapshot = (): OocCampaignSnapshot => ({
    campaignId: 'campaign-1',
    provider: undefined,
    messages: [],
    semanticFacts: [],
    loreChunks: [],
    archiveIndex: [],
    npcLedger: [],
    locationLedger: [],
    context: {
        canonStateActive: false, canonState: '', sceneNoteActive: false, sceneNote: '',
        currentFeature: null, worldVibe: '', notebookActive: false, notebook: [],
        inventoryItems: [],
    },
} as unknown as OocCampaignSnapshot);

const section = (id: string, order: number, line: string): OocSection => ({
    id,
    order,
    build: () => ({ lines: [line], sources: [{ kind: id, id, label: id, excerpt: line }] }),
});

describe('Phase 7.5 — the OOC brief survives an empty registry', () => {
    const registered: string[] = [];
    afterEach(() => {
        for (const id of registered.splice(0)) oocSections.unregister(id);
    });

    it('renders a complete brief with no sections registered', () => {
        // The production registry is populated by whatever imported a
        // subsystem; empty it for this assertion and put it back afterwards.
        const saved = oocSections.list();
        for (const s of saved) oocSections.unregister(s.id);
        try {
            const result = buildOocContext(snapshot(), 'What is going on?');
            expect(result.text).toContain('CAMPAIGN FACTS (read-only data):');
            expect(result.sources).toEqual([]);
            // Nothing threw, nothing half-rendered, and no placeholder was left
            // where the sections used to be.
            expect(result.text).not.toContain('undefined');
            expect(result.text).not.toContain('Enemy records');
        } finally {
            for (const s of saved) oocSections.register(s);
        }
    });

    it('splices registered sections between the ledgers and the verified facts', () => {
        const saved = oocSections.list();
        for (const s of saved) oocSections.unregister(s.id);
        try {
            oocSections.register(section('probe', 100, 'PROBE LINE'));
            registered.push('probe');
            const withNpc = snapshot();
            (withNpc as { npcLedger: unknown[] }).npcLedger = [
                { id: 'n1', name: 'Ariadne', aliases: '', archived: false },
            ];
            (withNpc as { semanticFacts: unknown[] }).semanticFacts = [
                { id: 'f1', subject: 'Ariadne', predicate: 'is', object: 'a smith', importance: 5 },
            ];
            const result = buildOocContext(withNpc, 'Tell me about Ariadne.');
            const text = result.text;
            expect(text.indexOf('Known characters')).toBeGreaterThan(-1);
            expect(text.indexOf('PROBE LINE')).toBeGreaterThan(text.indexOf('Known characters'));
            expect(text.indexOf('Verified campaign facts')).toBeGreaterThan(text.indexOf('PROBE LINE'));
        } finally {
            for (const s of saved) oocSections.register(s);
        }
    });
});

describe('Phase 7.5 — the OOC section registry contract', () => {
    it('orders sections by `order`, ties by registration index', () => {
        const registry = createOocSectionRegistry();
        registry.register(section('late', 200, 'LATE'));
        registry.register(section('b', 100, 'B'));
        registry.register(section('a', 100, 'A'));
        const collected = registry.collect({
            snapshot: snapshot(), question: '', recentText: '',
            excerpt: (v) => v, namedIn: () => false,
        });
        expect(collected.flatMap((o) => o.lines)).toEqual(['B', 'A', 'LATE']);
    });

    it('a section that throws is skipped and the rest still render', () => {
        const registry = createOocSectionRegistry();
        registry.register({ id: 'boom', order: 100, build: () => { throw new Error('boom'); } });
        registry.register(section('fine', 200, 'FINE'));
        const collected = registry.collect({
            snapshot: snapshot(), question: '', recentText: '',
            excerpt: (v) => v, namedIn: () => false,
        });
        expect(collected.flatMap((o) => o.lines)).toEqual(['FINE']);
    });

    it('a section with nothing to say contributes nothing', () => {
        const registry = createOocSectionRegistry();
        registry.register({ id: 'quiet', order: 100, build: () => ({ lines: [], sources: [] }) });
        registry.register({ id: 'null', order: 200, build: () => null });
        expect(registry.collect({
            snapshot: snapshot(), question: '', recentText: '',
            excerpt: (v) => v, namedIn: () => false,
        })).toEqual([]);
    });

    it('rejects a duplicate id — always a packaging bug', () => {
        const registry = createOocSectionRegistry();
        registry.register(section('dup', 100, 'X'));
        expect(() => registry.register(section('dup', 200, 'Y'))).toThrow(/duplicate section id/);
    });

    it('unregister removes the section and its output', () => {
        const registry = createOocSectionRegistry();
        registry.register(section('temp', 100, 'TEMP'));
        expect(registry.unregister('temp')).toBe(true);
        expect(registry.unregister('temp')).toBe(false);
        expect(registry.collect({
            snapshot: snapshot(), question: '', recentText: '',
            excerpt: (v) => v, namedIn: () => false,
        })).toEqual([]);
    });
});
