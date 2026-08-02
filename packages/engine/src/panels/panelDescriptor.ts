import type { Touchpoint } from '../tables/tableDescriptor';

/** The only panel layouts supported by the measured panel population. */
export type PanelLayout = 'list' | 'list-detail' | 'form' | 'tree';

/** The only launch surfaces supported by the measured panel population. */
export type PanelLaunch = 'header-button' | 'tab' | 'nested';

/** CRUD capabilities are opt-in; an omitted operation is not available. */
export type PanelCrudOperation = 'create' | 'read' | 'update' | 'delete' | 'bulk';

/** The ten measured input/display controls plus the first-class computed field. */
export type PanelInputControl =
    | 'text'
    | 'readonly'
    | 'textarea'
    | 'nested-object'
    | 'number'
    | 'tags'
    | 'select'
    | 'checkbox'
    | 'array'
    | 'image';

export type PanelControl = PanelInputControl | 'computed';

export interface PanelOption {
    value: string;
    label: string;
}

/** A declared function that transforms data inside the existing compute sandbox. */
export type PanelComputed<TRow = Record<string, unknown>, TContext = unknown> = (
    row: TRow,
    ctx: TContext,
) => unknown | Promise<unknown>;

interface PanelFieldBase {
    /** Store-field path relative to the row supplied to the renderer. */
    key: string;
    /** Human-readable label. The renderer never infers behavior from it. */
    label?: string;
    /** Optional help text for a host renderer. */
    description?: string;
    /** Input hint used by text-like controls. */
    placeholder?: string;
    /** Options used by a select control. */
    options?: PanelOption[];
}

export interface PanelInputField extends PanelFieldBase {
    control: PanelInputControl;
}

export interface PanelComputedField<TRow = Record<string, unknown>, TContext = unknown> extends PanelFieldBase {
    control: 'computed';
    /** Computed values are evaluated by the sandbox caller, never by React rendering. */
    compute: PanelComputed<TRow, TContext>;
}

export type PanelField<TRow = Record<string, unknown>, TContext = unknown> =
    | PanelInputField
    | PanelComputedField<TRow, TContext>;

/** Compatibility name used by the work-order prose. */
export type FieldSpec<TRow = Record<string, unknown>, TContext = unknown> = PanelField<TRow, TContext>;

export interface SearchSpec {
    fields: string[];
    placeholder?: string;
}

export interface FilterSpec {
    field: string;
    options: PanelOption[];
}

export interface SortSpec {
    field: string;
    direction?: 'asc' | 'desc';
}

/** The declarative filter shape used by the contract-level descriptor. */
export interface PanelFilter extends FilterSpec {
    label?: string;
}

export type PanelValidationResult =
    | void
    | boolean
    | { valid: boolean; errors?: string[] };

/**
 * The five hook kinds allowed by the panel contract.
 *
 * These are function signatures only. A host invokes them from the existing
 * sandbox; this pure package never invokes a hook during React rendering.
 */
export interface PanelHooks<TRow = unknown, TContext = unknown> {
    validate?: (row: TRow, ctx: TContext) => PanelValidationResult | Promise<PanelValidationResult>;
    onSave?: (row: TRow, ctx: TContext) => unknown | Promise<unknown>;
    onDelete?: (row: TRow, ctx: TContext) => unknown | Promise<unknown>;
    bulk?: (rows: TRow[], ctx: TContext) => unknown | Promise<unknown>;
    action?: (id: string, rows: TRow[], ctx: TContext) => unknown | Promise<unknown>;
}

/**
 * A panel is declared data and capabilities, never a component or renderer.
 *
 * `id` is intentionally opaque to generic machinery. `bindsTo` names a store
 * field, not a persisted table file, and is therefore always present.
 */
export interface PanelDescriptor<TRow = Record<string, unknown>, TContext = unknown> {
    id: string;
    bindsTo: string;
    launch: PanelLaunch;
    layout: PanelLayout;
    fields: PanelField<TRow, TContext>[];
    crud: Partial<Record<PanelCrudOperation, boolean>>;
    search?: boolean;
    sort?: string;
    filter?: PanelFilter;
    hooks?: PanelHooks<TRow, TContext>;
    reads?: string[];
    writes?: string[];
}

export interface PanelRegistry<TRow = Record<string, unknown>, TContext = unknown> {
    register(descriptor: PanelDescriptor<TRow, TContext>): void;
    unregister(id: string): boolean;
    list(): readonly PanelDescriptor<TRow, TContext>[];
    get(id: string): PanelDescriptor<TRow, TContext> | undefined;
    clear(): void;
}

export function createPanelRegistry<TRow = Record<string, unknown>, TContext = unknown>(): PanelRegistry<TRow, TContext> {
    const byId = new Map<string, PanelDescriptor<TRow, TContext>>();
    const order: string[] = [];

    return {
        register(descriptor) {
            if (byId.has(descriptor.id)) {
                throw new Error(`[panels] duplicate descriptor: ${descriptor.id}`);
            }
            byId.set(descriptor.id, descriptor);
            order.push(descriptor.id);
        },

        unregister(id) {
            const removed = byId.delete(id);
            if (removed) {
                const index = order.indexOf(id);
                if (index >= 0) order.splice(index, 1);
            }
            return removed;
        },

        list() {
            return order.map((id) => byId.get(id) as PanelDescriptor<TRow, TContext>);
        },

        get(id) {
            return byId.get(id);
        },

        clear() {
            byId.clear();
            order.length = 0;
        },
    };
}

/** Keep the wrapper type available to panel hosts without duplicating it. */
export type PanelTouchpoint<T = unknown> = Touchpoint<T>;
