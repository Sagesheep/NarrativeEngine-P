import type { AbilityEntry, ChatMessage } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';

export const MAX_RELEVANT_ABILITY_MATCHES = 4;

const normalizedWords = (value: string): string[] =>
    value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

const containsExactPhrase = (textWords: string[], phrase: string): boolean => {
    const phraseWords = normalizedWords(phrase);
    if (!phraseWords.length || phraseWords.length > textWords.length) return false;
    return textWords.some((word, start) =>
        word === phraseWords[0]
        && phraseWords.every((phraseWord, offset) => textWords[start + offset] === phraseWord));
};

/**
 * Selects only enabled definitions named in the current or ten most recent
 * messages, then adds priority-ordered lines without exceeding the hard cap.
 */
export function buildRelevantAbilityBlock(
    abilities: AbilityEntry[] | undefined,
    history: ChatMessage[],
    userMessage: string,
    tokenBudget = Infinity,
    maxMatches = MAX_RELEVANT_ABILITY_MATCHES,
): string {
    if (!abilities?.length || tokenBudget <= 0 || maxMatches <= 0) return '';
    const textWords = normalizedWords(`${history.slice(-10).map(message => message.content ?? '').join(' ')} ${userMessage}`);
    const relevant = abilities.filter(ability => {
        if (ability.promptEnabled === false) return false;
        const aliases = ability.aliases.split(',').map(alias => alias.trim()).filter(Boolean);
        return [ability.name, ...aliases].some(name => containsExactPhrase(textWords, name));
    }).slice(0, maxMatches);
    if (!relevant.length) return '';

    const header = '[RELEVANT ABILITY RULES — canonical definitions]';
    const footer = '[END ABILITY RULES]';
    const rendered: string[] = [];

    for (const ability of relevant) {
        const lines = [
            `ABILITY: ${ability.name}`,
            `CATEGORY: ${ability.category}`,
            ability.effect && `EFFECT: ${ability.effect}`,
            ability.activation && `ACTIVATION: ${ability.activation}`,
            ability.costs.length && `COSTS: ${ability.costs.map(cost =>
                [cost.resource, cost.amount, cost.timing, cost.condition].filter(Boolean).join(' | ')).join('; ')}`,
            ability.range && `RANGE: ${ability.range}`,
            ability.targets && `TARGETS: ${ability.targets}`,
            ability.duration && `DURATION: ${ability.duration}`,
            ability.area && `AREA: ${ability.area}`,
            ability.limitations.length && `LIMITS: ${ability.limitations.join('; ')}`,
            ability.counters.length && `COUNTERS: ${ability.counters.join('; ')}`,
            ability.prerequisites.length && `PREREQUISITES: ${ability.prerequisites.join('; ')}`,
            ability.outcomeGuidance && `OUTCOMES: ${ability.outcomeGuidance}`,
            ability.description && `DESCRIPTION: ${ability.description}`,
            ability.appearance && `APPEARANCE: ${ability.appearance}`,
            ability.gmNotes && `GM NOTES: ${ability.gmNotes}`,
        ].filter((line): line is string => Boolean(line));

        let accepted = '';
        for (const line of lines) {
            const candidateRecord = accepted ? `${accepted}\n${line}` : line;
            const candidate = [header, ...rendered, candidateRecord, footer].join('\n\n');
            if (countTokens(candidate) <= tokenBudget) accepted = candidateRecord;
        }
        if (!accepted || !accepted.startsWith(`ABILITY: ${ability.name}`)) break;
        rendered.push(accepted);
    }

    return rendered.length ? [header, ...rendered, footer].join('\n\n') : '';
}
