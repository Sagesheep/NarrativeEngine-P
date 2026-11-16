import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyAction, applyOrders, buildPcCombatant, createCombat } from '@narrative/engine';
import type { CombatEvent, CombatState } from '@narrative/engine';
import { applyLocale } from '../../../i18n';
import { handleStartCombatTool } from '../../turn/toolHandlers';
import { isOfficer, officerFlag, parseCombatArgs, parseOfficer, parseSignature, signatureToolNotes } from '../combatProposal';
import { buildAftermathText, buildCombatantSpecs, postPendingLog } from '../combatController';
import { buildCombatBlock, directiveForRange, spokenLines } from '../combatNarration';
import { momentTags, narrationLine } from '../combatEvents';
import { directorOutcomeLines, orderLogText } from '../directorStory';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import type { CombatSession, CombatSheet, NPCEntry } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };
const LEDGER = [{ id: 'npc-vey', name: 'Captain Vey' } as NPCEntry];
const LOOKUP = { modTables: {}, settings: { moduleEnabled: {} } } as never;

function fight(): { state: CombatState; log: CombatEvent[]; vey: string } {
    const pc = buildPcCombatant({ name: 'Kira', sheet });
    const made = createCombat({
        id: 'h', mapSeed: 4,
        combatants: [{ name: 'Captain Vey', side: 'enemy', tier: 'elite', signature: { name: 'Iron Rain', form: 'touch', effects: [{ id: 'damage' }] } }],
    }, pc, 9);
    const vey = Object.values(made.state.combatants).find(c => c.name === 'Captain Vey')?.id as string;
    return { state: made.state, log: [...made.events], vey };
}

function session(state: CombatState, log: CombatEvent[]): CombatSession {
    return { state, log, narratedThroughSeq: 0, postedThroughSeq: 0, startedAtMessageId: 'gm', reason: 'Ambush' };
}

beforeEach(() => applyLocale('en'));
afterEach(() => {
    cancelPendingSaves();
    vi.restoreAllMocks();
});

describe('start_combat: officer and signature', () => {
    it('parses officer as a boolean or a yes/no word, and a signature as an object or a JSON string', () => {
        expect(parseOfficer(true)).toBe(true);
        expect(parseOfficer('yes')).toBe(true);
        expect(parseOfficer('false')).toBe(false);
        expect(parseOfficer('maybe')).toBeUndefined();
        expect(parseSignature({ name: 'Iron Rain', form: 'projectile', effects: ['damage', 'slow'] }))
            .toEqual({ name: 'Iron Rain', form: 'projectile', augments: [], effects: [{ id: 'damage', augments: [] }, { id: 'slow', augments: [] }] });
        expect(parseSignature('{"name":"Gut Punch","form":"touch","effects":["damage"]}')?.name).toBe('Gut Punch');
        expect(parseSignature('nonsense')).toBeUndefined();
    });

    it('carries officer and signature on the proposed combatant and leaves them off when absent', () => {
        const parsed = parseCombatArgs(JSON.stringify({
            reason: 'Ambush',
            combatants: [
                { name: 'Sergeant Hask', tier: 'grunt', officer: true, signature: { name: 'Shield Bash', form: 'touch', effects: ['damage', 'push'] } },
                { name: 'Thug' },
            ],
        }));
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.combatants[0]).toMatchObject({ officer: true, signature: { name: 'Shield Bash', form: 'touch' } });
        expect(parsed.value.combatants[1]).not.toHaveProperty('officer');
        expect(parsed.value.combatants[1]).not.toHaveProperty('signature');
    });

    it('marks ledger NPCs as officers unless the model says otherwise, and never neutrals', () => {
        const parsed = parseCombatArgs(JSON.stringify({ reason: 'x', combatants: [{ name: 'Vey', npcName: 'Captain Vey' }, { name: 'Thug' }] }), LEDGER);
        if (!parsed.ok) throw new Error('parse');
        const [vey, thug] = parsed.value.combatants;
        expect(officerFlag(vey)).toBe(true);
        expect(officerFlag({ ...vey, officer: false })).toBe(false);
        expect(officerFlag(thug)).toBeUndefined();
        expect(isOfficer(thug)).toBe(false);
        expect(isOfficer({ ...thug, tier: 'boss' })).toBe(true);
        expect(isOfficer({ ...vey, side: 'neutral' })).toBe(false);
        const specs = buildCombatantSpecs(parsed.value.combatants, LOOKUP);
        expect(specs[0]).toMatchObject({ npcId: 'npc-vey', directed: true });
        expect(specs[1]).not.toHaveProperty('directed');
    });

    it('hands officer and signature to the engine spec', () => {
        const specs = buildCombatantSpecs([{ name: 'Hask', side: 'enemy', tier: 'elite', officer: false, signature: { name: 'Bash', form: 'touch', effects: [{ id: 'damage' }] } }], LOOKUP);
        expect(specs[0]).toMatchObject({ directed: false, signature: { name: 'Bash', form: 'touch' } });
    });

    it('tells the model in the tool result how a signature was repaired, and stays silent when nothing changed', () => {
        const repaired = handleStartCombatTool(JSON.stringify({
            reason: 'x',
            combatants: [
                { name: 'Vey', tier: 'elite', signature: { name: 'Doom', form: 'burst', augments: ['widen'], effects: ['damage', 'stun'] } },
                { name: 'Rat', tier: 'minion', signature: { name: 'Bite', form: 'touch', effects: ['damage'] } },
            ],
        }));
        expect(repaired.toolResult).toContain('Signature moves were adjusted');
        expect(repaired.toolResult).toContain('Rat is a minion');
        expect(repaired.toolResult).toMatch(/Vey's signature "Doom"/);
        const clean = handleStartCombatTool(JSON.stringify({ reason: 'x', combatants: [{ name: 'Vey', tier: 'elite', signature: { name: 'Jab', form: 'touch', effects: ['damage'] } }] }));
        expect(clean.toolResult).not.toContain('Signature moves');
        expect(signatureToolNotes([{ name: 'Vey', side: 'enemy', tier: 'elite' }])).toEqual([]);
    });
});

describe('orders in the log, the narration and the outcome', () => {
    it('writes the order in plain translated words, with the spoken line', () => {
        const { state, vey } = fight();
        const r = applyOrders(state, [{ unitId: vey, kind: 'focus', targetId: 'pc', line: 'Cut her down!' }]);
        expect(orderLogText(r.events[0], r.state)).toBe('Captain Vey orders: focus Kira — “Cut her down!”');
        const hold = applyOrders(state, [{ unitId: vey, kind: 'switch_tactic', tactic: 'guard' }]);
        expect(orderLogText(hold.events[0], hold.state)).toBe('Captain Vey orders: switch to guard tactics');
        applyLocale('pl');
        expect(orderLogText(r.events[0], r.state)).toBe('Captain Vey rozkazuje: skupić się na Kira — „Cut her down!”');
    });

    it('posts the translated line to the combat log once the turn is done', () => {
        const { state, log, vey } = fight();
        useAppStore.setState({ activeCampaignId: 'c1', messages: [] });
        const r = applyOrders(state, [{ unitId: vey, kind: 'hold', line: 'Stand fast.' }]);
        const done = { ...r.state, turnCount: (r.state.turnCount ?? 0) + 1 };
        postPendingLog(session(done, [...log, ...r.events]));
        const posted = useAppStore.getState().messages.filter(m => m.name === 'combat-log').map(m => m.content).join('\n');
        expect(posted).toContain('Captain Vey orders: hold position — “Stand fast.”');
    });

    it('gives the beat the spoken lines, a rule to quote them, a narration line and a moment tag', () => {
        const { state, log, vey } = fight();
        const r = applyOrders(state, [{ unitId: vey, kind: 'press', line: 'No mercy!' }]);
        const all = [...log, ...r.events];
        const seq = r.events[0].seq;
        const range = { fromSeq: seq, toSeq: seq };
        expect(spokenLines(r.state, all, range)).toEqual(['- Captain Vey: "No mercy!"']);
        const block = buildCombatBlock(r.state, all, range);
        expect(block).toContain('Spoken:\n- Captain Vey: "No mercy!"');
        expect(block).toContain('Captain Vey throws caution aside to press the attack. Captain Vey calls out: "No mercy!" [an officer gives an order]');
        expect(directiveForRange(session(r.state, all), range, 'side', 'standard')).toContain('quote them word for word');
        expect(momentTags(r.state, all, seq).get(seq)).toBe('an officer gives an order');
        expect(narrationLine(r.events[0], r.state)).not.toMatch(/\d/);
        const quiet = applyOrders(state, [{ unitId: vey, kind: 'hold' }]);
        expect(spokenLines(quiet.state, [...log, ...quiet.events], { fromSeq: quiet.events[0].seq, toSeq: quiet.events[0].seq })).toEqual([]);
        expect(directiveForRange(session(quiet.state, [...log, ...quiet.events]), { fromSeq: quiet.events[0].seq, toSeq: quiet.events[0].seq }, 'side', 'standard')).not.toContain('quote them word for word');
    });

    it('tells the story model which officer gave which orders and whether a signature was used', () => {
        const { state, log, vey } = fight();
        const one = applyOrders(state, [{ unitId: vey, kind: 'focus', targetId: 'pc' }]);
        const two = applyOrders({ ...one.state, round: 2 }, [{ unitId: vey, kind: 'signature' }]);
        const pcPos = { x: 5, y: 5 };
        const ready: CombatState = {
            ...two.state, order: [vey, 'pc'], turnIndex: 0, turn: { actorId: vey, moveLeft: 6, actionUsed: false },
            combatants: { ...two.state.combatants, [vey]: { ...two.state.combatants[vey], position: { x: 4, y: 5 } }, pc: { ...two.state.combatants.pc, position: pcPos, hp: 90, maxHp: 90 } },
        };
        const used = applyAction(ready, { type: 'use_ability', actorId: vey, abilityId: `sig-${vey}`, aim: pcPos });
        const s = session({ ...used.state, outcome: 'victory' }, [...log, ...one.events, ...two.events, ...used.events]);
        expect(directorOutcomeLines(s)).toEqual(['Officers: Captain Vey (orders focus Kira, then use Iron Rain; used Iron Rain).']);
        expect(buildAftermathText(s)).toContain('Officers: Captain Vey (orders focus Kira, then use Iron Rain; used Iron Rain).');
        expect(directorOutcomeLines(session(state, log))).toEqual([]);
    });
});
