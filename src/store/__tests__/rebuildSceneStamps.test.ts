import { describe, it, expect } from 'vitest';
import { rebuildSceneStamps } from '../campaignHydrator';
import type { ChatMessage, ArchiveIndexEntry } from '../../types';

let seq = 0;
function user(text: string): ChatMessage {
    return { id: `u${++seq}`, role: 'user', content: text, timestamp: seq };
}
function assistant(sceneId?: string): ChatMessage {
    const m: ChatMessage = { id: `a${++seq}`, role: 'assistant', content: 'GM reply', timestamp: seq };
    return sceneId ? { ...m, sceneId } : m;
}
function entry(sceneId: string, userSnippet: string): ArchiveIndexEntry {
    return {
        sceneId, timestamp: 0, keywords: [], npcsMentioned: [], witnesses: [],
        userSnippet, importance: 5,
    } as ArchiveIndexEntry;
}

describe('rebuildSceneStamps', () => {
    it('is a no-op when every archived scene is already stamped', () => {
        const msgs = [user('go north'), assistant('001'), user('open the door'), assistant('002')];
        const idx = [entry('001', 'go north'), entry('002', 'open the door')];
        const { messages, changed } = rebuildSceneStamps(msgs, idx);
        expect(changed).toBe(0);
        expect(messages).toBe(msgs);   // same reference — nothing rewritten
    });

    it('no-ops on an empty archive or an empty message log', () => {
        expect(rebuildSceneStamps([user('hi'), assistant()], []).changed).toBe(0);
        expect(rebuildSceneStamps([], [entry('001', 'hi')]).changed).toBe(0);
    });

    it('recovers a stamp that never reached the client', () => {
        const msgs = [
            user('go north'), assistant('001'),
            user('open the door'), assistant(),      // ← append response was lost
            user('light a torch'), assistant('003'),
        ];
        const idx = [entry('001', 'go north'), entry('002', 'open the door'), entry('003', 'light a torch')];
        const { messages, changed } = rebuildSceneStamps(msgs, idx);
        expect(changed).toBe(1);
        expect(messages[3].sceneId).toBe('002');
        // Untouched messages keep their identity.
        expect(messages[1].sceneId).toBe('001');
        expect(messages[5].sceneId).toBe('003');
    });

    it('matches on a prefix, since userSnippet is only the first 120 raw chars', () => {
        const long = 'i walk carefully into the ruined hall and start looking for anything that survived the fire, checking the walls first';
        const msgs = [user(long), assistant()];
        const idx = [entry('001', long.slice(0, 120))];
        const { messages, changed } = rebuildSceneStamps(msgs, idx);
        expect(changed).toBe(1);
        expect(messages[1].sceneId).toBe('001');
    });

    it('ignores whitespace and case differences', () => {
        const msgs = [user('  Go   North\n'), assistant()];
        const { messages, changed } = rebuildSceneStamps(msgs, [entry('001', 'go north')]);
        expect(changed).toBe(1);
        expect(messages[1].sceneId).toBe('001');
    });

    // ── The conservative contract: a wrong stamp aims a destructive delete at
    //    the wrong scene, so ambiguity must always lose. ──

    it('leaves the stamp blank when the paired message is gone entirely', () => {
        const msgs = [user('go north'), assistant('001')];
        const idx = [entry('001', 'go north'), entry('002', 'a turn the player deleted')];
        const { messages, changed } = rebuildSceneStamps(msgs, idx);
        expect(changed).toBe(0);
        expect(messages.some(m => m.sceneId === '002')).toBe(false);
    });

    it('does not re-home an unmatched scene onto a neighbouring turn', () => {
        const msgs = [user('go north'), assistant('001'), user('light a torch'), assistant('003')];
        const idx = [entry('001', 'go north'), entry('002', 'deleted turn'), entry('003', 'light a torch')];
        const { messages } = rebuildSceneStamps(msgs, idx);
        expect(messages[1].sceneId).toBe('001');
        expect(messages[3].sceneId).toBe('003');   // NOT reassigned to 002
    });

    it('never overwrites a stamp that is already present', () => {
        const msgs = [user('go north'), assistant('007')];
        const { messages, changed } = rebuildSceneStamps(msgs, [entry('001', 'go north')]);
        expect(changed).toBe(0);
        expect(messages[1].sceneId).toBe('007');
    });

    it('gives up on repeated user text when nothing anchors it', () => {
        // "continue" three times, no stamps anywhere: every scene matches every
        // turn and there is no known scene to bound the search. Guessing here
        // would aim a later delete at the wrong scene, so recover nothing.
        const msgs = [
            user('continue'), assistant(),
            user('continue'), assistant(),
            user('continue'), assistant(),
        ];
        const idx = [entry('001', 'continue'), entry('002', 'continue'), entry('003', 'continue')];
        const { messages, changed } = rebuildSceneStamps(msgs, idx);
        expect(changed).toBe(0);
        expect(messages.every(m => !m.sceneId)).toBe(true);
    });

    it('resolves repeated user text when neighbouring scenes bound the search', () => {
        // Same repeated input, but 001 and 003 are located — so 002 must sit
        // between their turns, leaving exactly one candidate. Forced, not guessed.
        const msgs = [
            user('continue'), assistant('001'),
            user('continue'), assistant(),
            user('continue'), assistant('003'),
        ];
        const idx = [entry('001', 'continue'), entry('002', 'continue'), entry('003', 'continue')];
        const { messages, changed } = rebuildSceneStamps(msgs, idx);
        expect(changed).toBe(1);
        expect(messages[3].sceneId).toBe('002');
    });

    it('skips a turn that has no GM reply', () => {
        const msgs = [user('go north'), user('actually, go south'), assistant()];
        const idx = [entry('001', 'go north')];
        const { changed } = rebuildSceneStamps(msgs, idx);
        expect(changed).toBe(0);
    });

    it('is idempotent — a second pass changes nothing', () => {
        const msgs = [user('go north'), assistant(), user('open the door'), assistant()];
        const idx = [entry('001', 'go north'), entry('002', 'open the door')];
        const first = rebuildSceneStamps(msgs, idx);
        expect(first.changed).toBe(2);
        const second = rebuildSceneStamps(first.messages, idx);
        expect(second.changed).toBe(0);
        expect(second.messages).toBe(first.messages);
    });
});
