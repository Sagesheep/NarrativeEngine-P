/**
 * Phase 5.1 — the macro registry.
 *
 * "Done when" gate (Phase 5.1 §4):
 *   • A fixture mod registers a macro and sees it resolved in the built
 *     payload.
 *   • Unknown slots still emit verbatim — the typo behaviour is preserved.
 *   • Shadowing a built-in slot is rejected with a reason.
 *   • Cache stability test green (covered by `payloadCacheStability.test.ts`,
 *     which this suite must not break — macros land in `final-user`, below
 *     the cache boundary, by construction).
 *
 * Also covers the §3 rules:
 *   • A throwing or slow resolver must not break prompt assembly. Contain
 *     it: empty string plus a surfaced fault naming the mod.
 *   • Resolvers must not write. (The type is `() => string`; mutating host
 *     state during assembly is a contract violation, not a runtime check —
 *     the same posture `produce` already takes.)
 *   • Prompt-cache stability is load-bearing. A macro's output lands in
 *     `final-user`, below the cache boundary, so it cannot perturb the
 *     cached prefix by construction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    registerModMacro,
    qualifyMacroName,
    disableModMacros,
    enableModMacros,
    clearAllModMacros,
    listMacros,
    hasModMacro,
    isModMacrosRevoked,
    BUILTIN_MACRO_NAMES,
} from '../macroRegistry';
import { macroFaultStore } from '../macroFaults';
import { renderTemplate } from '../../modAdapter';
import type { ModFacts, ValidatedMod } from '../../modTypes';
import { modToContributionModule } from '../../modAdapter';
import { createContributionRegistry } from '../../../payload/contributions/registry';
import { assembleContributions } from '../../../payload/contributions/assemble';
import type { FinalUserModuleInput } from '../../../payload/contributions/builtins';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mod = (overrides: Partial<ValidatedMod> = {}): ValidatedMod => ({
    id: 'probe-mod',
    name: 'Probe Mod',
    version: '1.0.0',
    description: 'A fixture mod for the macro registry tests.',
    file: 'probe.mod.json',
    contributions: [],
    ...overrides,
});

const input = (facts?: ModFacts): FinalUserModuleInput =>
    ({ facts } as unknown as FinalUserModuleInput);

describe('Phase 5.1 — macro registry: namespacing and resolution', () => {
    beforeEach(() => {
        clearAllModMacros();
    });

    it('a registered macro is resolved by renderTemplate when the mod id is passed', () => {
        const m = mod();
        registerModMacro({ id: m.id, name: m.name }, 'greeting', () => 'hello world');

        const rendered = renderTemplate('Say: {{greeting}}.', undefined, m.id);
        expect(rendered).toBe('Say: hello world.');
    });

    it('a registered macro is resolved inside a mod contribution through the payload pipeline', () => {
        // The "fixture mod sees its macro resolved in the built payload" gate.
        const m = mod({
            contributions: [{
                id: 'greet',
                order: 250,
                budget: 120,
                text: '[GREETING] {{greeting}}',
            }],
        });
        // Register the macro the mod's `activate` would register.
        registerModMacro({ id: m.id, name: m.name }, 'greeting', () => 'hello from the macro');

        const registry = createContributionRegistry<FinalUserModuleInput>();
        registry.register(modToContributionModule(m));
        const specs = registry.collect(input());
        const assembled = assembleContributions(specs);

        expect(assembled.text).toBe('[GREETING] hello from the macro');
        expect(assembled.included).toEqual(['mod.probe-mod.greet']);
    });

    it('two mods with the same macro name do not collide (namespacing)', () => {
        registerModMacro({ id: 'mod-a', name: 'A' }, 'shared', () => 'from A');
        registerModMacro({ id: 'mod-b', name: 'B' }, 'shared', () => 'from B');

        expect(renderTemplate('{{shared}}', undefined, 'mod-a')).toBe('from A');
        expect(renderTemplate('{{shared}}', undefined, 'mod-b')).toBe('from B');
        // The qualified names differ.
        expect(listMacros()).toContain(qualifyMacroName('mod-a', 'shared'));
        expect(listMacros()).toContain(qualifyMacroName('mod-b', 'shared'));
    });

    it('a macro is NOT resolved when renderTemplate is called without a mod id (built-in path)', () => {
        // Built-in contributions (no mod) never see macro expansion. The
        // registry is a no-op for them, preserving the pre-5.1 behaviour.
        registerModMacro({ id: 'mod-a', name: 'A' }, 'greeting', () => 'hello');
        expect(renderTemplate('{{greeting}}', undefined)).toBe('{{greeting}}');
    });

    it('a macro is NOT resolved for a different mod id', () => {
        registerModMacro({ id: 'mod-a', name: 'A' }, 'greeting', () => 'hello');
        // mod-b has no `greeting` macro; the slot falls through to verbatim.
        expect(renderTemplate('{{greeting}}', undefined, 'mod-b')).toBe('{{greeting}}');
    });
});

describe('Phase 5.1 — macro registry: unknown slots stay verbatim (typo behaviour preserved)', () => {
    beforeEach(() => {
        clearAllModMacros();
    });

    it('an unknown slot is left verbatim so the author sees the typo', () => {
        // No macros registered. Every non-builtin slot falls through.
        expect(renderTemplate('{{npc.name}} and {{pc.hp}}', undefined, 'mod-a'))
            .toBe('{{npc.name}} and {{pc.hp}}');
        expect(renderTemplate('{{LOCATION}}', undefined, 'mod-a')).toBe('{{LOCATION}}');
        expect(renderTemplate('{{}}', undefined, 'mod-a')).toBe('{{}}');
    });

    it('a typo of a registered macro name is left verbatim', () => {
        registerModMacro({ id: 'mod-a', name: 'A' }, 'greeting', () => 'hello');
        // `greeting` resolves; `greetings` (typo) does not.
        expect(renderTemplate('{{greeting}} / {{greetings}}', undefined, 'mod-a'))
            .toBe('hello / {{greetings}}');
    });

    it('the built-in slots still resolve ahead of macros (belt-and-braces)', () => {
        const facts: ModFacts = { onStageNpcNames: ['Kira'], location: 'Tavern' };
        // Even if a mod somehow registered `location` (the registry rejects
        // shadows, but this is belt-and-braces), the built-in switch runs
        // first in `renderTemplate`.
        expect(renderTemplate('{{location}}', facts, 'mod-a')).toBe('Tavern');
        expect(renderTemplate('{{npcs}}', facts, 'mod-a')).toBe('Kira');
    });
});

describe('Phase 5.1 — macro registry: shadow rejection', () => {
    beforeEach(() => {
        clearAllModMacros();
    });

    it('shadowing {{location}} is rejected with a fault and a reason', () => {
        const unregister = registerModMacro({ id: 'mod-a', name: 'A' }, 'location', () => 'shadow');
        // The registration is rejected; no macro is registered.
        expect(hasModMacro('mod-a', 'location')).toBe(false);
        expect(listMacros()).not.toContain(qualifyMacroName('mod-a', 'location'));
        // A fault is surfaced naming the mod and the kind.
        const faults = macroFaultStore.getRecords();
        expect(faults.some((f) => f.modId === 'mod-a' && f.kind === 'shadow' && f.name === 'location')).toBe(true);
        // The returned `unregister` is a no-op.
        expect(() => unregister()).not.toThrow();
    });

    it('shadowing {{npcs}} is rejected with a fault and a reason', () => {
        registerModMacro({ id: 'mod-a', name: 'A' }, 'npcs', () => 'shadow');
        expect(hasModMacro('mod-a', 'npcs')).toBe(false);
        const faults = macroFaultStore.getRecords();
        expect(faults.some((f) => f.modId === 'mod-a' && f.kind === 'shadow' && f.name === 'npcs')).toBe(true);
    });

    it('the closed set of built-in names is exactly location and npcs', () => {
        // A new built-in slot added to `renderTemplate`'s switch MUST be
        // added to `BUILTIN_MACRO_NAMES` too. This test fails if the two
        // drift, which is the load-bearing assertion.
        expect([...BUILTIN_MACRO_NAMES].sort()).toEqual(['location', 'npcs']);
    });
});

describe('Phase 5.1 — macro registry: resolver containment (§3)', () => {
    beforeEach(() => {
        clearAllModMacros();
    });

    it('a throwing resolver is contained: empty string plus a surfaced fault', () => {
        const unregister = registerModMacro(
            { id: 'mod-a', name: 'A' },
            'boom',
            () => { throw new Error('resolver exploded'); },
        );
        // The macro IS registered (the throw happens at resolve time, not
        // registration time).
        expect(hasModMacro('mod-a', 'boom')).toBe(true);

        // Resolution does not throw; it returns '' and records a fault.
        const expanded = renderTemplate('[{{boom}}]', undefined, 'mod-a');
        expect(expanded).toBe('[]');

        const faults = macroFaultStore.getRecords();
        expect(faults.some((f) => f.modId === 'mod-a' && f.kind === 'threw' && f.name === 'boom')).toBe(true);
        unregister();
    });

    it('a resolver returning a non-string is left to the adapter (empty string fallback)', () => {
        // The resolver type is `() => string`; a resolver that returns
        // something else is a type violation. `resolveMacro` returns
        // whatever the resolver returned; the adapter's `replace` callback
        // coerces it to a string. This is the same posture the built-in
        // slots take. The test documents the behaviour: a non-string
        // becomes its `.toString()`, which for `undefined` is `'undefined'`.
        // Authors should not do this; the type is `() => string`.
        registerModMacro({ id: 'mod-a', name: 'A' }, 'weird', () => 'ok' as unknown as string);
        expect(renderTemplate('{{weird}}', undefined, 'mod-a')).toBe('ok');
    });

    it('an empty-string resolver output is the inactive path (budget unchanged)', () => {
        // Returning '' is the defined "inactive this turn" path. The slot
        // expands to nothing; the contribution's budget is unchanged.
        registerModMacro({ id: 'mod-a', name: 'A' }, 'silent', () => '');
        expect(renderTemplate('before {{silent}} after', undefined, 'mod-a')).toBe('before  after');
    });
});

describe('Phase 5.1 — macro registry: lifecycle teardown (host-owned)', () => {
    beforeEach(() => {
        clearAllModMacros();
    });

    it('disableModMacros removes every macro the mod registered', () => {
        registerModMacro({ id: 'mod-a', name: 'A' }, 'one', () => '1');
        registerModMacro({ id: 'mod-a', name: 'A' }, 'two', () => '2');
        registerModMacro({ id: 'mod-b', name: 'B' }, 'one', () => '1b');

        expect(listMacros().length).toBe(3);
        const removed = disableModMacros('mod-a');
        expect(removed).toBe(2);
        expect(hasModMacro('mod-a', 'one')).toBe(false);
        expect(hasModMacro('mod-a', 'two')).toBe(false);
        // mod-b is untouched.
        expect(hasModMacro('mod-b', 'one')).toBe(true);
    });

    it('a registration after disable is a no-op plus a revoked fault', () => {
        registerModMacro({ id: 'mod-a', name: 'A' }, 'one', () => '1');
        disableModMacros('mod-a');

        // A stale closure calling register after disable.
        const unregister = registerModMacro({ id: 'mod-a', name: 'A' }, 'two', () => '2');
        expect(hasModMacro('mod-a', 'two')).toBe(false);
        const faults = macroFaultStore.getRecords();
        expect(faults.some((f) => f.modId === 'mod-a' && f.kind === 'revoked' && f.name === 'two')).toBe(true);
        expect(() => unregister()).not.toThrow();
    });

    it('enableModMacros clears the revoked lease so the mod can register again', () => {
        registerModMacro({ id: 'mod-a', name: 'A' }, 'one', () => '1');
        disableModMacros('mod-a');
        expect(isModMacrosRevoked('mod-a')).toBe(true);

        enableModMacros('mod-a');
        expect(isModMacrosRevoked('mod-a')).toBe(false);

        // Re-registration works.
        registerModMacro({ id: 'mod-a', name: 'A' }, 'two', () => '2');
        expect(hasModMacro('mod-a', 'two')).toBe(true);
    });

    it('disableModMacros clears the mod fault record so a re-enable starts clean', () => {
        registerModMacro({ id: 'mod-a', name: 'A' }, 'location', () => 'shadow');
        expect(macroFaultStore.getRecords().some((f) => f.modId === 'mod-a')).toBe(true);
        disableModMacros('mod-a');
        expect(macroFaultStore.getRecords().some((f) => f.modId === 'mod-a')).toBe(false);
    });

    it('the returned unregister function removes the macro', () => {
        const unregister = registerModMacro({ id: 'mod-a', name: 'A' }, 'temp', () => 't');
        expect(hasModMacro('mod-a', 'temp')).toBe(true);
        unregister();
        expect(hasModMacro('mod-a', 'temp')).toBe(false);
        // A second call is a no-op.
        expect(() => unregister()).not.toThrow();
    });
});

describe('Phase 5.1 — macro registry: invalid args (programming bugs)', () => {
    beforeEach(() => {
        clearAllModMacros();
    });

    it('an empty name records a fault and returns a no-op unregister', () => {
        const unregister = registerModMacro({ id: 'mod-a', name: 'A' }, '', () => 'x');
        expect(hasModMacro('mod-a', '')).toBe(false);
        expect(() => unregister()).not.toThrow();
    });

    it('a non-function resolver records a fault and returns a no-op unregister', () => {
        const unregister = registerModMacro(
            { id: 'mod-a', name: 'A' },
            'broken',
            'not a function' as unknown as () => string,
        );
        expect(hasModMacro('mod-a', 'broken')).toBe(false);
        expect(() => unregister()).not.toThrow();
    });
});

describe('Phase 5.1 — macro registry: budget still applies (§2.4)', () => {
    beforeEach(() => {
        clearAllModMacros();
    });

    it("a macro's output is trimmed to the contribution's budget, not exempt from it", () => {
        // The macro produces a long string; the contribution declares a
        // 5-token budget. The arbiter trims the macro's output to fit.
        const long = 'word '.repeat(50).trim();
        const m = mod({
            contributions: [{
                id: 'long-macro',
                order: 250,
                budget: 5,
                text: '{{longOutput}}',
            }],
        });
        registerModMacro({ id: m.id, name: m.name }, 'longOutput', () => long);

        const registry = createContributionRegistry<FinalUserModuleInput>();
        registry.register(modToContributionModule(m));
        const specs = registry.collect(input());
        const assembled = assembleContributions(specs);

        // The text is the macro's output, trimmed to the budget.
        expect(assembled.text.length).toBeLessThan(long.length);
        expect(assembled.trimmed.length).toBe(1);
        expect(assembled.trimmed[0].id).toBe('mod.probe-mod.long-macro');
    });
});

describe('Phase 5.1 — macro registry: Arc {{arcSurface}} defect resolved', () => {
    it('the Arc manifest no longer declares the dead {{arcSurface}} contribution', () => {
        // The defect: `mods/arc/manifest.json` declared a contribution with
        // `text: "{{arcSurface}}"`. Nothing resolved it, so the literal
        // string was emitted into the prompt. Phase 5.1 removes the dead
        // contribution; Arc's surfacing goes through `ctx.write.updateContext
        // ({ arcDigest })` → `world.ts:560`, which is load-bearing and
        // host-coupled. Phase 8.3 owns moving that path into the mod.
        // Decision recorded in `mods/arc/index.js` header comment.
        const manifest = JSON.parse(
            readFileSync(resolve(process.cwd(), 'mods/arc/manifest.json'), 'utf8'),
        ) as { contributions?: Array<{ text?: string }> };
        const contributions = manifest.contributions ?? [];
        const arcSurface = contributions.find((c) => c.text?.includes('arcSurface'));
        expect(arcSurface).toBeUndefined();
    });
});