import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { beginGatherStage, clearGatherStages, endGatherStage, useGatherStageRecords, useGatherStages } from '../gatherProgress';

beforeEach(() => clearGatherStages());

describe('context task records', () => {
    it('retains fast finished tasks while the existing active-stage list stays empty', () => {
        const { result } = renderHook(() => ({ records: useGatherStageRecords(), active: useGatherStages() }));
        act(() => { beginGatherStage('Recall'); endGatherStage('Recall'); });
        expect(result.current.active).toEqual([]);
        expect(result.current.records).toHaveLength(1);
        expect(result.current.records[0].label).toBe('Recall');
        expect(result.current.records[0].endedAt).toBeGreaterThanOrEqual(result.current.records[0].startedAt);
    });
    it('clears completed records before the next turn and supports parallel tasks', () => {
        const { result } = renderHook(() => ({ records: useGatherStageRecords(), active: useGatherStages() }));
        act(() => { beginGatherStage('Planner'); beginGatherStage('Recall'); endGatherStage('Planner'); });
        expect(result.current.active).toEqual(['Recall']);
        expect(result.current.records).toHaveLength(2);
        act(() => { endGatherStage('Recall'); clearGatherStages(); });
        expect(result.current.records).toEqual([]);
        act(() => beginGatherStage('New turn'));
        expect(result.current.records.map(record => record.label)).toEqual(['New turn']);
    });
});
