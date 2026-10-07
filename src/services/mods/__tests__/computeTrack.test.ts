import { describe, expect, it, vi } from 'vitest';
import type { HostFacade } from '../../turn/hostFacade';
import { modToComputeTrack } from '../computeTrack';
import type { ValidatedMod } from '../modTypes';
import { createSandboxFaultPolicy } from '../sandbox/sandboxFaults';
import type { SandboxHostMessage, SandboxWorkerLike, SandboxWorkerMessage } from '../sandbox/sandboxTypes';

class ErrorWorker implements SandboxWorkerLike {
    onmessage: SandboxWorkerLike['onmessage'] = null;
    onerror: SandboxWorkerLike['onerror'] = null;
    terminated = false;

    postMessage(message: SandboxHostMessage): void {
        if (message.type === 'run') {
            queueMicrotask(() => this.onmessage?.({
                data: { type: 'error', message: 'mod failed' },
            } as MessageEvent<SandboxWorkerMessage>));
        }
    }

    terminate(): void {
        this.terminated = true;
    }
}

function makeFacade(): HostFacade {
    const controller = new AbortController();
    return {
        data: { context: {}, messages: [] } as unknown as HostFacade['data'],
        config: { contextLimit: 4096 } as HostFacade['config'],
        write: {} as HostFacade['write'],
        model: { call: vi.fn(), callJson: vi.fn(), available: vi.fn(() => true) },
        table: { read: vi.fn(async () => []), write: vi.fn(async () => undefined) },
        signal: controller.signal,
        refresh: vi.fn(),
        log: vi.fn(),
    };
}

function makeContext(allMsgs: HostFacade['data']['messages']): Parameters<ReturnType<typeof modToComputeTrack>['run']>[0] {
    return {
        facade: makeFacade(),
        displayInput: '',
        lastAssistantContent: '',
        allMsgs,
        npcLedger: [],
        activeCampaignId: 'campaign',
    };
}

const mod = {
    id: 'arc',
    name: 'Arc',
    version: '1.0.0',
    description: '',
    file: 'arc/manifest.json',
    contributions: [],
    tables: [],
    panels: [],
    screens: [],
    screenSources: [],
    compute: { file: 'compute.js', hook: 'postTurn' as const, capabilities: [] },
    computeSource: 'export default async function () { throw new Error("failed"); }',
} as unknown as ValidatedMod;

describe('compute fault policy wiring', () => {
    it('does not rerun a faulted mod across swipes, but permits it on a new turn', async () => {
        const createWorker = vi.fn(() => new ErrorWorker());
        const policy = createSandboxFaultPolicy();
        const track = modToComputeTrack(mod, {
            sandboxPolicy: policy,
            sandboxOptions: { createWorker },
        });
        const firstTurn: Parameters<typeof makeContext>[0] = [];
        const swipeContext = makeContext(firstTurn);
        const newTurnContext = makeContext([]);

        expect(track.shouldRun(swipeContext)).toBe(true);
        await expect(track.run(swipeContext)).rejects.toThrow('mod failed');
        expect(track.shouldRun(swipeContext)).toBe(false);

        await track.run(swipeContext);
        expect(createWorker).toHaveBeenCalledTimes(1);

        expect(track.shouldRun(newTurnContext)).toBe(true);
        await expect(track.run(newTurnContext)).rejects.toThrow('mod failed');
        expect(createWorker).toHaveBeenCalledTimes(2);
        expect(policy.getStrikes('arc')).toBe(2);
    });
});

// The arc tick used to be an in-tree step gated on `arcTick`; as a mod it ran on
// every tier and the Block View switch did nothing.
describe('compute track — the Arc Engine keeps the arcTick switch', () => {
    const withConfig = (config: Partial<HostFacade['config']>) => {
        const ctx = makeContext([]);
        (ctx.facade as { config: unknown }).config = { contextLimit: 4096, ...config };
        return ctx;
    };
    const track = modToComputeTrack(mod, { sandboxPolicy: createSandboxFaultPolicy() });

    it('runs on Max and Pro, not on Lite', () => {
        expect(track.shouldRun(withConfig({ aiTier: 'max' }))).toBe(true);
        expect(track.shouldRun(withConfig({ aiTier: 'pro' }))).toBe(true);
        expect(track.shouldRun(withConfig({ aiTier: 'lite' }))).toBe(false);
    });

    it('follows the Block View switch over the tier', () => {
        expect(track.shouldRun(withConfig({ aiTier: 'max', moduleEnabled: { arcTick: false } }))).toBe(false);
        expect(track.shouldRun(withConfig({ aiTier: 'lite', moduleEnabled: { arcTick: true } }))).toBe(true);
    });

    it('leaves other compute mods alone', () => {
        const other = modToComputeTrack({ ...mod, id: 'weather' } as ValidatedMod, { sandboxPolicy: createSandboxFaultPolicy() });
        expect(other.shouldRun(withConfig({ aiTier: 'lite', moduleEnabled: { arcTick: false } }))).toBe(true);
    });
});
