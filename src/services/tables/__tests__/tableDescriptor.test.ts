import { describe, it, expect } from 'vitest';
import { createTableRegistry } from '@narrative/engine';
import type { TableDescriptor, Touchpoint } from '@narrative/engine';

const present = <T>(value: T): Touchpoint<T> => ({ present: true, value });
const absent: Touchpoint = { present: false };

const descriptor = (over: Partial<TableDescriptor>): TableDescriptor => ({
    name: 'x',
    fileSuffix: '.x.json',
    recordShape: 'array',
    ...over,
});

describe('createTableRegistry — registration', () => {
    it('registers, lists in registration order, and gets by id', () => {
        const reg = createTableRegistry();
        reg.register(descriptor({ name: 'a', fileSuffix: '.a.json' }));
        reg.register(descriptor({ name: 'b', fileSuffix: '.b.json' }));

        expect(reg.list().map((d) => d.name)).toEqual(['a', 'b']);
        expect(reg.get('a')?.name).toBe('a');
        expect(reg.get('missing')).toBeUndefined();
    });

    it('throws on duplicate name', () => {
        const reg = createTableRegistry();
        reg.register(descriptor({ name: 'a' }));
        expect(() => reg.register(descriptor({ name: 'a' }))).toThrow(/duplicate descriptor: a/);
    });

    it('unregisters and clears', () => {
        const reg = createTableRegistry();
        reg.register(descriptor({ name: 'a' }));
        expect(reg.unregister('a')).toBe(true);
        expect(reg.unregister('a')).toBe(false);
        reg.register(descriptor({ name: 'b' }));
        reg.clear();
        expect(reg.list()).toEqual([]);
    });
});

describe('createTableRegistry — derived queries', () => {
    it('suffixes preserves registration order', () => {
        const reg = createTableRegistry();
        reg.register(descriptor({ name: 'a', fileSuffix: '.a.json' }));
        reg.register(descriptor({ name: 'b', fileSuffix: '.b.json' }));

        expect(reg.suffixes()).toEqual(['.a.json', '.b.json']);
    });

    it('transferable lists only descriptors that declare transfer', () => {
        const reg = createTableRegistry();
        reg.register(descriptor({ name: 'a', transfer: present({ bundleKey: 'a' }) }));
        reg.register(descriptor({ name: 'b', transfer: absent }));
        reg.register(descriptor({ name: 'c', transfer: present({ bundleKey: 'c' }) }));

        expect(reg.transferable().map((d) => d.name)).toEqual(['a', 'c']);
    });

    it('withGenericRoutes lists only descriptors that declare serverRoutes', () => {
        const reg = createTableRegistry();
        reg.register(descriptor({ name: 'a', serverRoutes: present({ get: true, put: true }) }));
        reg.register(descriptor({ name: 'b', serverRoutes: absent }));
        reg.register(descriptor({ name: 'c', serverRoutes: present({ get: true, put: true }) }));

        expect(reg.withGenericRoutes().map((d) => d.name)).toEqual(['a', 'c']);
    });

    it('absent touchpoints exclude a descriptor from the derived lists', () => {
        const reg = createTableRegistry();
        reg.register(descriptor({ name: 'bare' }));

        expect(reg.transferable()).toEqual([]);
        expect(reg.withGenericRoutes()).toEqual([]);
        expect(reg.suffixes()).toEqual(['.x.json']);
    });

    it('empty registry yields empty derived lists', () => {
        const reg = createTableRegistry();
        expect(reg.suffixes()).toEqual([]);
        expect(reg.transferable()).toEqual([]);
        expect(reg.withGenericRoutes()).toEqual([]);
    });
});

/**
 * The opaque-id test — WO-P5-03 §5 Step 1.
 *
 * The registry must never branch on `descriptor.name`. Swapping every table
 * name for a meaningless string and every suffix for an opaque suffix must
 * produce identical derived-list behaviour. This mirrors the contributions
 * registry test; if this fails, the registry has become the god node this
 * epic exists to delete.
 */
describe('createTableRegistry — opaque names', () => {
    const buildSet = (names: string[]) => {
        const reg = createTableRegistry();
        for (const name of names) {
            reg.register(descriptor({
                name,
                fileSuffix: `.${name}.json`,
                transfer: present({ bundleKey: name }),
                serverRoutes: present({ get: true, put: true }),
            }));
        }
        return reg;
    };

    it('treats names as opaque — swapping names for meaningless strings changes only the labels', () => {
        const meaningful = ['enemies', 'locations', 'state'];
        const opaque = ['zz1', 'zz2', 'zz3'];

        const regM = buildSet(meaningful);
        const regO = buildSet(opaque);

        expect(regM.suffixes().length).toBe(regO.suffixes().length);
        expect(regM.transferable().length).toBe(regO.transferable().length);
        expect(regM.withGenericRoutes().length).toBe(regO.withGenericRoutes().length);

        const presentM = regM.list().map((d) => ({
            transfer: d.transfer !== undefined,
            routes: d.serverRoutes !== undefined,
            shape: d.recordShape,
        }));
        const presentO = regO.list().map((d) => ({
            transfer: d.transfer !== undefined,
            routes: d.serverRoutes !== undefined,
            shape: d.recordShape,
        }));
        expect(presentO).toEqual(presentM);
    });
});