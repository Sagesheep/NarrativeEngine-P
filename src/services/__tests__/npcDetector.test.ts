/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { extractNPCNames } from '../npc/npcDetector';

describe('extractNPCNames — 7-pass detection', () => {

    // Pass 1: bracket detection
    it('Pass 1: detects [Aldric] and [**Seraphine**]', () => {
        const result = extractNPCNames('[Aldric] nodded. [**Seraphine**] drew her sword.');
        expect(result).toContain('Aldric');
        expect(result).toContain('Seraphine');
    });

    // Pass 2: SYSTEM NPC_ENTRY
    it('Pass 2: detects [SYSTEM: NPC_ENTRY - Orin]', () => {
        const result = extractNPCNames('The door opened. [SYSTEM: NPC_ENTRY - Orin]');
        expect(result).toContain('Orin');
    });

    // Pass 3: title-prefixed
    it('Pass 3: detects "Captain Aldric" → Aldric (title stripped)', () => {
        const result = extractNPCNames('Captain Aldric said hello to the crew.');
        expect(result).toContain('Aldric');
    });

    it('Pass 3: detects "Instructor Roderick Vaul"', () => {
        const result = extractNPCNames('Instructor Roderick Vaul entered the hall.');
        expect(result).toContain('Roderick Vaul');
    });

    // Pass 4a: name + speech verb
    it('Pass 4a: detects "Aldric said"', () => {
        const result = extractNPCNames('Aldric said hello.');
        expect(result).toContain('Aldric');
    });

    it('Pass 4a: detects "Maren whispered"', () => {
        const result = extractNPCNames('Maren whispered the secret.');
        expect(result).toContain('Maren');
    });

    // Pass 4b: speech verb + name
    it('Pass 4b: detects "said Aldric"', () => {
        const result = extractNPCNames('"Hello," said Aldric, the brave.');
        expect(result).toContain('Aldric');
    });

    it('Pass 4b: detects "whispered Maren"', () => {
        const result = extractNPCNames('"Be quiet," whispered Maren from the shadows.');
        expect(result).toContain('Maren');
    });

    // Pass 5a: role-apposition
    it('Pass 5a: detects "the merchant Orin"', () => {
        const result = extractNPCNames('The merchant Orin entered the square.');
        expect(result).toContain('Orin');
    });

    it('Pass 5a: detects "an innkeeper Bram"', () => {
        const result = extractNPCNames('An innkeeper Bram greeted the travelers.');
        expect(result).toContain('Bram');
    });

    // Pass 5b: named/called
    it('Pass 5b: detects "a man named Bram"', () => {
        const result = extractNPCNames('A man named Bram approached the fire.');
        expect(result).toContain('Bram');
    });

    it('Pass 5b: detects "called Orin"', () => {
        const result = extractNPCNames('The stranger, called Orin, nodded.');
        expect(result).toContain('Orin');
    });

    // Pass 6: connective names
    it('Pass 6: detects "Aldric of Westhold"', () => {
        const result = extractNPCNames('Aldric of Westhold rode into town.');
        expect(result).toContain('Aldric of Westhold');
    });

    it('Pass 6: detects "Elara von Mire"', () => {
        const result = extractNPCNames('Elara von Mire surveyed the battlefield.');
        expect(result).toContain('Elara von Mire');
    });

    // Pass 7: two consecutive capitalized tokens
    it('Pass 7: detects "Seraphine Thornmere"', () => {
        const result = extractNPCNames('Seraphine Thornmere entered the room.');
        expect(result).toContain('Seraphine Thornmere');
    });

    // Blocklist exclusion
    it('Blocklist: "Not But" at sentence start → NOT detected', () => {
        const result = extractNPCNames('Not But the gate was closed.');
        expect(result).not.toContain('Not But');
    });

    // Structural word exclusion
    it('Structural: "Iron Gate" → NOT detected', () => {
        const result = extractNPCNames('They passed through Iron Gate.');
        expect(result).not.toContain('Iron Gate');
    });

    it('Structural: "North Bridge" → NOT detected', () => {
        const result = extractNPCNames('They crossed North Bridge.');
        expect(result).not.toContain('North Bridge');
    });

    // Contraction exclusion
    it('Contraction: "Maren\'s sword" → Maren NOT detected as contraction form', () => {
        const result = extractNPCNames("Maren's sword gleamed in the light.");
        // "Maren's" should be excluded by contraction suffix check
        // but "Maren" could still be caught by other passes (e.g. if explicitly introduced)
        // The key assertion: we should NOT get "Maren's" as a candidate
        expect(result).not.toContain("Maren's");
        expect(result).not.toContain("Maren\u2019s");
    });

    // Exclude names parameter
    it('Exclude: excludeNames=["Aldric"] → Aldric absent from result', () => {
        const result = extractNPCNames('[Aldric] nodded. [**Maren**] smiled.', ['Aldric']);
        expect(result).not.toContain('Aldric');
        expect(result).toContain('Maren');
    });

    // No regression on Pass 1/2
    it('No regression: bracket-based extraction still works with 7-pass', () => {
        const result = extractNPCNames('[Aldric] looked at [**Orin**]. [SYSTEM: NPC_ENTRY - Maren]');
        expect(result).toContain('Aldric');
        expect(result).toContain('Orin');
        expect(result).toContain('Maren');
    });

    it('Filters out generic role patterns (guard #3)', () => {
        const result = extractNPCNames('[guard #3] attacked.');
        expect(result).not.toContain('guard #3');
    });

    it('Filters out all-caps bracket content (dice results)', () => {
        const result = extractNPCNames('[CRITICAL HIT] landed on Aldric.');
        // CRITICAL HIT is all-caps with spaces → filtered by all-caps check
        expect(result).not.toContain('CRITICAL HIT');
    });

    // Fail-closed validator test — actually rejects on error
    it('Fail-closed: validateNPCCandidates returns [] when llmCall throws', async () => {
        // Mock llmCall to throw so we exercise the catch → return [] path
        vi.doMock('../../utils/llmCall', () => ({
            llmCall: vi.fn().mockRejectedValue(new Error('network offline')),
        }));
        // @ts-expect-error — the query suffix gives a fresh module instance; Vite resolves it, TypeScript cannot
        const { validateNPCCandidates } = await import('../npc/npcDetector?t=fail-closed');
        const provider = { endpoint: 'http://localhost', model: 'test' } as any;
        const result = await validateNPCCandidates(provider, ['Aldric', 'Maren'], 'Some context');
        expect(result).toEqual([]);
        vi.doUnmock('../../utils/llmCall');
    });

    // Pass-7 cap test
    it('Pass-7 cap: at most PASS7_MAX_PER_TURN (5) Pass-7-only names admitted', () => {
        // Build text with 10 clearly Pass-7-eligible two-word names (not caught by earlier passes)
        const names = [
            'Aldric Thornmere', 'Seraphine Blackwood', 'Orin Valewick',
            'Maren Coldveil', 'Bram Ashfen', 'Lyra Duskmoore',
            'Cael Rivenmoor', 'Syla Ironvale', 'Davan Greyspar', 'Ruva Brightholm',
        ];
        const text = names.join('. ') + '.';
        const result = extractNPCNames(text);
        // Count how many Pass-7-only candidates appear (none have a speech verb / bracket / etc.)
        const p7Matches = result.filter(n => names.includes(n));
        expect(p7Matches.length).toBeLessThanOrEqual(5);
    });

    // excludeSet filtering test
    it('excludeSet: name in excludeNames is filtered out across all passes', () => {
        // Aldric appears via Pass 1 (bracket) AND Pass 4a (speech verb) — still excluded
        const text = '[Aldric] nodded. Aldric said hello. [**Maren**] smiled.';
        const result = extractNPCNames(text, ['Aldric']);
        expect(result).not.toContain('Aldric');
        expect(result).toContain('Maren');
    });

    // Smoke test: real NPC + structural word + chapter heading
    it('Smoke: Seraphine Thornmere admitted; Iron Gate and Chapter Two rejected', () => {
        const text = 'Seraphine Thornmere stepped through Iron Gate. Chapter Two begins now.';
        const result = extractNPCNames(text);
        expect(result).toContain('Seraphine Thornmere');
        expect(result).not.toContain('Iron Gate');
        expect(result).not.toContain('Chapter Two');
    });
});
