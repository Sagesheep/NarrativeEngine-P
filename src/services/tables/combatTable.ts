import { ensureGrid } from '@narrative/engine';
import type { TableDescriptor } from '@narrative/engine';
import type { CombatEvent, CombatSession, CombatState, CombatTableRecord } from '../../types';
import { genericGet } from './genericAccessor';

export const combatTableDescriptor = {
    name: 'combat',
    fileSuffix: '.combat.json',
    recordShape: 'single-object',
    serverRoutes: { present: true, value: { get: true, put: true } },
    storeAccessor: { present: true, value: { read: true, write: true } },
    hydrator: { present: true, value: loadCombatTable },
    slice: { present: true, value: { field: 'combatSession' } },
} satisfies TableDescriptor;

export const EMPTY_COMBAT_RECORD: CombatTableRecord = { session: null };

function isObject(raw: unknown): raw is Record<string, unknown> {
    return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

function isValidState(raw: unknown): boolean {
    if (!isObject(raw)) return false;
    if (typeof raw.id !== 'string' || !raw.id) return false;
    if (!Array.isArray(raw.order) || !raw.order.every(id => typeof id === 'string')) return false;
    if (!isObject(raw.combatants)) return false;
    const combatants = raw.combatants;
    if (!raw.order.every(id => isObject(combatants[id as string]))) return false;
    return ['round', 'turnIndex', 'rngSeed', 'rngCursor', 'eventSeq'].every(k => typeof raw[k] === 'number' && Number.isFinite(raw[k]));
}

export function normalizeCombatSession(raw: unknown): CombatSession | null {
    if (!isObject(raw)) return null;
    if (!isValidState(raw.state)) return null;
    if (!Array.isArray(raw.log)) return null;
    const narrated = typeof raw.narratedThroughSeq === 'number' && Number.isFinite(raw.narratedThroughSeq) ? raw.narratedThroughSeq : 0;
    const log = raw.log as CombatEvent[];
    const lastSeq = log.reduce((max, e) => (typeof e?.seq === 'number' && e.seq > max ? e.seq : max), 0);
    const posted = typeof raw.postedThroughSeq === 'number' && Number.isFinite(raw.postedThroughSeq) ? raw.postedThroughSeq : lastSeq;
    return {
        ...(raw as CombatSession),
        state: ensureGrid(raw.state as CombatState),
        narratedThroughSeq: narrated,
        postedThroughSeq: posted,
        startedAtMessageId: typeof raw.startedAtMessageId === 'string' ? raw.startedAtMessageId : '',
        reason: typeof raw.reason === 'string' ? raw.reason : '',
    };
}

export function normalizeCombatRecord(raw: unknown): CombatTableRecord {
    if (!isObject(raw)) return { ...EMPTY_COMBAT_RECORD };
    return { session: normalizeCombatSession(raw.session) };
}

export async function loadCombatTable(campaignId: string): Promise<CombatTableRecord> {
    try {
        const raw = await genericGet(combatTableDescriptor as never, campaignId);
        return normalizeCombatRecord(raw);
    } catch (e) {
        console.warn('[combat] load failed:', e);
        return { ...EMPTY_COMBAT_RECORD };
    }
}
