import { describe, it, expect } from 'vitest';
import { extractNPCNames } from '../../npc/npcDetector';
import type { NPCEntry } from '../../../types';

function makeNpc(name: string, extra: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: name.toLowerCase(),
        name,
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
        ...extra,
    };
}

function makePc(name: string, extra: Partial<NPCEntry> = {}): NPCEntry {
    return makeNpc(name, { isPC: true, ...extra });
}

// Mirrors the runNPCTrack exclude-list construction (post-WO-A-rewrite-2):
// npcLedger names + PC name + PC aliases. The NPC detector must skip the PC
// so play never spawns an NPC clone of the player character.
function buildExcludeList(npcLedger: NPCEntry[], pc: NPCEntry | null): string[] {
    const excludeNames = npcLedger.flatMap(npc => {
        const aliases = (npc.aliases || '').split(',').map(a => a.trim()).filter(Boolean);
        return [npc.name, ...aliases];
    });
    if (pc) {
        excludeNames.push(pc.name);
        if (pc.aliases) {
            excludeNames.push(...pc.aliases.split(',').map(a => a.trim()).filter(Boolean));
        }
    }
    return excludeNames;
}

describe('WO-A rewrite 2 §2 — NPC detector skips the player character', () => {
    it('extractNPCNames does not surface the PC name when the PC appears in a bracket pattern', () => {
        const pc = makePc('Kai', { aliases: 'K, K-Dawg' });
        const npcLedger: NPCEntry[] = [makeNpc('Aria')];
        const exclude = buildExcludeList(npcLedger, pc);
        // [Kai] is a Pass-1 bracket pattern — would normally surface as a candidate.
        // With Kai in the exclude list, the detector must skip it.
        const extracted = extractNPCNames('[Kai] looked around the tavern.', exclude);
        expect(extracted).not.toContain('Kai');
    });

    it('extractNPCNames finds a fresh NPC name but not the PC name', () => {
        const pc = makePc('Kai');
        const npcLedger: NPCEntry[] = [];
        const exclude = buildExcludeList(npcLedger, pc);
        // Pass 4a: "Bram said" — detects Bram. "Kai" alone without a speech verb
        // is not a strong detection pattern, so we use a pattern that would
        // surface both if Kai weren't excluded.
        const extracted = extractNPCNames('[Kai] nodded to Bram. Bram said hello.', exclude);
        expect(extracted).not.toContain('Kai');
        expect(extracted).toContain('Bram');
    });

    it('PC aliases are also excluded', () => {
        const pc = makePc('Kai', { aliases: 'K-Dawg' });
        const exclude = buildExcludeList([], pc);
        // [K-Dawg] is a Pass-1 bracket pattern.
        const extracted = extractNPCNames('[K-Dawg] leaned against the wall.', exclude);
        expect(extracted).not.toContain('K-Dawg');
    });

    it('when playerCharacter is null, only ledger names are excluded (legacy fallback)', () => {
        const npcLedger = [makeNpc('Aria')];
        const exclude = buildExcludeList(npcLedger, null);
        expect(exclude).toContain('Aria');
        // Kai is not in the ledger and there is no PC — Kai should be detected
        // via the Pass-1 bracket pattern.
        const extracted = extractNPCNames('[Kai] smiled at the crowd.', exclude);
        expect(extracted).toContain('Kai');
    });
});