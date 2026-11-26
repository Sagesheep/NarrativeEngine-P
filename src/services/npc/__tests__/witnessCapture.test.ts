import { describe, expect, it, vi } from 'vitest';
import { mentionedNpcs, witnessesFromHeader, witnessesFromModel } from '../witnessCapture';
import type { NPCEntry } from '../../../types';

const npc = (id: string, name: string, aliases = '') => ({ id, name, aliases }) as NPCEntry;
const ledger = [npc('n1', 'Rin Holmes'), npc('n2', 'Helena Broadmarsh'), npc('n3', 'Therese Soll'), npc('n4', 'The Broker')];

describe('witnessesFromHeader', () => {
    it('trusts the 👥 line as written, in canonical names', () => {
        expect(witnessesFromHeader('📍 Study | 👥 [**Rin**], [**Helena**]', ledger)).toEqual(['Rin Holmes', 'Helena Broadmarsh']);
    });

    // Scene 577: the GM bolds every name, so the server counted Therese, who only
    // signed a letter on the table, as a speaker. The 👥 line is the authority.
    it('does not add a name that only appears in bracket markup elsewhere', () => {
        const gm = '👥 [**Grey**], [**Rin**]\n\n| **The Letter** | [**Therese Soll**]. Unopened. Inner sheet vellum. |';
        expect(witnessesFromHeader(gm, ledger)).toEqual(['Rin Holmes']);
    });

    it('"Nobody" means no witnesses', () => {
        expect(witnessesFromHeader('👥 Nobody', ledger)).toEqual([]);
    });

    it('null when the reply has no 👥 line', () => {
        expect(witnessesFromHeader('Rain on the window.', ledger)).toBeNull();
    });
});

describe('mentionedNpcs', () => {
    it('finds NPCs by a single capitalised name word, not by "The"', () => {
        const found = mentionedNpcs('Rin waits by the door. The rain falls. Helena never came.', ledger).map(n => n.id);
        expect(found).toEqual(['n1', 'n2']);
    });
});

describe('witnessesFromModel', () => {
    it('asks only about named NPCs, with thinking off, and keeps listed names only', async () => {
        const modelCall = vi.fn().mockResolvedValue({ content: '["Rin Holmes", "Someone Else"]' });
        const present = await witnessesFromModel('Rin reads the letter. She thinks of Helena, far away.', ledger, modelCall);

        expect(present.map(n => n.id)).toEqual(['n1']);
        const request = modelCall.mock.calls[0][0];
        expect(request.thinkingEffort).toBe('off');
        expect(request.prompt).toContain('- Rin Holmes');
        expect(request.prompt).toContain('- Helena Broadmarsh');
        expect(request.prompt).not.toContain('Therese');
    });

    it('makes no call when the reply names no known NPC', async () => {
        const modelCall = vi.fn();
        expect(await witnessesFromModel('Wind over empty fields.', ledger, modelCall)).toEqual([]);
        expect(modelCall).not.toHaveBeenCalled();
    });

    it('a failed call means no change', async () => {
        const modelCall = vi.fn().mockRejectedValue(new Error('timeout'));
        expect(await witnessesFromModel('Rin waits.', ledger, modelCall)).toEqual([]);
    });
});
