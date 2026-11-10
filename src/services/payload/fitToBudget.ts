/**
 * Trim prompt blocks to a token allowance instead of dropping them whole.
 *
 * Every function returns its input unchanged when it already fits, so a turn
 * that is under budget produces exactly the text it always did.
 */
import { countTokens } from '../infrastructure/tokenizer';

/** Longest prefix of `text` that costs at most `budget` tokens. */
export function fitText(text: string, budget: number): string {
    if (budget <= 0) return '';
    if (countTokens(text) <= budget) return text;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (countTokens(text.slice(0, mid)) <= budget) lo = mid;
        else hi = mid - 1;
    }
    return text.slice(0, lo).trimEnd();
}

/**
 * Keep as many whole lines as fit between a header and a footer. `keep: 'last'`
 * keeps the newest lines (the end of the list) instead of the first ones. When
 * not even one line fits whole, the first kept line is cut to fit. Returns ''
 * when nothing useful fits.
 */
export function fitLines(opts: {
    head?: string;
    lines: readonly string[];
    foot?: string;
    budget: number;
    keep?: 'first' | 'last';
}): string {
    const { head, lines, foot, budget, keep = 'first' } = opts;
    const build = (sel: readonly string[]) => [head, ...sel, foot].filter((p): p is string => !!p).join('\n');
    if (lines.length === 0 || budget <= 0) return '';
    if (countTokens(build(lines)) <= budget) return build(lines);
    const pick = (k: number) => (keep === 'first' ? lines.slice(0, k) : lines.slice(lines.length - k));
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (countTokens(build(pick(mid))) <= budget) lo = mid;
        else hi = mid - 1;
    }
    if (lo > 0) return build(pick(lo));
    const shell = countTokens(build(['']));
    const room = budget - shell - 2;
    if (room < 24) return '';
    const line = keep === 'first' ? lines[0] : lines[lines.length - 1];
    const cut = fitText(line, room);
    return cut ? build([`${cut} …`]) : '';
}

/**
 * Generic block trimmer: treats a leading `[TAG]` line as the header and a
 * trailing `[END …]` line as the footer, and keeps whole lines in between.
 */
export function fitBlock(text: string, budget: number, keep: 'first' | 'last' = 'first'): string {
    if (countTokens(text) <= budget) return text;
    const lines = text.split('\n');
    const head = lines.length > 1 && /^\[[^\]]+\]$/.test(lines[0].trim()) ? lines.shift() : undefined;
    const foot = lines.length > 1 && /^\[END[^\]]*\]$/.test(lines[lines.length - 1].trim()) ? lines.pop() : undefined;
    return fitLines({ head, lines, foot, budget, keep });
}
