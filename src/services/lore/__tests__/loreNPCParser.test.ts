import { describe, it, expect } from 'vitest';
import { parseNPCsFromLore } from '../loreNPCParser';
import type { LoreChunk } from '../../../types';

/** Build a minimal character-classified LoreChunk with the given header + body. */
function charChunk(header: string, content: string): LoreChunk {
    return {
        id: `test-${Math.random().toString(36).slice(2, 8)}`,
        header,
        content,
        tokens: 100,
        alwaysInclude: false,
        triggerKeywords: [],
        category: 'character',
        linkedEntities: [],
        priority: 5,
        scanDepth: 3,
    };
}

const NARUTO_BLOCK = `### CHARACTER -- Naruto Uzumaki
**Aliases:** Number One Hyperactive Knucklehead Ninja, The Boy With The Fox
**Appearance:** Spiky blond hair, blue eyes, whisker marks on cheeks. Orange jumpsuit.
**Disposition:** Loud, loyal, stubborn, refuses to give up.
**Personality:** Naruto is driven by a desperate need to be acknowledged.
**Voice:** Casual, brash, uses "dattebayo" verbal tic.
**Status:** Alive
**Faction:** Konohagakure
**Goals:** Become Hokage so the village will finally recognize him.
**StoryRelevance:** Jinchuuriki of the Nine-Tails; protagonist.
**Example Output:** "I'm gonna be Hokage someday, believe it!"
**Affinity:** 50
**PersonalityHex:** drive:+3, diligence:-1, boldness:+3, warmth:+2, empathy:+2, composure:-2
**Traits:** [loyal, stubborn, impulsive, competitive, protective]
**VisualRace:** Human
**VisualGender:** Male
**VisualAgeRange:** 12-13
**VisualBuild:** Lean, wiry
**VisualHairStyle:** Spiky sun-blond
**VisualEyeColor:** Bright blue
**VisualSkinTone:** Fair
**VisualClothing:** Orange tracksuit, blue forehead protector
**VisualArtStyle:** Anime`;

describe('parseNPCsFromLore — lore-authored agency fields (hex + traits)', () => {
    it('extracts PersonalityHex from the CSV form and clamps to -3..+3', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', NARUTO_BLOCK)]);
        expect(npc).toBeDefined();
        expect(npc.personalityHex).toEqual({
            drive: 3,
            diligence: -1,
            boldness: 3,
            warmth: 2,
            empathy: 2,
            composure: -2,
        });
    });

    it('extracts Traits from the bracketed CSV and filters to the controlled vocab', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', NARUTO_BLOCK)]);
        expect(npc.traits).toEqual(['loyal', 'stubborn', 'impulsive', 'competitive', 'protective']);
    });

    it('accepts inline JSON for PersonalityHex', () => {
        const body = NARUTO_BLOCK.replace(
            '**PersonalityHex:** drive:+3, diligence:-1, boldness:+3, warmth:+2, empathy:+2, composure:-2',
            '**PersonalityHex:** {"drive":3,"diligence":-1,"boldness":3,"warmth":2,"empathy":2,"composure":-2}',
        );
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.personalityHex).toEqual({
            drive: 3, diligence: -1, boldness: 3, warmth: 2, empathy: 2, composure: -2,
        });
    });

    it('clamps out-of-range hex values to the -3..+3 hard bounds', () => {
        const body = NARUTO_BLOCK.replace(
            '**PersonalityHex:** drive:+3, diligence:-1, boldness:+3, warmth:+2, empathy:+2, composure:-2',
            '**PersonalityHex:** drive:+9, diligence:-7, boldness:+5, warmth:2, empathy:2, composure:-2',
        );
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.personalityHex).toEqual({
            drive: 3, diligence: -3, boldness: 3, warmth: 2, empathy: 2, composure: -2,
        });
    });

    it('drops trait names not in the controlled vocabulary', () => {
        const body = NARUTO_BLOCK.replace(
            '**Traits:** [loyal, stubborn, impulsive, competitive, protective]',
            '**Traits:** [loyal, very brave, super smart, protective, totally awesome]',
        );
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.traits).toEqual(['loyal', 'protective']);
    });

    it('caps traits at 5 even when the block lists more', () => {
        const body = NARUTO_BLOCK.replace(
            '**Traits:** [loyal, stubborn, impulsive, competitive, protective]',
            '**Traits:** [loyal, stubborn, impulsive, competitive, protective, vengeful, ambitious, curious]',
        );
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.traits?.length).toBe(5);
        expect(npc.traits).toEqual(['loyal', 'stubborn', 'impulsive', 'competitive', 'protective']);
    });

    it('returns undefined for hex and traits when the block omits them', () => {
        const body = NARUTO_BLOCK
            .replace(/\n\*\*PersonalityHex:\*\*.*/u, '')
            .replace(/\n\*\*Traits:\*\*.*/u, '');
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.personalityHex).toBeUndefined();
        expect(npc.traits).toBeUndefined();
    });

    it('still extracts the standard 11 text fields', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', NARUTO_BLOCK)]);
        expect(npc.name).toBe('Naruto Uzumaki');
        expect(npc.aliases).toContain('Number One Hyperactive');
        expect(npc.appearance).toContain('whisker marks');
        expect(npc.disposition).toContain('loyal');
        expect(npc.personality).toContain('acknowledged');
        expect(npc.voice).toContain('dattebayo');
        expect(npc.status).toBe('Alive');
        expect(npc.faction).toBe('Konohagakure');
        expect(npc.goals).toContain('Hokage');
        expect(npc.storyRelevance).toContain('Jinchuuriki');
        expect(npc.exampleOutput).toContain('believe it');
        expect(npc.affinity).toBe(50);
    });

    it('PRESERVES the desktop-only visualProfile extraction (regression guard)', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', NARUTO_BLOCK)]);
        // visualProfile is desktop-only — adding hex/traits must not break it.
        expect(npc.visualProfile).toBeDefined();
        if (!npc.visualProfile) return;
        expect(npc.visualProfile.race).toBe('Human');
        expect(npc.visualProfile.gender).toBe('Male');
        expect(npc.visualProfile.ageRange).toBe('12-13');
        expect(npc.visualProfile.build).toBe('Lean, wiry');
        expect(npc.visualProfile.hairStyle).toBe('Spiky sun-blond');
        expect(npc.visualProfile.eyeColor).toBe('Bright blue');
        expect(npc.visualProfile.skinTone).toBe('Fair');
        expect(npc.visualProfile.clothing).toContain('Orange tracksuit');
        expect(npc.visualProfile.artStyle).toBe('Anime');
    });

    it('omits visualProfile when no Visual* fields are present (unchanged behaviour)', () => {
        const body = NARUTO_BLOCK
            .replace(/\n\*\*VisualRace:\*\*.*/u, '')
            .replace(/\n\*\*VisualGender:\*\*.*/u, '')
            .replace(/\n\*\*VisualAgeRange:\*\*.*/u, '')
            .replace(/\n\*\*VisualBuild:\*\*.*/u, '')
            .replace(/\n\*\*VisualHairStyle:\*\*.*/u, '')
            .replace(/\n\*\*VisualEyeColor:\*\*.*/u, '')
            .replace(/\n\*\*VisualSkinTone:\*\*.*/u, '')
            .replace(/\n\*\*VisualClothing:\*\*.*/u, '')
            .replace(/\n\*\*VisualArtStyle:\*\*.*/u, '');
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.visualProfile).toBeUndefined();
    });
});

const AGENCY_BLOCK = `### CHARACTER — Test NPC
**Disposition:** Cool, distant.
**Status:** Alive
**Faction:** Konohagakure
**Tier:** recurring
**Region:** konoha
**Haunt:** the training grounds
**HardBoundaries:** [will not betray his team, will not abandon a comrade]
**SoftBoundaries:** [dislikes being lectured, dislikes waiting]
**BehavioralTriggers:** [itachi:goes silent and sharpens killing intent, sasuke:raises voice and clenches fists]
**WantsShort:** [train, eat ramen, prank]
**WantsMedium:** [learn a new jutsu, win a sparring match]
**WantsLong:** become Hokage so the village recognizes him
**CoreWant:** to be acknowledged, not feared
**SessionWant:** bring his teammate back
**SceneWant:** prove he is not the fox`;

describe('parseNPCsFromLore — extended agency fields (tier, region, haunt, boundaries, triggers, wants, drives)', () => {
    it('extracts Tier and validates to recurring|oneshot|walkon (default recurring)', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.tier).toBe('recurring');
    });

    it('defaults Tier to recurring when the field is absent', () => {
        const block = '**Disposition:** Cool.\n**Status:** Alive\n**Faction:** Konoha';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', block)]);
        expect(npc.tier).toBe('recurring');
    });

    it('rejects an invalid Tier value and falls back to recurring', () => {
        const block = AGENCY_BLOCK.replace('**Tier:** recurring', '**Tier:** superhero');
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', block)]);
        expect(npc.tier).toBe('recurring');
    });

    it('extracts Region and Haunt as single-line strings', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.region).toBe('konoha');
        expect(npc.haunt).toBe('the training grounds');
    });

    it('extracts HardBoundaries and SoftBoundaries as string arrays', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.hardBoundaries).toEqual(['will not betray his team', 'will not abandon a comrade']);
        expect(npc.softBoundaries).toEqual(['dislikes being lectured', 'dislikes waiting']);
    });

    it('extracts BehavioralTriggers as {keyword, shift} pairs', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.behavioralTriggers).toEqual([
            { keyword: 'itachi', shift: 'goes silent and sharpens killing intent' },
            { keyword: 'sasuke', shift: 'raises voice and clenches fists' },
        ]);
    });

    it('extracts Wants (short/medium/long)', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.wants).toEqual({
            short: ['train', 'eat ramen', 'prank'],
            medium: ['learn a new jutsu', 'win a sparring match'],
            long: 'become Hokage so the village recognizes him',
        });
    });

    it('extracts Drives (coreWant/sessionWant/sceneWant)', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', AGENCY_BLOCK)]);
        expect(npc.drives).toEqual({
            coreWant: 'to be acknowledged, not feared',
            sessionWant: 'bring his teammate back',
            sceneWant: 'prove he is not the fox',
        });
    });

    it('returns undefined for agency fields when the block omits them', () => {
        const block = '**Disposition:** Cool.\n**Status:** Alive\n**Faction:** Konoha';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER — Test NPC', block)]);
        expect(npc.tier).toBe('recurring'); // tier defaults, not undefined
        expect(npc.region).toBeUndefined();
        expect(npc.haunt).toBeUndefined();
        expect(npc.hardBoundaries).toBeUndefined();
        expect(npc.softBoundaries).toBeUndefined();
        expect(npc.behavioralTriggers).toBeUndefined();
        expect(npc.drives).toBeUndefined();
        expect(npc.wants).toBeUndefined();
    });

    it('PRESERVES visualProfile alongside the new agency fields (regression guard)', () => {
        const block = NARUTO_BLOCK
            + '\n**Tier:** recurring\n**Region:** konoha\n**Haunt:** Ichiraku Ramen\n'
            + '**HardBoundaries:** [will not abandon a teammate]\n'
            + '**WantsLong:** become Hokage';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', block)]);
        // visualProfile still extracts with the original Visual* fields from NARUTO_BLOCK.
        expect(npc.visualProfile).toBeDefined();
        expect(npc.visualProfile?.race).toBe('Human');
        // And the new agency fields are present alongside it.
        expect(npc.tier).toBe('recurring');
        expect(npc.region).toBe('konoha');
        expect(npc.hardBoundaries).toEqual(['will not abandon a teammate']);
        expect(npc.wants?.long).toBe('become Hokage');
    });
});
describe('parseNPCsFromLore — signature kit (durable loadout)', () => {
    it('parses SignatureEquipment / SignatureAbilities / Element into a bounded kit', () => {
        const body = NARUTO_BLOCK
            + '\n**SignatureEquipment:** [Excalibur (holy longsword), plate armor]'
            + '\n**SignatureAbilities:** [fire magic, holy smite]'
            + '\n**Element:** fire';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.signatureKit).toBeDefined();
        expect(npc.signatureKit!.equipment).toEqual(['Excalibur (holy longsword)', 'plate armor']);
        expect(npc.signatureKit!.abilities).toEqual(['fire magic', 'holy smite']);
        expect(npc.signatureKit!.element).toBe('fire');
    });

    it('accepts the author-friendly aliases (Equipment / Abilities / Powers)', () => {
        const body = NARUTO_BLOCK
            + '\n**Equipment:** [iron spear]'
            + '\n**Powers:** [earth magic]';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.signatureKit!.equipment).toEqual(['iron spear']);
        expect(npc.signatureKit!.abilities).toEqual(['earth magic']);
        // Element left unset here — must not leak from the numeric Affinity bullet.
        expect(npc.signatureKit!.element).toBeUndefined();
    });

    it('caps each channel at 8 entries (shared sanitizer bound)', () => {
        const body = NARUTO_BLOCK
            + '\n**SignatureEquipment:** [a, b, c, d, e, f, g, h, i, j]'
            + '\n**SignatureAbilities:** [g, h, i, j, k, l, m, n, o]';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.signatureKit!.equipment).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
        expect(npc.signatureKit!.abilities).toEqual(['g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']);
    });

    it('leaves signatureKit undefined when no kit fields are present (default)', () => {
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', NARUTO_BLOCK)]);
        expect(npc.signatureKit).toBeUndefined();
    });

    it('supports an element-only kit (no gear/powers)', () => {
        const body = NARUTO_BLOCK + '\n**Element:** lightning';
        const [npc] = parseNPCsFromLore([charChunk('CHARACTER -- Naruto Uzumaki', body)]);
        expect(npc.signatureKit).toBeDefined();
        expect(npc.signatureKit!.element).toBe('lightning');
        expect(npc.signatureKit!.equipment).toEqual([]);
        expect(npc.signatureKit!.abilities).toEqual([]);
    });
});
