/**
 * `buildComputeBinding` — how a compute mod's `export default` becomes
 * `globalThis.__sandboxMod`.
 *
 * The binding used to find the default export by GUESSING its identifier from
 * a hardcoded list: `["arcCompute", "compute", "tick", "default"]`. So the host
 * carried a reference to one specific mod's internal function name, and a mod
 * whose default export was named anything else never loaded — the worker threw
 * "[sandbox] compute source must export a default function" on every turn, with
 * nothing in the message to suggest the name was the problem.
 *
 * The Arc Engine's tick ran only because its function is called `arcCompute`,
 * which is to say it ran by coincidence. Renaming that function — in a file
 * that never mentions the sandbox — would have silently killed the post-turn
 * tick, and the mod would have looked installed and enabled the whole time.
 *
 * These cases run the produced statement the way the worker does: evaluate it,
 * then read `globalThis.__sandboxMod` back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildComputeBinding } from '../workerPrelude';

/** Evaluate a binding statement in its own scope and return what it bound. */
function bind(modSource: string): unknown {
    const statement = buildComputeBinding(modSource);
    return new Function(`${statement}\nreturn globalThis.__sandboxMod;`)();
}

describe('buildComputeBinding — resolving the default export', () => {
    it('binds a default export whose name it has never heard of', () => {
        const source = [
            'const GREETING = "hi";',
            'function helper(n) { return n + 1; }',
            'export default async function enemiesCompute(ctx) { return helper(ctx.n); }',
        ].join('\n');

        const bound = bind(source);
        expect(typeof bound).toBe('function');
        expect((bound as { name: string }).name).toBe('enemiesCompute');
    });

    it('binds the real arc tick — by reading its name, not by matching a list', () => {
        const arcSource = readFileSync(resolve(process.cwd(), 'mods/arc/compute.js'), 'utf8');

        const bound = bind(arcSource);
        expect(typeof bound).toBe('function');
        expect((bound as { name: string }).name).toBe('arcCompute');
        // The name is no longer written into the host. If it were, this mod
        // would keep working while every other mod stayed broken — which is
        // exactly the state this test was added to end.
        expect(buildComputeBinding(arcSource)).not.toContain('"arcCompute","arcCompute"');
    });

    it('still binds an anonymous default export at the top of a file', () => {
        const bound = bind('export default async function (ctx) { return ctx; }');
        expect(typeof bound).toBe('function');
    });

    it('binds a default export that re-exports a function declared above it', () => {
        const source = [
            'async function tickTheWorld(ctx) { return ctx; }',
            'export default tickTheWorld;',
        ].join('\n');

        const bound = bind(source);
        expect(typeof bound).toBe('function');
        expect((bound as { name: string }).name).toBe('tickTheWorld');
    });

    it('keeps the conventional fallbacks for a source it cannot name', () => {
        // An arrow at the bottom is nameless, but the file also declares a
        // conventionally-named `compute` — the fallback that survives.
        const source = [
            'async function compute(ctx) { return ctx; }',
            'export default async (ctx) => compute(ctx);',
        ].join('\n');

        const bound = bind(source);
        expect(typeof bound).toBe('function');
        expect((bound as { name: string }).name).toBe('compute');
    });

    it('binds nothing rather than throwing when the source has no default export', () => {
        expect(bind('export const NOT_A_HOOK = 1;')).toBeNull();
    });
});
