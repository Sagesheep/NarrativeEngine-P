import { describe, expect, it } from 'vitest';
import { createPanelRegistry } from '@narrative/engine';
import type { PanelDescriptor, PanelField } from '@narrative/engine';

const descriptor = (over: Partial<PanelDescriptor> = {}): PanelDescriptor => ({
    id: 'panel.x',
    bindsTo: 'context.x',
    launch: 'tab',
    layout: 'list',
    fields: [],
    crud: {},
    ...over,
});

describe('createPanelRegistry — registration', () => {
    it('registers, lists in declaration order, and gets by opaque id', () => {
        const registry = createPanelRegistry();
        registry.register(descriptor({ id: 'first' }));
        registry.register(descriptor({ id: 'second' }));

        expect(registry.list().map((panel) => panel.id)).toEqual(['first', 'second']);
        expect(registry.get('first')?.id).toBe('first');
        expect(registry.get('missing')).toBeUndefined();
    });

    it('rejects duplicate ids and supports removal/clear', () => {
        const registry = createPanelRegistry();
        registry.register(descriptor({ id: 'same' }));
        expect(() => registry.register(descriptor({ id: 'same' }))).toThrow(/duplicate descriptor: same/);
        expect(registry.unregister('same')).toBe(true);
        expect(registry.unregister('same')).toBe(false);

        registry.register(descriptor({ id: 'remaining' }));
        registry.clear();
        expect(registry.list()).toEqual([]);
    });
});

describe('PanelDescriptor contract', () => {
    it('contains only the measured controls and layouts', () => {
        const controls: PanelField[] = [
            { key: 'text', control: 'text' },
            { key: 'readonly', control: 'readonly' },
            { key: 'textarea', control: 'textarea' },
            { key: 'nested', control: 'nested-object' },
            { key: 'number', control: 'number' },
            { key: 'tags', control: 'tags' },
            { key: 'select', control: 'select', options: [] },
            { key: 'checkbox', control: 'checkbox' },
            { key: 'array', control: 'array' },
            { key: 'image', control: 'image' },
            { key: 'computed', control: 'computed', compute: (row) => row.computed },
        ];
        const panel = descriptor({ fields: controls, layout: 'tree', launch: 'nested', bindsTo: 'context.playerCharacter' });

        expect(panel.fields.map((field) => field.control)).toEqual([
            'text', 'readonly', 'textarea', 'nested-object', 'number', 'tags',
            'select', 'checkbox', 'array', 'image', 'computed',
        ]);
        expect(panel.bindsTo).toBe('context.playerCharacter');
        expect(panel.crud.reorder).toBeUndefined();
    });
});

describe('PanelDescriptor — opaque ids', () => {
    const buildRegistry = (ids: string[]) => {
        const registry = createPanelRegistry();
        ids.forEach((id, index) => registry.register(descriptor({
            id,
            layout: index % 2 === 0 ? 'list' : 'list-detail',
            launch: index % 2 === 0 ? 'tab' : 'nested',
            fields: [{ key: `field-${index}`, control: 'text' }],
            crud: { read: true, update: index === 0 },
            reads: [`read-${index}`],
            writes: index === 0 ? [`write-${index}`] : undefined,
        })));
        return registry;
    };

    it('produces identical registry behavior when ids become meaningless', () => {
        const real = buildRegistry(['npc-ledger', 'lore-chunks', 'memory-facts']);
        const opaque = buildRegistry(['zz1', 'zz2', 'zz3']);
        const shape = (registry: ReturnType<typeof buildRegistry>) => registry.list().map((panel) => ({
            layout: panel.layout,
            launch: panel.launch,
            fields: panel.fields.map((field) => field.control),
            crud: panel.crud,
            reads: panel.reads,
            writes: panel.writes,
        }));

        expect(shape(opaque)).toEqual(shape(real));
        expect(real.list().length).toBe(opaque.list().length);
    });
});
