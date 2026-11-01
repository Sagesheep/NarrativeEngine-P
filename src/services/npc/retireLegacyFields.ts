import type { NPCEntry, NPCWants } from '../../types';
import { affinityToPcRelation } from './agency/agencyBands';

/**
 * Fields retired from NPCEntry (2026-11-01). They overlapped a current field and
 * the prompt sent both, so the model could get two disagreeing answers:
 *
 * - `affinity` (0..100)   → `pcRelation` (-3..+3, sent as a word band)
 * - `disposition`         → `personality`
 * - `goals`               → `wants.long`
 * - `drives.*Want`        → `wants.short / medium / long`
 *
 * Old saves, exports and lore still carry them, so every entry point that reads an
 * NPC from outside the app runs it through `retireLegacyNpcFields` once.
 */
export type LegacyNpcFields = {
    affinity?: unknown;
    disposition?: unknown;
    goals?: unknown;
    drives?: { coreWant?: unknown; sessionWant?: unknown; sceneWant?: unknown } | null;
};

const GENERIC = new Set(['', '?', 'unknown', 'none', 'n/a']);

function text(v: unknown): string {
    if (Array.isArray(v)) return v.map(String).filter(Boolean).join('; ').trim();
    return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function meaningful(v: unknown): string {
    const t = text(v);
    return GENERIC.has(t.toLowerCase()) ? '' : t;
}

/**
 * Folds the retired fields into their replacements, in place, and deletes them.
 * Never overwrites a value the current field already has. Idempotent.
 * Returns true when anything changed.
 */
export function retireLegacyNpcFields(npc: NPCEntry): boolean {
    const n = npc as NPCEntry & LegacyNpcFields;
    const snapshot = n.previousSnapshot as { affinity?: unknown } | undefined;
    const had = 'affinity' in n || 'disposition' in n || 'goals' in n || 'drives' in n
        || (!!snapshot && 'affinity' in snapshot);
    if (!had) return false;

    // PCs never had a pcRelation (it is the NPC->PC slot), so their affinity just goes.
    if (!n.isPC && n.pcRelation === undefined) {
        const a = typeof n.affinity === 'number' && Number.isFinite(n.affinity) ? n.affinity : 50;
        n.pcRelation = affinityToPcRelation(a);
    }

    const disposition = meaningful(n.disposition);
    if (disposition && !meaningful(n.personality)) n.personality = disposition;

    const drives = n.drives ?? undefined;
    const core = meaningful(drives?.coreWant);
    const session = meaningful(drives?.sessionWant);
    const scene = meaningful(drives?.sceneWant);
    const goals = meaningful(n.goals);
    const long = core || goals;
    if (long || session || scene) {
        const wants: NPCWants = {
            short: n.wants?.short ?? [],
            medium: n.wants?.medium ?? [],
            long: n.wants?.long ?? '',
        };
        // Each legacy value fills only an empty tier: authored wants always win.
        if (scene && wants.short.length === 0) wants.short = [scene];
        if (session && wants.medium.length === 0) wants.medium = [session];
        if (long && !wants.long.trim()) wants.long = long;
        n.wants = wants;
    }

    delete n.affinity;
    delete n.disposition;
    delete n.goals;
    delete n.drives;
    if (snapshot) delete snapshot.affinity;
    return true;
}
