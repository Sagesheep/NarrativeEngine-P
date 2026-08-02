import { describe, expect, it, vi } from 'vitest';
import { evaluatePanelComputed, runPanelHook } from '@narrative/engine';
import type { PanelDescriptor } from '@narrative/engine';

type Row = { value: number; computed?: number; nested?: { result?: number } };

const descriptor = (over: Partial<PanelDescriptor<Row, { source: string }>> = {}): PanelDescriptor<Row, { source: string }> => ({
    id: 'panel.x',
    bindsTo: 'rows',
    launch: 'tab',
    layout: 'list',
    fields: [],
    crud: {},
    ...over,
});

describe('panel hooks', () => {
    it('invokes each of the five declared hooks with data and context', async () => {
        const calls: string[] = [];
        const panel = descriptor({
            hooks: {
                validate: (row, ctx) => { calls.push(`validate:${row.value}:${ctx.source}`); return { valid: true }; },
                onSave: (row) => { calls.push(`save:${row.value}`); },
                onDelete: (row) => { calls.push(`delete:${row.value}`); },
                bulk: (rows) => { calls.push(`bulk:${rows.length}`); },
                action: (id, rows) => { calls.push(`action:${id}:${rows.length}`); },
            },
        });
        const ctx = { source: 'sandbox' };

        expect((await runPanelHook(panel, { kind: 'validate', row: { value: 1 } }, ctx)).ok).toBe(true);
        expect((await runPanelHook(panel, { kind: 'onSave', row: { value: 2 } }, ctx)).ok).toBe(true);
        expect((await runPanelHook(panel, { kind: 'onDelete', row: { value: 3 } }, ctx)).ok).toBe(true);
        expect((await runPanelHook(panel, { kind: 'bulk', rows: [{ value: 4 }, { value: 5 }] }, ctx)).ok).toBe(true);
        expect((await runPanelHook(panel, { kind: 'action', id: 'refresh', rows: [{ value: 6 }] }, ctx)).ok).toBe(true);

        expect(calls).toEqual(['validate:1:sandbox', 'save:2', 'delete:3', 'bulk:2', 'action:refresh:1']);
    });

    it('contains a throwing hook and allows the caller to continue', async () => {
        const onFault = vi.fn();
        const panel = descriptor({ hooks: { onSave: () => { throw new Error('save failed'); } } });

        const result = await runPanelHook(panel, { kind: 'onSave', row: { value: 1 } }, { source: 'sandbox' }, { onFault });
        expect(result.ok).toBe(false);
        expect(result.error?.message).toBe('save failed');
        expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ kind: 'onSave', error: expect.any(Error) }));
        expect((await runPanelHook(panel, { kind: 'validate', row: { value: 1 } }, { source: 'sandbox' })).skipped).toBe(true);
    });
});

describe('computed panel fields', () => {
    it('evaluates computed fields into copied rows without mutating the input', async () => {
        const compute = vi.fn(async (row: Row, ctx: { source: string }) => row.value + ctx.source.length);
        const panel = descriptor({
            fields: [
                { key: 'computed', control: 'computed', compute },
                { key: 'nested.result', control: 'computed', compute: (row) => row.value * 2 },
            ],
        });
        const input = [{ value: 3 }];

        const result = await evaluatePanelComputed(panel, input, { source: 'sandbox' });

        expect(result.faults).toEqual([]);
        expect(result.rows).toEqual([{ value: 3, computed: 10, nested: { result: 6 } }]);
        expect(input).toEqual([{ value: 3 }]);
        expect(compute).toHaveBeenCalledWith({ value: 3 }, { source: 'sandbox' });
    });

    it('contains a throwing computed field and reports its field key', async () => {
        const onFault = vi.fn();
        const panel = descriptor({
            fields: [{ key: 'computed', control: 'computed', compute: () => { throw new Error('compute failed'); } }],
        });

        const result = await evaluatePanelComputed(panel, [{ value: 1 }], { source: 'sandbox' }, { onFault });

        expect(result.rows).toEqual([{ value: 1 }]);
        expect(result.faults[0]).toMatchObject({ field: 'computed', error: expect.any(Error) });
        expect(onFault).toHaveBeenCalledTimes(1);
    });
});
