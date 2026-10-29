import { describe, it, expect } from 'vitest';
import type { NPCEntry, PersonalityHex } from '../../../types';
import { buildWorld } from '../world';
import { createTraceCollector } from '../traceCollector';

// ─────────────────────────────────────────────────────────────────────────────
// WO-2 (parity 30/06) — reaction-menu reconnect guard.
//
// The WO-G tiered-payload rewrite silently dropped the engine reaction menu from
// the NPC payload (buildBehaviorDirective stopped being the production path and the
// new core/extended directives didn't carry the menu). Nothing tested that the menu
// reached the payload, so the regression shipped. THIS is that missing test: the
// menu must surface for an on-stage hex NPC, and must be gated off when the NPC is
// off-stage. If this fails, the anti-sycophancy forcing function is inert again.
// ─────────────────────────────────────────────────────────────────────────────

// Loyal / high-warmth / high-empathy hex — known to yield a non-empty peaceful menu
// (see reactionMenu.test.ts "Kakashi" case). Menu non-emptiness is rng-independent.
const HEX: PersonalityHex = { drive: 1, diligence: 2, boldness: 1, warmth: 2, empathy: 2, composure: 1 };

function hexNpc(id: string, name: string): NPCEntry {
    return {
        id, name, aliases: '', appearance: '', faction: '',
        storyRelevance: '', disposition: '', status: 'alive',
        goals: '', voice: '', personality: '', exampleOutput: '',
        affinity: 50, archived: false,
        personalityHex: HEX, traits: ['loyal', 'protective', 'honorable'],
    } as NPCEntry;
}

function build(onStageNpcIds: string[]) {
    return buildWorld({
        history: [],
        userMessage: 'Kakashi steps forward as the lantern gutters.',
        npcLedger: [hexNpc('kakashi', 'Kakashi')],
        onStageNpcIds,
        budgetWorld: 8192,
        npcBudgetFloor: 2048,
        collector: createTraceCollector(false),
    });
}

const REACTION_MARKER = 'REACTIONS (choose ONE';

describe('WO-2 — reaction menu reaches the NPC payload', () => {
    it('injects the reaction menu for an ON-STAGE hex NPC', () => {
        const { worldContent } = build(['kakashi']);
        expect(worldContent).toContain('KAKASHI');
        expect(worldContent).toContain(REACTION_MARKER);
    });

    it('does NOT inject the menu when the NPC is OFF-stage', () => {
        const { worldContent } = build([]);
        expect(worldContent).toContain('KAKASHI'); // still in the NPC payload…
        expect(worldContent).not.toContain(REACTION_MARKER); // …but no scene-reaction menu
    });
});
