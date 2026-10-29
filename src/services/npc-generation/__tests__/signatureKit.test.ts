import { describe, it, expect } from 'vitest';
import type { NPCEntry, NPCSignatureKit } from '../../../types';
import { sanitizeSignatureKit } from '../shared';
import { buildCoreDirective } from '../../payload/world';

// ─────────────────────────────────────────────────────────────────────────────
// WO: NPC Signature Kit (v1) — behavior-lock tests.
//
// Coverage:
//  1. Sanitizer bounds (cap 8, trim, drop empties, truncate, cap element, empty→undefined).
//  2. Sanitizer per-channel supersession merge (gear replaced, powers + element preserved).
//  3. CORE-tier injection: kit surfaces as `KIT: ... | POWERS: ... | element: ...`;
//     absent kit produces the pre-existing core line with none of those tokens.
//  4. Change-path write-back merge: feeding a partial kit through the same merge
//     helper the updater uses (`sanitizeSignatureKit(raw, targetNpc.signatureKit)`)
//     yields the expected stored shape — gear replaced, abilities + element intact.
//
// Design note on test 4: the write-back lives inline in `updateExistingNPCs`, which
// requires an LLM network call (`sendMessageAndParseJson`). Per the workorder escape
// hatch ("If the write-back isn't easily unit-testable without a network call, extract
// the merge into a tiny pure helper and test that; note the choice in the summary"),
// the merge IS already a pure helper — `sanitizeSignatureKit(raw, mergeInto)` — and
// that is the exact function the write-back calls. So test 4 exercises the real
// write-back merge path without needing to mock the network.
// ─────────────────────────────────────────────────────────────────────────────

function baseNpc(overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'npc-1',
        name: 'Rick',
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        disposition: '',
        status: 'Alive',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 50,
        ...overrides,
    } as NPCEntry;
}

describe('NPC Signature Kit (v1)', () => {
    // ── 1. Sanitizer bounds ────────────────────────────────────────────────
    describe('sanitizeSignatureKit — bounds', () => {
        it('caps each array to 8 entries', () => {
            const raw = {
                equipment: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
                abilities: ['w', 'x', 'y', 'z', '1', '2', '3', '4', 'extra'],
            };
            const kit = sanitizeSignatureKit(raw);
            expect(kit).toBeDefined();
            expect(kit!.equipment).toHaveLength(8);
            expect(kit!.abilities).toHaveLength(8);
            expect(kit!.equipment).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
            expect(kit!.abilities).toEqual(['w', 'x', 'y', 'z', '1', '2', '3', '4']);
        });

        it('trims whitespace, coerces non-strings via String(), and drops empties', () => {
            const raw = {
                equipment: ['  Excalibur  ', '', '   ', 42 as unknown, 'shield'],
                abilities: ['fire\r\nmagic', '\t', '  '],
            };
            const kit = sanitizeSignatureKit(raw);
            expect(kit).toBeDefined();
            expect(kit!.equipment).toEqual(['Excalibur', '42', 'shield']);
            expect(kit!.abilities).toEqual(['fire magic']);
        });

        it('truncates over-length entries to 48 chars (trimmed)', () => {
            const long = 'x'.repeat(100);
            const raw = { equipment: [long], abilities: [] };
            const kit = sanitizeSignatureKit(raw);
            expect(kit).toBeDefined();
            expect(kit!.equipment[0].length).toBe(48);
            expect(kit!.equipment[0]).toBe('x'.repeat(48));
        });

        it('caps element to 20 chars', () => {
            const raw = { element: 'x'.repeat(60) };
            const kit = sanitizeSignatureKit(raw);
            expect(kit).toBeDefined();
            expect(kit!.element!.length).toBe(20);
            expect(kit!.element).toBe('x'.repeat(20));
        });

        it('trims and clears element to undefined when blank', () => {
            const raw = { element: '   ' };
            const kit = sanitizeSignatureKit(raw);
            expect(kit).toBeUndefined();
        });

        it('returns undefined when the result is fully empty', () => {
            expect(sanitizeSignatureKit({})).toBeUndefined();
            expect(sanitizeSignatureKit({ equipment: [], abilities: [] })).toBeUndefined();
            expect(sanitizeSignatureKit({ equipment: ['', '  '], abilities: [] })).toBeUndefined();
        });

        it('returns undefined when raw is not an object', () => {
            expect(sanitizeSignatureKit(null)).toBeUndefined();
            expect(sanitizeSignatureKit(undefined)).toBeUndefined();
            expect(sanitizeSignatureKit('string')).toBeUndefined();
            expect(sanitizeSignatureKit(42)).toBeUndefined();
        });

        it('preserves element alone (no equipment/abilities) as a valid kit', () => {
            const kit = sanitizeSignatureKit({ element: 'fire' });
            expect(kit).toBeDefined();
            expect(kit!.equipment).toEqual([]);
            expect(kit!.abilities).toEqual([]);
            expect(kit!.element).toBe('fire');
        });
    });

    // ── 2. Sanitizer per-channel supersession merge ────────────────────────
    describe('sanitizeSignatureKit — merge', () => {
        const existing: NPCSignatureKit = {
            equipment: ['Excalibur'],
            abilities: ['fire magic'],
            element: 'fire',
        };

        it('replaces the gear channel and preserves powers + element', () => {
            const merged = sanitizeSignatureKit({ equipment: ['iron spear'] }, existing);
            expect(merged).toBeDefined();
            expect(merged!.equipment).toEqual(['iron spear']);
            expect(merged!.abilities).toEqual(['fire magic']);
            expect(merged!.element).toBe('fire');
        });

        it('replaces the powers channel and preserves gear + element', () => {
            const merged = sanitizeSignatureKit({ abilities: ['ice magic', 'regeneration'] }, existing);
            expect(merged).toBeDefined();
            expect(merged!.equipment).toEqual(['Excalibur']);
            expect(merged!.abilities).toEqual(['ice magic', 'regeneration']);
            expect(merged!.element).toBe('fire');
        });

        it('replaces the element channel and preserves gear + powers', () => {
            const merged = sanitizeSignatureKit({ element: 'earth' }, existing);
            expect(merged).toBeDefined();
            expect(merged!.equipment).toEqual(['Excalibur']);
            expect(merged!.abilities).toEqual(['fire magic']);
            expect(merged!.element).toBe('earth');
        });

        it('returns mergeInto unchanged when raw is null/undefined/not-an-object', () => {
            expect(sanitizeSignatureKit(null, existing)).toBe(existing);
            expect(sanitizeSignatureKit(undefined, existing)).toBe(existing);
            expect(sanitizeSignatureKit('string', existing)).toBe(existing);
        });

        it('clears element to undefined when raw sends an empty element string', () => {
            const merged = sanitizeSignatureKit({ element: '' }, existing);
            expect(merged).toBeDefined();
            expect(merged!.equipment).toEqual(['Excalibur']);
            expect(merged!.abilities).toEqual(['fire magic']);
            expect(merged!.element).toBeUndefined();
        });
    });

    // ── 3. CORE-tier injection ─────────────────────────────────────────────
    describe('buildCoreDirective — kit injection', () => {
        it('surfaces KIT, POWERS, and element tokens when the kit is present', () => {
            const npc = baseNpc({
                signatureKit: {
                    equipment: ['Excalibur (holy longsword)'],
                    abilities: ['fire magic'],
                    element: 'fire',
                },
            });
            const line = buildCoreDirective(npc);
            expect(line).toContain('KIT: Excalibur (holy longsword)');
            expect(line).toContain('POWERS: fire magic');
            expect(line).toContain('element: fire');
            expect(line.startsWith('PLAY AS: ')).toBe(true);
        });

        it('injects only the channels present (no POWERS when abilities empty)', () => {
            const npc = baseNpc({
                signatureKit: { equipment: ['iron spear'], abilities: [] },
            });
            const line = buildCoreDirective(npc);
            expect(line).toContain('KIT: iron spear');
            expect(line).not.toContain('POWERS:');
            expect(line).not.toContain('element:');
        });

        it('does NOT inject KIT/POWERS/element tokens when the NPC has no signatureKit (regression guard)', () => {
            const npc = baseNpc({ signatureKit: undefined });
            const line = buildCoreDirective(npc);
            expect(line).not.toContain('KIT:');
            expect(line).not.toContain('POWERS:');
            expect(line).not.toContain('element:');
        });

        it('does not crash on an empty kit (equipment + abilities empty, no element)', () => {
            const npc = baseNpc({
                signatureKit: { equipment: [], abilities: [] },
            });
            const line = buildCoreDirective(npc);
            expect(line).not.toContain('KIT:');
            expect(line).not.toContain('POWERS:');
            expect(line).not.toContain('element:');
        });
    });

    // ── 4. Change-path write-back merge (pure helper, no network) ──────────
    //
    // The inline write-back in `updateExistingNPCs` does:
    //     const merged = sanitizeSignatureKit(changes.signatureKit, targetNpc.signatureKit);
    //     if (merged) changes.signatureKit = merged;
    //     else delete changes.signatureKit;
    // We exercise that exact merge here against a target NPC's stored kit.
    describe('change-path write-back merge', () => {
        const targetNpcKit: NPCSignatureKit = {
            equipment: ['Excalibur (holy longsword)'],
            abilities: ['fire magic', 'regeneration'],
            element: 'fire',
        };

        it('partial update (only gear channel) replaces gear and preserves powers + element', () => {
            // Mimic: parsed = { updates: [{ name: 'Rick', changes: { signatureKit: { equipment: ['iron spear'] } } }] }
            const incomingChanges = { signatureKit: { equipment: ['iron spear'] } } as Partial<NPCEntry>;
            const merged = sanitizeSignatureKit(incomingChanges.signatureKit, targetNpcKit);
            expect(merged).toBeDefined();
            expect(merged!.equipment).toEqual(['iron spear']);
            expect(merged!.abilities).toEqual(['fire magic', 'regeneration']);
            expect(merged!.element).toBe('fire');
        });

        it('re-emitting an unchanged channel still works (powers overwritten with same content)', () => {
            const incomingChanges = { signatureKit: { abilities: ['fire magic', 'regeneration'] } } as Partial<NPCEntry>;
            const merged = sanitizeSignatureKit(incomingChanges.signatureKit, targetNpcKit);
            expect(merged).toBeDefined();
            expect(merged!.equipment).toEqual(['Excalibur (holy longsword)']);
            expect(merged!.abilities).toEqual(['fire magic', 'regeneration']);
            expect(merged!.element).toBe('fire');
        });

        it('clearing the only channel wipes the kit and the write-back deletes the field', () => {
            // Target has gear-only kit; raw sends empty equipment.
            const gearOnly: NPCSignatureKit = { equipment: ['spear'], abilities: [] };
            const merged = sanitizeSignatureKit({ equipment: [] }, gearOnly);
            // All channels empty, no element → undefined → write-back deletes changes.signatureKit.
            expect(merged).toBeUndefined();
        });

        it('garbage raw (non-object) is a no-op — existing kit is returned unchanged', () => {
            const merged = sanitizeSignatureKit('garbage', targetNpcKit);
            expect(merged).toBe(targetNpcKit);
        });

        it('over-length entries are still bounded on the change path (defensive cap)', () => {
            const incomingChanges = {
                signatureKit: { equipment: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
            } as Partial<NPCEntry>;
            const merged = sanitizeSignatureKit(incomingChanges.signatureKit, targetNpcKit);
            expect(merged).toBeDefined();
            expect(merged!.equipment).toHaveLength(8);
            // Powers + element preserved from the target kit.
            expect(merged!.abilities).toEqual(['fire magic', 'regeneration']);
            expect(merged!.element).toBe('fire');
        });
    });
});