import type { PanelDescriptor } from '@narrative/engine';
import type { EnemyInstance } from '../../types';

/**
 * Declaration of the `enemy-instances` panel — WORKORDER-P5-15 §2.
 *
 * Rendered by the generic `PanelRenderer` from 4.1. The bespoke JSX that used
 * to live in `EnemyInstancesView.tsx` is replaced by this declaration plus a
 * thin host wrapper that owns the store binding and the create/delete buttons.
 *
 * Per `08_PANELS.md` §5.3, `bindsTo` names a store field — `enemyInstances` —
 * never a persisted table file. The layout is `list-detail` and the launch is
 * `nested` (this panel opens inside the enemy compendium modal).
 *
 * `reads` declares the cross-table read this panel performs: it looks up the
 * selected template in `enemyCompendium` to drive the Create button. Per §5.2
 * / RULE 4, every read outside the primary source is declared here.
 *
 * CRUD: create + read + update + delete are all enabled. The generic renderer
 * from 4.1 renders the list and the detail editor; create and delete are host
 * affordances owned by the wrapper (see honesty list in 09_PANEL_PROOF.md).
 *
 * The fields mirror the bespoke component's editor surface exactly:
 *   - displayName        text
 *   - currentHp          number
 *   - maxHp              number
 *   - currentBarrier     number
 *   - maxBarrier         number
 *   - conditions         tags        (string[])
 *   - temporaryModifiers array       (EnemyModifier[])
 *   - defeated           checkbox
 *   - templateSnapshot.name readonly (frozen origin, display-only)
 *
 * Sorting is by `createdAt` descending, matching the bespoke component's
 * `useMemo(() => [...enemyInstances].sort((a, b) => b.createdAt - a.createdAt))`.
 * The descriptor's `sort` field cannot express a direction (the renderer sorts
 * ascending only — see ListPanelRendererCore.tsx:242), so `sort` is omitted
 * here and the host wrapper pre-sorts the rows before handing them to the
 * generic renderer. This is a real gap in the descriptor's expressiveness;
 * see 09_PANEL_PROOF.md.
 */
export const enemyInstancesPanel: PanelDescriptor<EnemyInstance, unknown> = {
    id: 'enemy-instances',
    bindsTo: 'enemyInstances',
    launch: 'nested',
    layout: 'list-detail',
    fields: [
        { key: 'displayName', label: 'Display Name', control: 'text' },
        { key: 'currentHp', label: 'Current HP', control: 'number' },
        { key: 'maxHp', label: 'Maximum HP', control: 'number' },
        { key: 'currentBarrier', label: 'Current Barrier', control: 'number' },
        { key: 'maxBarrier', label: 'Maximum Barrier', control: 'number' },
        { key: 'conditions', label: 'Conditions', control: 'tags' },
        { key: 'temporaryModifiers', label: 'Temporary Modifiers', control: 'array' },
        { key: 'defeated', label: 'Mark defeated, removed, surrendered, or otherwise resolved', control: 'checkbox' },
        { key: 'templateSnapshot.name', label: 'Frozen Snapshot', control: 'readonly' },
    ],
    crud: { create: true, read: true, update: true, delete: true },
    reads: ['enemyCompendium'],
};

/** The opaque panel id, exported for the host wrapper and tests. */
export const ENEMY_INSTANCES_PANEL_ID = 'enemy-instances';