import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    jobs: [] as Promise<unknown>[],
}));
vi.mock('../../infrastructure/backgroundQueue', () => ({
    backgroundQueue: {
        push: vi.fn((_label: string, job: () => Promise<unknown>) => {
            const p = job();
            mocks.jobs.push(p);
            return p;
        }),
    },
}));
vi.mock('./agencyTimeskipRun', () => ({
    detectTimeskip: () => ({ weeks: 3 }),
    runTimeskip: () => ({ narration: 'Mira opened a stall by the north gate.', updatedNPCs: [], deltas: [], ticksConsumed: 3 }),
}));
vi.mock('../../turn/hostFacade', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../turn/hostFacade')>()),
    hasHostModelRole: (_facade: unknown, role: string) => role === 'utility',
}));

import { runAgencyTick } from './agencyEngine';
import type { HostFacade } from '../../turn/hostFacade';
import type { TurnCallbacks, TurnState } from '../../turn/turnOrchestrator';
import type { NPCEntry } from '../../../types';

const mira = { id: 'n1', name: 'Mira', populated: true, wants: { short: [], medium: ['open a stall'], long: 'be free' } } as unknown as NPCEntry;

function setup(reply: string) {
    const call = vi.fn().mockResolvedValue({ content: reply });
    const addMessage = vi.fn();
    const facade = {
        data: { context: {}, npcLedger: [mira] },
        config: { aiTier: 'max', moduleEnabled: {} },
        write: { updateContext: vi.fn(), updateNPC: vi.fn() },
        model: { call },
    } as unknown as HostFacade;
    const state = { settings: { aiTier: 'max' }, context: {} } as unknown as TurnState;
    const callbacks = { addMessage, updateContext: vi.fn(), updateNPC: vi.fn() } as unknown as TurnCallbacks;
    return { facade, state, callbacks, call, addMessage };
}

beforeEach(() => { mocks.jobs.length = 0; });

describe('timeskip narration (facade path)', () => {
    it('asks for the seam with thinking off', async () => {
        const { facade, state, callbacks, call } = setup('You return to find Mira at a new stall.');
        runAgencyTick(state, callbacks, [mira], 'Three weeks later.', facade);
        await Promise.all(mocks.jobs);
        expect(call.mock.calls[0][1].thinkingEffort).toBe('off');
    });

    it('an empty reply falls back to the deterministic narration instead of adding nothing', async () => {
        const { facade, state, callbacks, addMessage } = setup('   ');
        runAgencyTick(state, callbacks, [mira], 'Three weeks later.', facade);
        await Promise.all(mocks.jobs);
        expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({
            name: 'timeskip-seam',
            content: '[Time passes] Mira opened a stall by the north gate.',
        }));
    });
});
