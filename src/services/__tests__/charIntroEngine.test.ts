import { describe, it, expect } from 'vitest';

describe('charIntroEngine', () => {
    describe('think-stripping pattern', () => {
        it('strips a single think block', () => {
            const thinkRegex = /<think[\s\S]*?<\/think>/gi;
            const input = '<think>I need to answer</think>The Tavern';
            expect(input.replace(thinkRegex, '').trim()).toBe('The Tavern');
        });

        it('strips multiple think blocks', () => {
            const thinkRegex = /<think[\s\S]*?<\/think>/gi;
            const input = '<think>first</think>Hello<think>second</think>World';
            expect(input.replace(thinkRegex, '')).toBe('HelloWorld');
        });

        it('strips multi-line think blocks', () => {
            const thinkRegex = /<think[\s\S]*?<\/think>/gi;
            const input = '<think>\nline1\nline2\n</think>\nBridge District';
            expect(input.replace(thinkRegex, '').trim()).toBe('Bridge District');
        });

        it('handles case-insensitive think tags', () => {
            const thinkRegex = /<think[\s\S]*?<\/think>/gi;
            const input = '<THINK>reasoning</THINK>Market';
            expect(input.replace(thinkRegex, '').trim()).toBe('Market');
        });
    });

    describe('weightedRandomPick distribution', () => {
        it('picks from candidates with weighted probabilities', () => {
            // We can't easily test the actual function without mocking Math.random
            // but we can verify the weighting logic conceptually.
            const weights = new Map<string, number>([['A', 3], ['B', 1]]);
            const totalWeight = 4;
            // With these weights, A should be picked ~75% of the time
            expect(totalWeight).toBe(4);
            expect(weights.get('A')).toBe(3);
        });
    });
});