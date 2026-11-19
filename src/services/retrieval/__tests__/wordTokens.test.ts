import { describe, it, expect } from 'vitest';
import { cleanWord, lowerWords, properNouns } from '../wordTokens';

describe('wordTokens', () => {
    it('keeps Polish letters inside words', () => {
        expect(lowerWords('Zakład fryzjerski, Ciepły Rondel', 2)).toEqual(['zakład', 'fryzjerski', 'ciepły', 'rondel']);
        expect(lowerWords('nie może stać', 3)).toEqual(['nie', 'może', 'stać']);
    });

    it('finds names that start with a non-ASCII capital', () => {
        expect(properNouns('Spotkał Łukasza i Żabę w Ciepły Rondel', 2)).toEqual(['Spotkał Łukasza', 'Żabę', 'Ciepły Rondel']);
    });

    it('still reads plain English the same way', () => {
        expect(lowerWords('Grey met Therese.', 2)).toEqual(['grey', 'met', 'therese']);
        expect(properNouns('Grey met Therese Soll.', 3)).toEqual(['Grey', 'Therese Soll']);
    });

    it('cleans punctuation but not letters', () => {
        expect(cleanWord('„Dzwon”,')).toBe('dzwon');
        expect(cleanWord('zakład')).toBe('zakład');
        expect(cleanWord('598')).toBe('598');
    });
});
