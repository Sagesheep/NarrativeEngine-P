import { describe, it, expect, vi } from 'vitest';
import { createContributionRegistry, DEFAULT_MOD_CONTRIBUTION_BUDGET } from '../registry';
import type { ContributionModule } from '../registry';
import type { ContributionSpec } from '../types';

interface TestInput { word: string }

const mod = (
    id: string,
    produce: (input: TestInput) => ContributionSpec[],
    over: Partial<ContributionModule<TestInput>> = {},
): ContributionModule<TestInput> => ({
    id,
    name: id,
    description: '',
    source: 'builtin',
    defaultEnabled: true,
    produce,
    ...over,
});

const oneSpec = (id: string, over: Partial<ContributionSpec> = {}): ContributionSpec => ({
    id,
    slot: 'final-user',
    order: 100,
    text: 'text',
    source: 'builtin',
    ...over,
});

describe('createContributionRegistry — registration', () => {
    it('registers, lists in registration order, and gets by id', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('a', () => []));
        reg.register(mod('b', () => []));

        expect(reg.list().map((m) => m.id)).toEqual(['a', 'b']);
        expect(reg.get('a')?.id).toBe('a');
        expect(reg.get('missing')).toBeUndefined();
    });

    it('throws on duplicate module id', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('a', () => []));

        expect(() => reg.register(mod('a', () => []))).toThrow(/duplicate module id: a/);
    });

    it('unregisters and clears', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('a', () => []));

        expect(reg.unregister('a')).toBe(true);
        expect(reg.unregister('a')).toBe(false);

        reg.register(mod('b', () => []));
        reg.clear();
        expect(reg.list()).toEqual([]);
    });
});

describe('createContributionRegistry — collect', () => {
    it('flattens specs from every module and passes the input through', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('a', (input) => [oneSpec('a.1', { text: input.word })]));
        reg.register(mod('b', () => [oneSpec('b.1'), oneSpec('b.2')]));

        const specs = reg.collect({ word: 'hello' });

        expect(specs.map((s) => s.id)).toEqual(['a.1', 'b.1', 'b.2']);
        expect(specs[0].text).toBe('hello');
    });

    it('skips disabled modules', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('on', () => [oneSpec('on.1')]));
        reg.register(mod('off', () => [oneSpec('off.1')]));

        const specs = reg.collect({ word: 'x' }, { isEnabled: (id) => id !== 'off' });

        expect(specs.map((s) => s.id)).toEqual(['on.1']);
    });

    it('treats every module as enabled when no predicate is given', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('a', () => [oneSpec('a.1')]));

        expect(reg.collect({ word: 'x' })).toHaveLength(1);
    });
});

describe('createContributionRegistry — fail safe', () => {
    it('contains a throwing module, reports the fault, and keeps collecting', () => {
        const reg = createContributionRegistry<TestInput>();
        const onFault = vi.fn();

        reg.register(mod('good.before', () => [oneSpec('before')]));
        reg.register(mod('bad', () => { throw new Error('mod exploded'); }));
        reg.register(mod('good.after', () => [oneSpec('after')]));

        const specs = reg.collect({ word: 'x' }, { onFault });

        // The turn survives — this is acceptance criterion 5 ("fails safe with a reason").
        expect(specs.map((s) => s.id)).toEqual(['before', 'after']);
        expect(onFault).toHaveBeenCalledTimes(1);
        expect(onFault.mock.calls[0][0].moduleId).toBe('bad');
        expect(onFault.mock.calls[0][0].error.message).toBe('mod exploded');
    });

    it('wraps a non-Error throw so consumers always get an Error', () => {
        const reg = createContributionRegistry<TestInput>();
        const onFault = vi.fn();
        reg.register(mod('bad', () => { throw 'just a string'; }));

        reg.collect({ word: 'x' }, { onFault });

        expect(onFault.mock.calls[0][0].error).toBeInstanceOf(Error);
        expect(onFault.mock.calls[0][0].error.message).toBe('just a string');
    });

    it('does not throw when no onFault handler is supplied', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('bad', () => { throw new Error('boom'); }));

        expect(() => reg.collect({ word: 'x' })).not.toThrow();
    });
});

describe('createContributionRegistry — provenance and mod budgets', () => {
    it('applies a default budget to mod contributions that did not declare one', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('m', () => [oneSpec('m.1', { source: 'mod' })], { source: 'mod' }));

        const [spec] = reg.collect({ word: 'x' });

        expect(spec.budget).toBe(DEFAULT_MOD_CONTRIBUTION_BUDGET);
    });

    it('respects a budget the mod declared for itself', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('m', () => [oneSpec('m.1', { source: 'mod', budget: 64 })], { source: 'mod' }));

        expect(reg.collect({ word: 'x' })[0].budget).toBe(64);
    });

    it('leaves built-in contributions unbounded', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('b', () => [oneSpec('b.1')]));

        // Unbounded built-ins are what keep the WO-P2-02 migration byte-identical.
        expect(reg.collect({ word: 'x' })[0].budget).toBeUndefined();
    });

    it('stamps the module source, so a mod cannot masquerade as a built-in', () => {
        const reg = createContributionRegistry<TestInput>();
        reg.register(mod('m', () => [oneSpec('m.1', { source: 'builtin' })], { source: 'mod' }));

        const [spec] = reg.collect({ word: 'x' });

        expect(spec.source).toBe('mod');
        expect(spec.budget).toBe(DEFAULT_MOD_CONTRIBUTION_BUDGET);
    });
});
