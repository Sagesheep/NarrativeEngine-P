import { describe, it, expect } from 'vitest';
import { normalizeRelations } from '../relationDedupe';
import type { NPCEntry } from '../../../types';

describe('relationDedupe — normalizeRelations', () => {
    const mockLedger: NPCEntry[] = [
        { id: 'npc-vorin', name: 'Captain Vorin', aliases: 'Vorin, Old Captain', status: 'Alive', tier: 'recurring' },
        { id: 'npc-kael', name: 'Kael', status: 'Alive', tier: 'recurring' },
    ];

    const pcId = 'pc-hero';

    it('returns empty object when relations is empty or undefined', () => {
        expect(normalizeRelations(undefined, mockLedger, pcId)).toEqual({});
        expect(normalizeRelations(null, mockLedger, pcId)).toEqual({});
        expect(normalizeRelations({}, mockLedger, pcId)).toEqual({});
    });

    it('preserves valid ID-keyed relations', () => {
        const input = { 'npc-vorin': 2, 'npc-kael': -1 };
        const result = normalizeRelations(input, mockLedger, pcId);
        expect(result).toEqual({ 'npc-vorin': 2, 'npc-kael': -1 });
    });

    it('resolves name and alias keys to canonical character IDs', () => {
        const input = { 'Captain Vorin': 2, 'Vorin': 2, 'Kael': -2 };
        const result = normalizeRelations(input, mockLedger, pcId);
        expect(result).toEqual({ 'npc-vorin': 2, 'npc-kael': -2 });
    });

    it('resolves Player Character name variations to pcId', () => {
        const input = { 'Player Character': 3, 'player': 3 };
        const result = normalizeRelations(input, mockLedger, pcId);
        expect(result).toEqual({ 'pc-hero': 3 });
    });

    it('clamps relation numerical values between -3 and +3', () => {
        const input = { 'npc-vorin': 10, 'npc-kael': -5 };
        const result = normalizeRelations(input, mockLedger, pcId);
        expect(result).toEqual({ 'npc-vorin': 3, 'npc-kael': -3 });
    });

    it('drops unresolvable unknown keys', () => {
        const input = { 'Ghost Character': 1, 'npc-vorin': 1 };
        const result = normalizeRelations(input, mockLedger, pcId);
        expect(result).toEqual({ 'npc-vorin': 1 });
    });
});
