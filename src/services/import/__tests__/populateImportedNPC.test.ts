import { describe, it, expect } from 'vitest';
import { populateImportedNPC } from '../populateImportedNPC';
import { deriveKeywordHex, KEYWORD_AXIS_TABLE } from '../keywordHex';
import { WANT_POOL } from '../../npc/agency/agencyPools';
import { RUNG_DEFAULT } from '../../npc/agency/agencyConstants';
import type { STCard } from '../stCardTypes';
import type { HexAxis, NPCEntry } from '../../../types';

// A tiny deterministic LCG (numerical recipes constants) so every assertion below is
// reproducible — the modules under test take `rng` precisely so tests never roll dice.
function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

const AXES: HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

function card(over: Partial<STCard> = {}): STCard {
    return {
        name: 'Aria',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        alternate_greetings: [],
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: '',
        creator_notes: '',
        spec: 'v2',
        ...over,
    };
}

function npc(over: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'npc-1',
        name: 'Aria',
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: 'Aria — imported character',
        disposition: '',
        status: 'Alive',
        goals: '',
        voice: '',
        personality: 'Shy but kind.',
        exampleOutput: '',
        affinity: 50,
        tier: 'recurring',
        condition: 'healthy',
        ...over,
    };
}

describe('deriveKeywordHex (WO-C §3.4)', () => {
    it('nudges the axes the keywords name', () => {
        const { hex, hitAxes } = deriveKeywordHex(['shy, kind', ''], lcg(1));
        expect(hex.boldness).toBeLessThan(0);
        expect(hex.warmth).toBeGreaterThan(0);
        expect(hex.empathy).toBeGreaterThan(0);
        expect(hitAxes).toContain('boldness');
        expect(hitAxes).toContain('warmth');
        expect(hitAxes).not.toContain('diligence');
    });

    it('is case-insensitive and matches whole words only', () => {
        expect(deriveKeywordHex(['LAZY'], lcg(2)).hex.diligence).toBe(-2);
        // "lazybones" must not trip the `lazy` rule — that axis falls back to the roll.
        expect(deriveKeywordHex(['lazybones'], lcg(2)).hitAxes).not.toContain('diligence');
    });

    it('reads tags as well as personality, and counts a repeated keyword once', () => {
        const fromTag = deriveKeywordHex(['', 'ambitious scheming'], lcg(3)).hex;
        expect(fromTag.drive).toBe(2);
        // `ambitious` present in BOTH scanned texts still contributes +2, not +4.
        const twice = deriveKeywordHex(['ambitious', 'ambitious'], lcg(3)).hex;
        expect(twice.drive).toBe(2);
    });

    it('clamps every axis to -3..+3', () => {
        const piled = 'kind gentle caring compassionate nurturing friendly warm loyal cheerful';
        const cruel = 'cruel sadistic yandere arrogant manipulative';
        const warmHex = deriveKeywordHex([piled], lcg(4)).hex;
        const coldHex = deriveKeywordHex([cruel], lcg(4)).hex;
        expect(warmHex.warmth).toBe(3);   // raw sum is +7
        expect(warmHex.empathy).toBe(3);  // raw sum is +3
        expect(coldHex.empathy).toBe(-3); // raw sum is -6
        for (const axis of AXES) {
            expect(warmHex[axis]).toBeGreaterThanOrEqual(-3);
            expect(warmHex[axis]).toBeLessThanOrEqual(3);
            expect(coldHex[axis]).toBeGreaterThanOrEqual(-3);
            expect(coldHex[axis]).toBeLessThanOrEqual(3);
        }
    });

    it('rolls -1..+1 on axes no keyword touched', () => {
        for (let seed = 1; seed <= 50; seed++) {
            const { hex, hitAxes } = deriveKeywordHex(['an ordinary person', 'fantasy'], lcg(seed));
            expect(hitAxes).toEqual([]);
            for (const axis of AXES) {
                expect(hex[axis]).toBeGreaterThanOrEqual(-1);
                expect(hex[axis]).toBeLessThanOrEqual(1);
                expect(Number.isInteger(hex[axis])).toBe(true);
            }
        }
    });

    it('is deterministic given the same rng seed', () => {
        expect(deriveKeywordHex(['shy'], lcg(9))).toEqual(deriveKeywordHex(['shy'], lcg(9)));
    });

    it('ships a table whose nudges only name real axes', () => {
        expect(KEYWORD_AXIS_TABLE.length).toBeGreaterThanOrEqual(20);
        for (const rule of KEYWORD_AXIS_TABLE) {
            const axes = Object.keys(rule.nudges) as HexAxis[];
            expect(axes.length).toBeGreaterThan(0);
            for (const axis of axes) {
                expect(AXES).toContain(axis);
                expect(Math.abs(rule.nudges[axis] as number)).toBeLessThanOrEqual(3);
            }
        }
    });
});

describe('populateImportedNPC (WO-C §3.4, §6.5)', () => {
    it('marks the NPC populated with the generator-mirroring agency defaults', () => {
        const out = populateImportedNPC(npc(), card({ personality: 'shy, kind' }), { rng: lcg(11), matureMode: false });
        expect(out.populated).toBe(true);
        expect(out.skillRung).toBe(RUNG_DEFAULT);
        expect(out.rungCeiling).toBe(3);
        expect(out.pcRelation).toBe(0); // affinity 50 → the neutral band
        expect(out.region).toBe('');
        expect(out.signatureKit).toBeUndefined();
        expect(out.traits).toBeUndefined();
    });

    it('homes pcRelation from the affinity band rather than hardcoding 0', () => {
        const out = populateImportedNPC(npc({ affinity: 20 }), card(), { rng: lcg(12), matureMode: false });
        expect(out.pcRelation).toBe(-2);
    });

    it('derives the hex from personality + tags: "shy, kind" → timid and warm', () => {
        const out = populateImportedNPC(npc(), card({ personality: 'Shy, kind girl.' }), { rng: lcg(13), matureMode: false });
        const hex = out.personalityHex;
        expect(hex).toBeDefined();
        expect(hex!.boldness).toBeLessThan(0);
        expect(hex!.warmth).toBeGreaterThan(0);
        for (const axis of AXES) {
            expect(hex![axis]).toBeGreaterThanOrEqual(-3);
            expect(hex![axis]).toBeLessThanOrEqual(3);
        }
    });

    it('rolls only -1..+1 for a card with no keyword hits', () => {
        const out = populateImportedNPC(npc(), card({ personality: 'An ordinary shopkeeper.', tags: ['fantasy'] }), { rng: lcg(14), matureMode: false });
        for (const axis of AXES) {
            expect(out.personalityHex![axis]).toBeGreaterThanOrEqual(-1);
            expect(out.personalityHex![axis]).toBeLessThanOrEqual(1);
        }
    });

    it('never lets the description influence the hex (W++ noise guard)', () => {
        const wpp = '[character("Aria"){personality("brave" + "cruel" + "ambitious" + "hardworking" + "stoic")}]';
        const withDesc = populateImportedNPC(npc(), card({ description: wpp, personality: 'An ordinary shopkeeper.', tags: ['fantasy'] }), { rng: lcg(15), matureMode: false });
        const withoutDesc = populateImportedNPC(npc(), card({ description: '', personality: 'An ordinary shopkeeper.', tags: ['fantasy'] }), { rng: lcg(15), matureMode: false });
        expect(withDesc.personalityHex).toEqual(withoutDesc.personalityHex);
    });

    it('draws short and medium wants and leaves long empty for the LLM updater', () => {
        const out = populateImportedNPC(npc(), card(), { rng: lcg(16), matureMode: false });
        expect(out.wants!.short.length).toBeGreaterThan(0);
        expect(out.wants!.medium.length).toBeGreaterThan(0);
        expect(out.wants!.long).toBe('');
        expect(new Set(out.wants!.short).size).toBe(out.wants!.short.length);
    });

    it('stamps the pool provenance so the UI never calls a pool draw inferred (§9.3)', () => {
        const out = populateImportedNPC(npc(), card(), { rng: lcg(16), matureMode: false });
        expect(out.wantsProvenance).toBe('pool');
    });

    it('never draws a mature-tier want when matureMode is false', () => {
        const mature = new Set(WANT_POOL.filter(w => w.tier === 'mature').map(w => w.text));
        expect(mature.size).toBeGreaterThan(0);
        for (let seed = 1; seed <= 40; seed++) {
            const out = populateImportedNPC(npc(), card(), { rng: lcg(seed), matureMode: false });
            for (const w of [...out.wants!.short, ...out.wants!.medium]) {
                expect(mature.has(w)).toBe(false);
            }
        }
    });

    it('is deterministic given a seeded rng', () => {
        const c = card({ personality: 'cheerful, hardworking', tags: ['tsundere'] });
        const a = populateImportedNPC(npc(), c, { rng: lcg(777), matureMode: false });
        const b = populateImportedNPC(npc(), c, { rng: lcg(777), matureMode: false });
        expect(a).toEqual(b);
    });

    it('preserves every field already on the entry and never mutates the input', () => {
        const input = npc({ portrait: '/uploads/aria.png', faction: 'Thieves Guild', haunt: 'the garden', agencyLocked: true });
        const before = JSON.stringify(input);
        const out = populateImportedNPC(input, card({ personality: 'shy' }), { rng: lcg(18), matureMode: false });
        expect(JSON.stringify(input)).toBe(before);
        expect(out).not.toBe(input);
        expect(out.id).toBe('npc-1');
        expect(out.portrait).toBe('/uploads/aria.png');
        expect(out.faction).toBe('Thieves Guild');
        expect(out.haunt).toBe('the garden');
        expect(out.agencyLocked).toBe(true);
        expect(out.tier).toBe('recurring');
        expect(out.personality).toBe('Shy but kind.');
    });
});
