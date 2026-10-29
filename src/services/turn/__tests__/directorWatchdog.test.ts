import { describe, it, expect } from 'vitest';
import {
    buildWatchdogDossier,
    type WatchdogInput,
} from '../directorWatchdog';
import type { ChatMessage, NPCEntry, Goal } from '../../../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function asstMsg(content: string, id = ''): ChatMessage {
    return {
        id: id || `a_${Math.random().toString(36).slice(2)}`,
        role: 'assistant',
        content,
        timestamp: 0,
    };
}

function userMsg(content: string): ChatMessage {
    return {
        id: `u_${Math.random().toString(36).slice(2)}`,
        role: 'user',
        content,
        timestamp: 0,
    };
}

function npcEntry(over: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'npc_ingrid',
        name: 'Ingrid',
        aliases: '',
        appearance: '',
        visualProfile: undefined,
        faction: '',
        storyRelevance: '',
        disposition: '',
        status: '',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 50,
        pcRelation: 0,
        ...over,
    } as NPCEntry;
}

function pcEntry(name = 'Kai'): NPCEntry {
    return npcEntry({
        id: 'pc_kai',
        name,
        isPC: true,
        pcRelation: 0,
        affinity: 50,
    });
}

function activeGoal(text: string, over: Partial<Goal> = {}): Goal {
    return {
        text,
        horizon: 'med',
        tier: 'default',
        base_heat: 1,
        lastAdvancedTick: 0,
        failStreak: 0,
        progress: 0,
        quota: 3,
        state: 'active',
        ...over,
    };
}

function input(
    messages: ChatMessage[],
    npcLedger: NPCEntry[],
    onStageNpcIds: string[] = ['npc_ingrid'],
): WatchdogInput {
    return { messages, npcLedger, onStageNpcIds };
}

/** Build an input that includes a PC entry (Kai) in the ledger so the
 *  one-directional heuristic has a PC name to compare against. */
function inputWithPc(
    messages: ChatMessage[],
    npcs: NPCEntry[],
    onStageNpcIds: string[] = [],
): WatchdogInput {
    const pc = pcEntry('Kai');
    const ids = onStageNpcIds.length > 0 ? onStageNpcIds : npcs.map(n => n.id);
    return { messages, npcLedger: [pc, ...npcs], onStageNpcIds: ids };
}

// ── Tests: empty-input safety ───────────────────────────────────────────────

describe('directorWatchdog — empty-input safety', () => {
    it('returns no signals for empty messages', () => {
        const d = buildWatchdogDossier(input([], [npcEntry()]));
        expect(d.signals).toEqual([]);
        expect(d.dossierText).toBe('');
        expect(d.nudgeText).toBeNull();
    });

    it('returns no signals for empty ledger', () => {
        const d = buildWatchdogDossier(input([asstMsg('Ingrid smiles.')], []));
        expect(d.signals).toEqual([]);
        expect(d.nudgeText).toBeNull();
    });

    it('returns no signals when no on-stage NPCs are passed', () => {
        const d = buildWatchdogDossier({
            messages: [asstMsg('Nothing happens.')],
            npcLedger: [npcEntry()],
            onStageNpcIds: [],
        });
        expect(d.signals).toEqual([]);
    });

    it('skips archived NPCs even if listed on stage', () => {
        const d = buildWatchdogDossier({
            messages: [asstMsg('Silence.')],
            npcLedger: [npcEntry({ archived: true })],
            onStageNpcIds: ['npc_ingrid'],
        });
        expect(d.signals).toEqual([]);
    });

    it('ignores non-assistant messages for the silent scan', () => {
        // 5 user messages mentioning Ingrid, 0 assistant → no assistant window
        // → no silent signal (we scan assistant messages only, per §3).
        const msgs = [
            userMsg('Ingrid! Ingrid! Ingrid!'),
            userMsg('Where is Ingrid?'),
            userMsg('Tell Ingrid to speak.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [npcEntry()]));
        expect(d.signals.find(s => s.kind === 'silent-npc')).toBeUndefined();
    });
});

// ── Tests: silent-npc ────────────────────────────────────────────────────────

describe('directorWatchdog — silent-npc', () => {
    it('fires when NPC absent from the last 3 assistant messages', () => {
        const msgs = [
            asstMsg('Ingrid waves at the start.'),     // old, outside window
            asstMsg('The fire crackles.'),              // last 3, no Ingrid
            asstMsg('A cold wind blows.'),              // last 3, no Ingrid
            asstMsg('Kai sips tea alone.'),             // last 3, no Ingrid
        ];
        const d = buildWatchdogDossier(input(msgs, [npcEntry()]));
        const sig = d.signals.find(s => s.kind === 'silent-npc');
        expect(sig).toBeDefined();
        expect(sig!.npcName).toBe('Ingrid');
        expect(sig!.priority).toBe(3);
        expect(sig!.detail).toMatch(/silent for 3 turns while on stage/);
    });

    it('does not fire when NPC is mentioned in any of the last 3 assistant messages', () => {
        const msgs = [
            asstMsg('Ingrid is here.'),
            asstMsg('The fire crackles.'),
            asstMsg('Ingrid shifts her weight.'),
            asstMsg('Kai sips tea alone.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [npcEntry()]));
        expect(d.signals.find(s => s.kind === 'silent-npc')).toBeUndefined();
    });

    it('counts streak from newest backward (newer mention breaks streak)', () => {
        // Newest two messages mention Ingrid → streak 0 → no signal even though
        // older assistant messages lacked her name.
        const msgs = [
            asstMsg('Silence.'),
            asstMsg('Silence again.'),
            asstMsg('Ingrid speaks up.'),
            asstMsg('Ingrid grins.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [npcEntry()]));
        expect(d.signals.find(s => s.kind === 'silent-npc')).toBeUndefined();
    });

    it('matches aliases (case-insensitive, word-boundary)', () => {
        const ingrid = npcEntry({ aliases: 'Lady Ingrid, Ing' });
        const msgs = [
            asstMsg('The fire crackles.'),
            asstMsg('A cold wind blows.'),
            asstMsg('Lady ingrid tilts her chin.'), // alias match in last 3
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        expect(d.signals.find(s => s.kind === 'silent-npc')).toBeUndefined();
    });

    it('word-boundary prevents substring false positives', () => {
        // "ingrid" must not match "Ringgrid" — but with \b it also won't match
        // "Ingridsson" if that's how the NPC name appears. Verify the watchdog
        // requires a real word boundary.
        const ingrid = npcEntry({ name: 'Ingrid' });
        const msgs = [
            asstMsg('Quiet.'),
            asstMsg('Quiet again.'),
            asstMsg('The Ingridsson heir broods.'), // contains "Ingrid" as substring
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        const sig = d.signals.find(s => s.kind === 'silent-npc');
        // With \b regex the substring inside "Ingridsson" should NOT match → signal fires.
        expect(sig).toBeDefined();
    });
});

// ── Tests: one-directional ──────────────────────────────────────────────────

describe('directorWatchdog — one-directional', () => {
    it('fires when pcRelation >= +1 and NPC never initiates in last 5', () => {
        const ingrid = npcEntry({ pcRelation: 2 });
        const msgs = [
            asstMsg('Kai asks Ingrid a question.'),    // PC first — NPC doesn't initiate
            asstMsg('Kai presses Ingrid again.'),
            asstMsg('Kai waits for Ingrid to answer.'),
            asstMsg('Kai tries once more.'),
            asstMsg('Kai sighs and looks away.'),
        ];
        const d = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        const sig = d.signals.find(s => s.kind === 'one-directional');
        expect(sig).toBeDefined();
        expect(sig!.npcName).toBe('Ingrid');
        expect(sig!.priority).toBe(2);
        expect(sig!.detail).toMatch(/relation to PC is \+2/);
        expect(sig!.detail).toMatch(/has not initiated/);
    });

    it('does not fire when NPC initiates in at least one of the last 5', () => {
        const ingrid = npcEntry({ pcRelation: 2 });
        const msgs = [
            asstMsg('Kai asks Ingrid a question.'),
            asstMsg('Kai presses Ingrid again.'),
            asstMsg('Ingrid finally turns to Kai.'),   // NPC name appears before PC → initiates
            asstMsg('Kai waits.'),
            asstMsg('Kai sighs.'),
        ];
        const d = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        expect(d.signals.find(s => s.kind === 'one-directional')).toBeUndefined();
    });

    it('does not fire when pcRelation is neutral or hostile (below threshold)', () => {
        const ingrid = npcEntry({ pcRelation: 0 });
        const msgs = [
            asstMsg('Kai asks Ingrid a question.'),
            asstMsg('Kai presses Ingrid again.'),
            asstMsg('Kai waits.'),
            asstMsg('Kai tries once more.'),
            asstMsg('Kai sighs.'),
        ];
        const d = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        expect(d.signals.find(s => s.kind === 'one-directional')).toBeUndefined();
    });

    it('falls back to legacy affinity when pcRelation is undefined (>=56 maps to +1)', () => {
        const ingrid = npcEntry({ pcRelation: undefined, affinity: 70 });
        const msgs = [
            asstMsg('Kai asks Ingrid a question.'),
            asstMsg('Kai presses Ingrid again.'),
            asstMsg('Kai waits.'),
            asstMsg('Kai tries once more.'),
            asstMsg('Kai sighs.'),
        ];
        const d = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        const sig = d.signals.find(s => s.kind === 'one-directional');
        expect(sig).toBeDefined();
        // Detail should reflect the resolved +1 from affinity fallback.
        expect(sig!.detail).toMatch(/\+1/);
    });

    it('treats NPC-named-first (PC never named) as initiating', () => {
        // No PC entry in the ledger → pcPatterns is empty → the watchdog treats
        // the PC as never-named, so any NPC-named message counts as initiating.
        const ingrid = npcEntry({ pcRelation: 1 });
        const msgs = [
            asstMsg('Ingrid turns to face the room.'),
            asstMsg('Ingrid clears her throat.'),
            asstMsg('The fire crackles.'),
            asstMsg('Kai waits.'),
            asstMsg('Kai sighs.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        // The first two messages have Ingrid as the first named entity and PC
        // never appears → counts as initiating → no signal.
        expect(d.signals.find(s => s.kind === 'one-directional')).toBeUndefined();
    });

    it('does not fire if there are no assistant messages in the window', () => {
        const ingrid = npcEntry({ pcRelation: 3 });
        const d = buildWatchdogDossier(input([userMsg('Kai does something.')], [ingrid]));
        expect(d.signals.find(s => s.kind === 'one-directional')).toBeUndefined();
    });
});

// ── Tests: interrupted-goal ──────────────────────────────────────────────────

describe('directorWatchdog — interrupted-goal', () => {
    it('fires when active goal keywords are absent from last 5 messages', () => {
        const ingrid = npcEntry({
            goalRecords: [activeGoal('Assassinate the magistrate')],
        });
        const msgs = [
            asstMsg('Kai eats a sandwich.'),
            userMsg('Kai walks to the tavern.'),
            asstMsg('The fire crackles.'),
            userMsg('Kai orders an ale.'),
            asstMsg('Kai sips quietly.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        const sig = d.signals.find(s => s.kind === 'interrupted-goal');
        expect(sig).toBeDefined();
        expect(sig!.npcName).toBe('Ingrid');
        expect(sig!.priority).toBe(1);
        expect(sig!.detail).toContain('Assassinate the magistrate');
    });

    it('does not fire when goal keyword appears in last 5 messages', () => {
        const ingrid = npcEntry({
            goalRecords: [activeGoal('Assassinate the magistrate')],
        });
        const msgs = [
            asstMsg('Kai eats a sandwich.'),
            asstMsg('Ingrid mentions the magistrate briefly.'),
            asstMsg('The fire crackles.'),
            userMsg('Kai orders an ale.'),
            asstMsg('Kai sips quietly.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        expect(d.signals.find(s => s.kind === 'interrupted-goal')).toBeUndefined();
    });

    it('skips non-active goals (achieved/blocked/retired)', () => {
        const ingrid = npcEntry({
            goalRecords: [
                activeGoal('Active goal alpha', { state: 'achieved' }),
                activeGoal('Retired goal beta', { state: 'retired' }),
                activeGoal('Blocked goal gamma', { state: 'blocked' }),
            ],
        });
        const msgs = [
            asstMsg('Nothing relevant.'),
            userMsg('Nothing relevant.'),
            asstMsg('Nothing relevant.'),
            userMsg('Nothing relevant.'),
            asstMsg('Nothing relevant.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        expect(d.signals.find(s => s.kind === 'interrupted-goal')).toBeUndefined();
    });

    it('fires once per active goal that is interrupted', () => {
        const ingrid = npcEntry({
            goalRecords: [
                activeGoal('Find the lost amulet'),
                activeGoal('Befriend the librarian'),
            ],
        });
        const msgs = [
            asstMsg('Quiet night.'),
            userMsg('Kai walks.'),
            asstMsg('Kai eats.'),
            userMsg('Kai drinks.'),
            asstMsg('Kai sleeps.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        const sigs = d.signals.filter(s => s.kind === 'interrupted-goal');
        expect(sigs).toHaveLength(2);
        expect(sigs.map(s => s.detail).sort()).toEqual([
            'active goal "Befriend the librarian" has not surfaced in the last 5 messages.',
            'active goal "Find the lost amulet" has not surfaced in the last 5 messages.',
        ]);
    });

    it('uses word-boundary keyword match (>=4 chars only)', () => {
        // "war" is 3 chars and must be filtered out as a keyword, so a goal text
        // containing only short words should produce no signal (no keywords to miss).
        const ingrid = npcEntry({
            goalRecords: [activeGoal('the war of the roses')],
        });
        const msgs = [
            asstMsg('Nothing here.'),
            userMsg('Nothing here.'),
            asstMsg('Nothing here.'),
            userMsg('Nothing here.'),
            asstMsg('Nothing here.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        // "war" (3), "roses" (5) — "roses" is a keyword and absent → signal fires.
        const sig = d.signals.find(s => s.kind === 'interrupted-goal');
        expect(sig).toBeDefined();
    });
});

// ── Tests: priority ordering & dossier text ─────────────────────────────────

describe('directorWatchdog — priority ordering & dossier text', () => {
    it('sorts signals by priority ascending (1 = highest priority first)', () => {
        const ingrid = npcEntry({
            pcRelation: 2,
            goalRecords: [activeGoal('Recover the stolen ledger')],
        });
        // All three signals fire:
        //  - interrupted-goal (priority 1)
        //  - one-directional (priority 2)
        //  - silent-npc (priority 3)
        const msgs = [
            asstMsg('Kai asks Ingrid a question.'),
            asstMsg('Kai presses Ingrid again.'),
            asstMsg('Kai waits.'),
            asstMsg('Kai tries once more.'),
            asstMsg('Kai sighs.'),
        ];
        const d = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        const kinds = d.signals.map(s => s.kind);
        expect(kinds).toEqual(['interrupted-goal', 'one-directional', 'silent-npc']);
        const priorities = d.signals.map(s => s.priority);
        expect(priorities).toEqual([1, 2, 3]);
    });

    it('breaks priority ties by kind then by npcName (stable)', () => {
        // Two NPCs each with an interrupted goal — same priority 1.
        const a = npcEntry({ id: 'npc_a', name: 'Zara', goalRecords: [activeGoal('Alpha goal')] });
        const b = npcEntry({ id: 'npc_b', name: 'Aaron', goalRecords: [activeGoal('Beta goal')] });
        const msgs = [
            asstMsg('Nothing relevant here.'),
            userMsg('Nothing relevant.'),
            asstMsg('Nothing relevant.'),
            userMsg('Nothing relevant.'),
            asstMsg('Nothing relevant.'),
        ];
        const d = buildWatchdogDossier({
            messages: msgs,
            npcLedger: [a, b],
            onStageNpcIds: ['npc_a', 'npc_b'],
        });
        const sigs = d.signals.filter(s => s.kind === 'interrupted-goal');
        expect(sigs).toHaveLength(2);
        // Tie on priority, tie on kind → ordered by name ascending: Aaron before Zara.
        expect(sigs[0].npcName).toBe('Aaron');
        expect(sigs[1].npcName).toBe('Zara');
    });

    it('dossierText has one line per signal, nudgeText surfaces highest priority', () => {
        const ingrid = npcEntry({
            pcRelation: 1,
            goalRecords: [activeGoal('Recover the stolen ledger')],
        });
        const msgs = [
            asstMsg('Kai asks Ingrid a question.'),
            asstMsg('Kai presses Ingrid again.'),
            asstMsg('Kai waits.'),
            asstMsg('Kai tries once more.'),
            asstMsg('Kai sighs.'),
        ];
        const d = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        const lines = d.dossierText.split('\n');
        expect(lines).toHaveLength(3);
        expect(lines.every(l => l.startsWith('- '))).toBe(true);
        // Highest priority (1 = interrupted-goal) becomes the nudge.
        expect(d.nudgeText).toContain('STAGE NOTE');
        expect(d.nudgeText).toContain('Ingrid');
        expect(d.nudgeText).toContain('Recover the stolen ledger');
    });

    it('nudgeText formats silent-npc with the streak count', () => {
        const ingrid = npcEntry();
        const msgs = [
            asstMsg('Quiet.'),
            asstMsg('Quiet again.'),
            asstMsg('Quiet once more.'),
            asstMsg('Still quiet.'),
        ];
        const d = buildWatchdogDossier(input(msgs, [ingrid]));
        // Only silent-npc fires (pcRelation 0 → no one-directional; no goals).
        expect(d.nudgeText).toBe(
            '[STAGE NOTE: Ingrid has been silent 3 turns — must act or speak this scene.]',
        );
    });

    it('nudgeText for one-directional uses a directive phrasing', () => {
        const ingrid = npcEntry({ pcRelation: 1 });
        const msgs = [
            asstMsg('Kai asks Ingrid a question.'),
            asstMsg('Kai presses Ingrid again.'),
            asstMsg('Kai waits.'),
            asstMsg('Kai tries once more.'),
            asstMsg('Kai sighs.'),
        ];
        const d = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        expect(d.nudgeText).toBe(
            '[STAGE NOTE: Ingrid has not initiated toward the PC recently — give Ingrid a beat to reach out this scene.]',
        );
    });
});

// ── Tests: determinism ───────────────────────────────────────────────────────

describe('directorWatchdog — determinism', () => {
    it('same inputs produce identical outputs across repeated calls', () => {
        const ingrid = npcEntry({
            pcRelation: 1,
            goalRecords: [activeGoal('Find the artifact')],
        });
        const msgs = [
            asstMsg('Kai asks Ingrid a question.'),
            asstMsg('Kai presses Ingrid again.'),
            asstMsg('Kai waits.'),
            asstMsg('Kai tries once more.'),
            asstMsg('Kai sighs.'),
        ];
        const a = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        const b = buildWatchdogDossier(inputWithPc(msgs, [ingrid]));
        expect(b).toEqual(a);
    });
});