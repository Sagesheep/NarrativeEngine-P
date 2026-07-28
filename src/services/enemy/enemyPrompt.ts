import type { ChatMessage, EnemyEntry } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';

export const MAX_RELEVANT_ENEMY_MATCHES = 4;

/**
 * Normalizes prose into Unicode letter/number tokens. Matching token sequences
 * instead of substrings prevents names such as "Orc" from matching "orchid".
 */
function normalizedWords(value: string): string[] {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** Returns true only when every phrase token appears consecutively in the text. */
function containsExactPhrase(textWords: string[], phrase: string): boolean {
    const phraseWords = normalizedWords(phrase);
    if (!phraseWords.length || phraseWords.length > textWords.length) return false;

    return textWords.some((word, start) =>
        word === phraseWords[0]
        && phraseWords.every((phraseWord, offset) => textWords[start + offset] === phraseWord));
}

/**
 * Adds records line-by-line while preserving the wrapper and hard token cap.
 * Earlier lines are higher priority, so descriptive and GM-only material drops
 * before identity, stats, actions, weaknesses, or tactics.
 */
export function fitEnemyRecordsToBudget(
    header: string,
    footer: string,
    records: string[][],
    tokenBudget: number,
): string {
    const finiteBudget = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : Infinity;
    const accepted: Array<{ source: string[]; rendered: string }> = [];

    for (const lines of records) {
        if (!lines.length) continue;
        const withRequiredLine = [header, ...accepted.map(item => item.rendered), lines[0], footer].join('\n\n');
        if (countTokens(withRequiredLine) > finiteBudget) break;
        accepted.push({ source: lines, rendered: lines[0] });
    }

    const maxLines = Math.max(0, ...accepted.map(item => item.source.length));
    for (let lineIndex = 1; lineIndex < maxLines; lineIndex++) {
        for (let recordIndex = 0; recordIndex < accepted.length; recordIndex++) {
            const line = accepted[recordIndex].source[lineIndex];
            if (!line) continue;
            const candidateRecords = accepted.map((item, index) =>
                index === recordIndex ? `${item.rendered}\n${line}` : item.rendered);
            const candidate = [header, ...candidateRecords, footer].join('\n\n');
            if (countTokens(candidate) <= finiteBudget) {
                accepted[recordIndex].rendered = candidateRecords[recordIndex];
            }
        }
    }

    return accepted.length ? [header, ...accepted.map(item => item.rendered), footer].join('\n\n') : '';
}

/**
 * Selects a bounded number of enabled templates whose complete normalized name
 * or explicit alias appears in the current message or last ten messages. The
 * returned reference block is priority-trimmed to the supplied token budget.
 */
export function buildRelevantEnemyBlock(
    enemies: EnemyEntry[] | undefined,
    history: ChatMessage[],
    userMessage: string,
    tokenBudget = Infinity,
    maxMatches = MAX_RELEVANT_ENEMY_MATCHES,
): string {
    if (!enemies?.length || maxMatches <= 0 || tokenBudget <= 0) return '';
    const textWords = normalizedWords(`${history.slice(-10).map(m => m.content ?? '').join(' ')} ${userMessage}`);
    const relevant = enemies.filter(enemy => {
        if (enemy.promptEnabled === false) return false;
        const aliases = typeof enemy.aliases === 'string' ? enemy.aliases.split(',') : [];
        const names = [enemy.name, ...aliases].map(value => value.trim()).filter(Boolean);
        return names.some(name => containsExactPhrase(textWords, name));
    }).slice(0, maxMatches);
    if (!relevant.length) return '';

    const records = relevant.map(enemy => [
        `ENEMY: ${enemy.name}`,
        enemy.classification && `TYPE: ${enemy.classification}`,
        enemy.threatTier && `THREAT: ${enemy.threatTier}`,
        enemy.faction && `FACTION: ${enemy.faction}`,
        enemy.stats?.length && `STATS: ${enemy.stats.map(stat => `${stat.name} ${stat.value}`).join('; ')}`,
        enemy.actions?.length && `ACTIONS: ${enemy.actions.map(action => `${action.name} — ${action.description}`).join('; ')}`,
        enemy.specialBehaviors?.length && `SPECIAL: ${enemy.specialBehaviors.join('; ')}`,
        enemy.weaknesses?.length && `WEAKNESSES: ${enemy.weaknesses.join('; ')}`,
        enemy.resistances?.length && `RESISTANCES: ${enemy.resistances.join('; ')}`,
        enemy.tactics && `TACTICS: ${enemy.tactics}`,
        enemy.passiveTraits?.length && `PASSIVES: ${enemy.passiveTraits.join('; ')}`,
        enemy.description && `DESCRIPTION: ${enemy.description}`,
        enemy.loot && `REWARDS: ${enemy.loot}`,
        enemy.gmNotes && `GM NOTES: ${enemy.gmNotes}`,
    ].filter((line): line is string => Boolean(line)));

    return fitEnemyRecordsToBudget(
        '[RELEVANT ENEMY TEMPLATES — immutable reference records]',
        '[END ENEMY TEMPLATES]',
        records,
        tokenBudget,
    );
}
