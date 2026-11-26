import { describe, it, expect } from 'vitest';
import { prologueTracks } from '../prologue';
import { sequentialTracks } from '../sequential';
import { postCommitTracks } from '../postCommit';
import type { PostTurnTrack } from '../types';

type TestRegistry = {
    clear(): void;
    register(track: PostTurnTrack<never>): void;
    start(ctx: never): Promise<void>[];
};

const asTestRegistry = (registry: unknown): TestRegistry => registry as TestRegistry;

async function assertOrderAndContainment(registry: TestRegistry): Promise<void> {
    registry.clear();
    const log: string[] = [];
    const ids = ['x0', 'x1', 'x2'];

    ids.forEach((id, index) => registry.register({
        id,
        name: id,
        description: id,
        defaultEnabled: true,
        shouldRun: () => true,
        run: index === 1
            ? async () => { throw new Error('opaque fault'); }
            : async () => { log.push(id); },
    }));

    const results = await Promise.allSettled(registry.start(undefined as never));

    expect(log).toEqual(['x0', 'x2']);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    registry.clear();
}

describe('Phase 7.2.1 stage registries', () => {
    it('prologue preserves opaque-id start order and fault containment', async () => {
        await assertOrderAndContainment(asTestRegistry(prologueTracks));
    });

    it('sequential preserves opaque-id start order and fault containment', async () => {
        await assertOrderAndContainment(asTestRegistry(sequentialTracks));
    });

    it('post-commit preserves opaque-id start order and fault containment', async () => {
        await assertOrderAndContainment(asTestRegistry(postCommitTracks));
    });
});
