import { describe, expect, it } from 'vitest';
import { bandToDayRange, formatDayRange } from '../distance';

describe('bandToDayRange', () => {
    it.each([
        ['adjacent', { min: 0, max: 0 }],
        ['nearby', { min: 1, max: 1 }],
        ['local', { min: 1, max: 2 }],
        ['regional', { min: 3, max: 5 }],
        ['far', { min: 6, max: 10 }],
        ['distant', { min: 11, max: 20 }],
        ['remote', { min: 21, max: 40 }],
        ['farthest', { min: 41, max: Infinity }],
    ] as const)('%s maps to the expected baseline day range', (band, expected) => {
        expect(bandToDayRange(band)).toEqual(expected);
    });
});

describe('formatDayRange', () => {
    it('formats no travel', () => {
        expect(formatDayRange('adjacent')).toBe('no travel');
    });

    it('formats a one-day range', () => {
        expect(formatDayRange('nearby')).toBe('about 1 day');
    });

    it('formats a finite multi-day range', () => {
        expect(formatDayRange('far')).toBe('6–10 days');
    });

    it('formats an open-ended range', () => {
        expect(formatDayRange('farthest')).toBe('41+ days');
    });
});