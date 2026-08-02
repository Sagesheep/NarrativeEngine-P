import type { PanelComputedField, PanelDescriptor, PanelHooks } from './panelDescriptor';

export type PanelHookKind = keyof PanelHooks;

export type PanelHookInvocation<TRow> =
    | { kind: 'validate'; row: TRow }
    | { kind: 'onSave'; row: TRow }
    | { kind: 'onDelete'; row: TRow }
    | { kind: 'bulk'; rows: TRow[] }
    | { kind: 'action'; id: string; rows: TRow[] };

export interface PanelHookFault {
    kind: PanelHookKind;
    error: Error;
}

export interface PanelHookResult<T = unknown> {
    ok: boolean;
    skipped?: boolean;
    value?: T;
    error?: Error;
}

export interface PanelHookRunOptions {
    onFault?: (fault: PanelHookFault) => void;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

/**
 * Invoke one declared hook and contain its failure.
 *
 * The host is responsible for calling this function from the existing
 * sandbox context. This module only defines the data-in/data-out shape and
 * never creates a second execution boundary.
 */
export async function runPanelHook<TRow, TContext>(
    descriptor: PanelDescriptor<TRow, TContext>,
    invocation: PanelHookInvocation<TRow>,
    ctx: TContext,
    options?: PanelHookRunOptions,
): Promise<PanelHookResult> {
    const hooks = descriptor.hooks as PanelHooks<TRow, TContext> | undefined;
    const hook = hooks?.[invocation.kind];
    if (!hook) return { ok: true, skipped: true };

    try {
        switch (invocation.kind) {
            case 'validate':
                return { ok: true, value: await hooks.validate!(invocation.row, ctx) };
            case 'onSave':
                return { ok: true, value: await hooks.onSave!(invocation.row, ctx) };
            case 'onDelete':
                return { ok: true, value: await hooks.onDelete!(invocation.row, ctx) };
            case 'bulk':
                return { ok: true, value: await hooks.bulk!(invocation.rows, ctx) };
            case 'action':
                return { ok: true, value: await hooks.action!(invocation.id, invocation.rows, ctx) };
        }
    } catch (error) {
        const fault = { kind: invocation.kind, error: asError(error) } satisfies PanelHookFault;
        options?.onFault?.(fault);
        return { ok: false, error: fault.error };
    }
}

export interface PanelComputedFault {
    field: string;
    error: Error;
}

export interface PanelComputedResult<TRow> {
    rows: TRow[];
    faults: PanelComputedFault[];
}

export interface PanelComputedOptions {
    onFault?: (fault: PanelComputedFault) => void;
}

function writePath<TRow>(row: TRow, path: string, nextValue: unknown): TRow {
    const source = row as Record<string, unknown>;
    const segments = path.split('.');
    if (segments.length === 1) return { ...source, [path]: nextValue } as TRow;

    const [head, ...tail] = segments;
    const current = source[head];
    const nested = current !== null && typeof current === 'object'
        ? { ...(current as Record<string, unknown>) }
        : {};
    let cursor = nested;
    tail.forEach((segment, index) => {
        if (index === tail.length - 1) {
            cursor[segment] = nextValue;
        } else {
            const child = cursor[segment];
            cursor[segment] = child !== null && typeof child === 'object'
                ? { ...(child as Record<string, unknown>) }
                : {};
            cursor = cursor[segment] as Record<string, unknown>;
        }
    });
    return { ...source, [head]: nested } as TRow;
}

/** Evaluate declared computed fields without mutating the input rows. */
export async function evaluatePanelComputed<TRow, TContext>(
    descriptor: PanelDescriptor<TRow, TContext>,
    rows: readonly TRow[],
    ctx: TContext,
    options?: PanelComputedOptions,
): Promise<PanelComputedResult<TRow>> {
    const computed = descriptor.fields.filter((field): field is PanelComputedField<TRow, TContext> => field.control === 'computed');
    const faults: PanelComputedFault[] = [];
    const nextRows: TRow[] = [];

    for (const row of rows) {
        let nextRow = row;
        for (const field of computed) {
            try {
                nextRow = writePath(nextRow, field.key, await field.compute(nextRow, ctx));
            } catch (error) {
                const fault = { field: field.key, error: asError(error) } satisfies PanelComputedFault;
                faults.push(fault);
                options?.onFault?.(fault);
            }
        }
        nextRows.push(nextRow);
    }

    return { rows: nextRows, faults };
}
