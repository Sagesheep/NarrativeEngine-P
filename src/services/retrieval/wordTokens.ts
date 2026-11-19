/**
 * retrieval/wordTokens.ts
 *
 * Word and name tokenizers for the keyword rankers, for any alphabet. The old
 * patterns were `[a-z]` and `[A-Z][A-Za-z]`, which cut words at every letter
 * outside basic Latin: Polish "Zakład" became "zak" + "ad", "Ciepły" became
 * "ciep", and a name starting with Ł, Ś or Ż was not a name at all. Letters are
 * \p{L} with combining marks (\p{M}) so decomposed accents stay in the word.
 */

const LETTER = '\\p{L}\\p{M}';

const wordPattern = (min: number) => new RegExp(`[${LETTER}]{${min},}`, 'gu');
const WORDS_2 = wordPattern(2);
const WORDS_3 = wordPattern(3);

/** Lowercased letter-only words of at least `min` letters (2 or 3 are cached). */
export function lowerWords(text: string, min = 2): string[] {
    const re = min === 2 ? WORDS_2 : min === 3 ? WORDS_3 : wordPattern(min);
    return text.toLowerCase().match(re) ?? [];
}

const PROPER = (min: number) =>
    new RegExp(`\\p{Lu}[${LETTER}]{${min - 1},}(?:\\s\\p{Lu}[${LETTER}]{${min - 1},})*`, 'gu');
const PROPER_2 = PROPER(2);
const PROPER_3 = PROPER(3);

/** Runs of capitalised words ("Ciepły Rondel", "Łukasz"), each word at least `min` letters. */
export function properNouns(text: string, min = 2): string[] {
    const re = min === 2 ? PROPER_2 : min === 3 ? PROPER_3 : PROPER(min);
    return text.match(re) ?? [];
}

/** A query word with everything but letters and digits removed, lowercased. */
export function cleanWord(word: string): string {
    return word.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}
