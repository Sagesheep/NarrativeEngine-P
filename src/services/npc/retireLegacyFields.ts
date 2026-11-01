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
 * - `visualProfile` (12 fields) → `appearance` prose + `artStyle`
 *
 * Old saves, exports and lore still carry them, so every entry point that reads an
 * NPC from outside the app runs it through `retireLegacyNpcFields` once.
 */
export type LegacyNpcFields = {
    affinity?: unknown;
    disposition?: unknown;
    goals?: unknown;
    drives?: { coreWant?: unknown; sessionWant?: unknown; sceneWant?: unknown } | null;
    visualProfile?: LegacyVisualProfile | null;
};

/** The retired 12-field structured look. Every field is optional on old saves. */
export type LegacyVisualProfile = Partial<Record<
    'race' | 'gender' | 'ageRange' | 'build' | 'symmetry' | 'hairStyle' | 'eyeColor'
    | 'skinTone' | 'gait' | 'distinctMarks' | 'clothing' | 'artStyle', unknown>>;

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
 * Renders the structured look as one paragraph, most identifying details first:
 * "Elf, female, mid 20s. Build: lean. Hair: silver braid. Eyes: amber. ..."
 * Returns '' when nothing meaningful is set.
 */
export function visualProfileToProse(vp: LegacyVisualProfile | null | undefined): string {
    if (!vp) return '';
    const v = (k: keyof LegacyVisualProfile) => meaningful(vp[k]);
    const lead = [v('race'), v('gender'), v('ageRange')].filter(Boolean).join(', ');
    const parts = [
        lead,
        v('build') && `Build: ${v('build')}`,
        v('hairStyle') && `Hair: ${v('hairStyle')}`,
        v('eyeColor') && `Eyes: ${v('eyeColor')}`,
        v('skinTone') && `Skin: ${v('skinTone')}`,
        v('symmetry') && `Features: ${v('symmetry')}`,
        v('gait') && `Bearing: ${v('gait')}`,
        v('clothing') && `Wears: ${v('clothing')}`,
        v('distinctMarks') && `Marks: ${v('distinctMarks')}`,
    ].filter(Boolean);
    return parts.length ? parts.map(p => p.replace(/[.\s]+$/, '')).join('. ') + '.' : '';
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
        || 'visualProfile' in n || (!!snapshot && 'affinity' in snapshot);
    if (!had) return false;

    // Structured look → appearance. Prose already there stays first (the narrator reads
    // its opening); the structured details follow so the portrait prompt keeps them.
    const look = visualProfileToProse(n.visualProfile);
    if (look) {
        const current = text(n.appearance);
        n.appearance = !current ? look : current.includes(look) ? current : `${current}\n${look}`;
    }
    const style = meaningful(n.visualProfile?.artStyle);
    if (style && !n.artStyle) n.artStyle = style;
    delete n.visualProfile;

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
