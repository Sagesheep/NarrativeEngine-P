import type { ChatMessage, EnemyEntry } from '../../types';

/**
 * Selects enabled templates whose name or comma-separated alias appears in the
 * current message or last ten messages, then returns an immutable reference
 * block for placement below the prompt-cache boundary.
 */
export function buildRelevantEnemyBlock(enemies: EnemyEntry[] | undefined, history: ChatMessage[], userMessage: string): string {
    if (!enemies?.length) return '';
    const text = `${history.slice(-10).map(m => m.content ?? '').join(' ')} ${userMessage}`.toLowerCase();
    const relevant = enemies.filter(enemy => {
        if (enemy.promptEnabled === false) return false;
        const aliases = typeof enemy.aliases === 'string' ? enemy.aliases.split(',') : [];
        const names = [enemy.name, ...aliases].map(v => v.trim().toLowerCase()).filter(Boolean);
        return names.some(name => text.includes(name));
    });
    if (!relevant.length) return '';
    const records = relevant.map(e => [
        `ENEMY: ${e.name}`,
        e.classification && `TYPE: ${e.classification}`,
        e.threatTier && `THREAT: ${e.threatTier}`,
        e.faction && `FACTION: ${e.faction}`,
        e.description && `DESCRIPTION: ${e.description}`,
        e.stats?.length && `STATS: ${e.stats.map(s => `${s.name} ${s.value}`).join('; ')}`,
        e.actions?.length && `ACTIONS: ${e.actions.map(a => `${a.name} — ${a.description}`).join('; ')}`,
        e.passiveTraits?.length && `PASSIVES: ${e.passiveTraits.join('; ')}`,
        e.specialBehaviors?.length && `SPECIAL: ${e.specialBehaviors.join('; ')}`,
        e.weaknesses?.length && `WEAKNESSES: ${e.weaknesses.join('; ')}`,
        e.resistances?.length && `RESISTANCES: ${e.resistances.join('; ')}`,
        e.tactics && `TACTICS: ${e.tactics}`,
        e.loot && `REWARDS: ${e.loot}`,
        e.gmNotes && `GM NOTES: ${e.gmNotes}`,
    ].filter(Boolean).join('\n'));
    return `[RELEVANT ENEMY TEMPLATES — immutable reference records]\n${records.join('\n\n')}\n[END ENEMY TEMPLATES]`;
}
