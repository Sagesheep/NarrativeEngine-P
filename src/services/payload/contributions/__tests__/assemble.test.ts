import { describe, it, expect } from 'vitest';
import { assembleContributions } from '../assemble';
import type { ContributionSpec } from '../types';

const spec = (over: Partial<ContributionSpec> & Pick<ContributionSpec, 'id' | 'order' | 'text'>): ContributionSpec => ({
    slot: 'final-user',
    source: 'builtin',
    ...over,
});

describe('assembleContributions — ordering and joining', () => {
    it('joins active contributions in `order`, separated by a blank line', () => {
        const result = assembleContributions([
            spec({ id: 'c', order: 300, text: 'third' }),
            spec({ id: 'a', order: 100, text: 'first' }),
            spec({ id: 'b', order: 200, text: 'second' }),
        ]);

        expect(result.text).toBe('first\n\nsecond\n\nthird');
        expect(result.included).toEqual(['a', 'b', 'c']);
    });

    it('drops contributions that rendered empty text', () => {
        const result = assembleContributions([
            spec({ id: 'a', order: 100, text: 'kept' }),
            spec({ id: 'b', order: 200, text: '' }),
        ]);

        expect(result.text).toBe('kept');
        expect(result.included).toEqual(['a']);
    });

    it('keeps declaration order for equal `order` values (stable sort)', () => {
        const result = assembleContributions([
            spec({ id: 'x', order: 100, text: 'x' }),
            spec({ id: 'y', order: 100, text: 'y' }),
            spec({ id: 'z', order: 100, text: 'z' }),
        ]);

        expect(result.included).toEqual(['x', 'y', 'z']);
    });
});

describe('assembleContributions — suppression', () => {
    it('removes a suppressed contribution and records who removed it', () => {
        const result = assembleContributions([
            spec({ id: 'watchdog', order: 100, text: 'nudge' }),
            spec({ id: 'absolute', order: 200, text: 'command', suppresses: ['watchdog'] }),
        ]);

        expect(result.text).toBe('command');
        expect(result.suppressed).toEqual([{ id: 'watchdog', by: 'absolute' }]);
    });

    it('suppresses backwards as well as forwards (order is not precedence)', () => {
        // Mirrors production: Absolute Command sits LAST but suppresses GM_REMINDER above it.
        const result = assembleContributions([
            spec({ id: 'reminder', order: 100, text: 'reminder' }),
            spec({ id: 'absolute', order: 900, text: 'command', suppresses: ['reminder'] }),
        ]);

        expect(result.text).toBe('command');
    });

    it('an INACTIVE contribution suppresses nothing', () => {
        const result = assembleContributions([
            spec({ id: 'watchdog', order: 100, text: 'nudge' }),
            spec({ id: 'absolute', order: 200, text: '', suppresses: ['watchdog'] }),
        ]);

        expect(result.text).toBe('nudge');
        expect(result.suppressed).toEqual([]);
    });

    it('single pass, no cascade: a suppressed suppressor still exerts its suppression', () => {
        // Documented semantics (types.ts). `b` is killed by `a`, but `b`'s own kill of `c` stands.
        const result = assembleContributions([
            spec({ id: 'a', order: 100, text: 'a', suppresses: ['b'] }),
            spec({ id: 'b', order: 200, text: 'b', suppresses: ['c'] }),
            spec({ id: 'c', order: 300, text: 'c' }),
        ]);

        expect(result.text).toBe('a');
    });

    it('tolerates suppressing an id that is not present', () => {
        const result = assembleContributions([
            spec({ id: 'a', order: 100, text: 'a', suppresses: ['nope'] }),
        ]);

        expect(result.text).toBe('a');
        expect(result.suppressed).toEqual([]);
    });

    it('mutual suppression is deterministic and terminates', () => {
        const result = assembleContributions([
            spec({ id: 'a', order: 100, text: 'a', suppresses: ['b'] }),
            spec({ id: 'b', order: 200, text: 'b', suppresses: ['a'] }),
        ]);

        // Both kill each other in the single pass; neither survives. No hang, no throw.
        expect(result.text).toBe('');
        expect(result.included).toEqual([]);
    });
});

describe('assembleContributions — budget', () => {
    it('leaves contributions without a declared budget completely untouched', () => {
        const long = 'word '.repeat(500);
        const result = assembleContributions([spec({ id: 'a', order: 100, text: long })]);

        // This is the property that keeps the built-in migration byte-identical.
        expect(result.text).toBe(long);
        expect(result.trimmed).toEqual([]);
    });

    it('trims a contribution that exceeds its budget, and records it', () => {
        const long = 'word '.repeat(500);
        const result = assembleContributions([
            spec({ id: 'a', order: 100, text: long, source: 'mod', budget: 20 }),
        ]);

        expect(result.text.length).toBeLessThan(long.length);
        expect(result.trimmed).toHaveLength(1);
        expect(result.trimmed[0].id).toBe('a');
        expect(result.trimmed[0].toTokens).toBeLessThanOrEqual(20);
    });

    it('does not trim a contribution already within its budget', () => {
        const result = assembleContributions([
            spec({ id: 'a', order: 100, text: 'short', source: 'mod', budget: 1000 }),
        ]);

        expect(result.text).toBe('short');
        expect(result.trimmed).toEqual([]);
    });

    it('drops a contribution entirely when its budget is zero', () => {
        const result = assembleContributions([
            spec({ id: 'a', order: 100, text: 'anything', source: 'mod', budget: 0 }),
            spec({ id: 'b', order: 200, text: 'kept' }),
        ]);

        expect(result.text).toBe('kept');
        expect(result.included).toEqual(['b']);
    });
});

describe('assembleContributions — traces', () => {
    it('emits a trace only for contributions that declared trace metadata', () => {
        const result = assembleContributions([
            spec({ id: 'quiet', order: 100, text: 'no trace here' }),
            spec({
                id: 'loud', order: 200, text: 'traced',
                trace: { source: 'Director', classification: 'world_context', reason: 'because' },
            }),
        ]);

        expect(result.traces).toHaveLength(1);
        expect(result.traces[0]).toMatchObject({
            source: 'Director',
            classification: 'world_context',
            reason: 'because',
            included: true,
            position: 'user',
            preview: 'traced',
        });
        expect(result.traces[0].tokens).toBeGreaterThan(0);
    });

    it('does not trace a suppressed contribution', () => {
        const result = assembleContributions([
            spec({
                id: 'victim', order: 100, text: 'gone',
                trace: { source: 'Watchdog', classification: 'world_context', reason: 'r' },
            }),
            spec({ id: 'killer', order: 200, text: 'wins', suppresses: ['victim'] }),
        ]);

        expect(result.traces).toEqual([]);
    });

    it('traces reflect the trimmed text, not the original', () => {
        const long = 'word '.repeat(500);
        const result = assembleContributions([
            spec({
                id: 'a', order: 100, text: long, source: 'mod', budget: 15,
                trace: { source: 'Mod', classification: 'world_context', reason: 'r' },
            }),
        ]);

        expect(result.traces[0].tokens).toBeLessThanOrEqual(15);
        expect(result.traces[0].preview).toBe(result.text);
    });
});

describe('assembleContributions — the no-feature-names rule', () => {
    /**
     * The arbiter must never branch on WHICH contribution it holds. Proven by running an
     * identical corpus twice — once with production-shaped ids, once with every id (and every
     * `suppresses` reference) replaced by an opaque string — and asserting the assembled text
     * is byte-identical and the include/suppress structure is isomorphic.
     *
     * If someone adds `if (id === 'director.brief')` to assemble.ts, this test fails.
     */
    const corpus = (name: (real: string) => string): ContributionSpec[] => [
        spec({ id: name('volatile.block'), order: 100, text: 'WORLD STATE' }),
        spec({ id: name('writer.cot'), order: 200, text: 'think first' }),
        spec({
            id: name('director.brief'), order: 300, text: '[DIRECTOR BRIEF]\nlean in',
            suppresses: [name('watchdog.nudge')],
            trace: { source: 'Director', classification: 'world_context', reason: 'brief' },
        }),
        spec({ id: name('gm.reminder'), order: 400, text: '[GM REMINDER: ...]' }),
        spec({
            id: name('watchdog.nudge'), order: 500, text: '[STAGE NOTE] push back',
            trace: { source: 'Watchdog', classification: 'world_context', reason: 'nudge' },
        }),
        spec({ id: name('user.message'), order: 700, text: 'I open the door.' }),
        spec({
            id: name('absolute.command'), order: 800, text: '[USER ABSOLUTE COMMAND]\nbe brief',
            suppresses: [name('gm.reminder'), name('watchdog.nudge')],
            trace: { source: 'Absolute Command', classification: 'world_context', reason: 'cmd' },
        }),
    ];

    it('produces identical output when every id is replaced by an opaque string', () => {
        const real = assembleContributions(corpus((r) => r));

        const opaque = new Map<string, string>();
        let n = 0;
        const anonymise = (r: string): string => {
            if (!opaque.has(r)) opaque.set(r, `op_${n++}`);
            return opaque.get(r)!;
        };
        const anon = assembleContributions(corpus(anonymise));

        expect(anon.text).toBe(real.text);
        expect(anon.included).toEqual(real.included.map((id) => opaque.get(id)));
        expect(anon.traces).toEqual(real.traces);
        expect(anon.suppressed).toEqual(
            real.suppressed.map(({ id, by }) => ({ id: opaque.get(id), by: opaque.get(by) })),
        );
    });

    it('reproduces production precedence: Absolute Command outranks reminder and watchdog', () => {
        const result = assembleContributions(corpus((r) => r));

        expect(result.included).toEqual([
            'volatile.block', 'writer.cot', 'director.brief', 'user.message', 'absolute.command',
        ]);
        expect(result.included).not.toContain('gm.reminder');
        expect(result.included).not.toContain('watchdog.nudge');
    });
});
