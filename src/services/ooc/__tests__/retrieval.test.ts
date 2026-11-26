import { describe, expect, it } from 'vitest';
import { shouldSearchOoc } from '../retrieval';

describe('shouldSearchOoc', () => {
    it('pre-searches obvious record, lore, rule, and named-record questions', () => {
        expect(shouldSearchOoc('What happened earlier in the archive?')).toBe(true);
        expect(shouldSearchOoc('What do the rules say about resting?')).toBe(true);
        expect(shouldSearchOoc('What does Mira know?')).toBe(true);
    });

    it('honours manual force-search without making every normal question a retrieval request', () => {
        expect(shouldSearchOoc('Can you summarize the current position?')).toBe(false);
        expect(shouldSearchOoc('Can you summarize the current position?', true)).toBe(true);
    });
});