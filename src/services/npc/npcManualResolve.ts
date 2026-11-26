import type { NPCEntry } from '../../types';
import TITLES from '../../data/titles.json';

const TITLES_SET = new Set(TITLES.map(t => t.toLowerCase()));
const LEADING_ARTICLES = new Set(['the', 'a', 'an']);

export type NpcResolution =
    | { kind: 'empty' }
    | { kind: 'create'; name: string }
    | { kind: 'update'; name: string; npc: NPCEntry }
    | { kind: 'ambiguous'; name: string; matches: NPCEntry[] };

export function normalizeSelection(raw: string): string {
    if (!raw) return '';
    let s = raw.replace(/\s+/g, ' ').trim();
    // strip surrounding quotes / brackets / parens / trailing sentence punctuation. Full quote
    // set (ASCII + curly) so quoted/possessive selections resolve correctly. (cleanup 1db00ad)
    s = s.replace(/^[\s"'‘’“”([{]+/, '').replace(/[\s"'‘’“”\]).,;:!?]+$/, '');
    s = s.replace(/\*+/g, '');
    s = s.replace(/['’]s$/i, '');
    s = s.trim();
    let parts = s.split(' ').filter(Boolean);
    if (parts.length > 1 && LEADING_ARTICLES.has(parts[0].toLowerCase())) {
        parts = parts.slice(1);
    }
    while (parts.length > 1 && TITLES_SET.has(parts[0].toLowerCase())) {
        parts = parts.slice(1);
    }
    return parts.join(' ').trim();
}

function namesMatch(ledgerName: string, search: string): boolean {
    const lower = ledgerName.toLowerCase();
    const q = search.toLowerCase();
    return lower === q
        || lower.startsWith(q + ' ') || lower.endsWith(' ' + q)
        || q.startsWith(lower + ' ') || q.endsWith(' ' + lower);
}

export function findLedgerMatches(name: string, ledger: NPCEntry[]): NPCEntry[] {
    if (!name) return [];
    return ledger.filter(npc => {
        if (!npc.name) return false;
        const allNames = [npc.name, ...(npc.aliases || '').split(',').map(a => a.trim())].filter(Boolean);
        return allNames.some(n => namesMatch(n, name));
    });
}

export function resolveNpcSelection(raw: string, ledger: NPCEntry[]): NpcResolution {
    const name = normalizeSelection(raw);
    if (!name) return { kind: 'empty' };

    const matches = findLedgerMatches(name, ledger);
    if (matches.length === 0) return { kind: 'create', name };
    if (matches.length === 1) return { kind: 'update', name, npc: matches[0] };
    return { kind: 'ambiguous', name, matches };
}