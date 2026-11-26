import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AppSettings } from '../../../types';
import type { TurnCallbacks, TurnState } from '../turnOrchestrator';
import { buildHostFacade } from '../hostFacade';
import { validateNPCCandidates } from '../../npc/npcDetector';

/**
 * Every built-in tier feature reads its Block View switch. `tierAllows(tier, f)`
 * looks at the tier preset only (it passes `moduleEnabled: undefined`), so a
 * feature gated through it ignored the user's switch: the Block View showed a
 * toggle that did nothing. Gates call `isBlockEnabled(f, tier, moduleEnabled)`.
 */
const SRC = join(__dirname, '../../..');

function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(full);
        return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
}

describe('Block View switches', () => {
    it('no feature gate reads the tier preset alone', () => {
        const offenders = sourceFiles(SRC)
            .filter(file => !file.endsWith(join('turn', 'aiTier.ts')))
            .flatMap(file => readFileSync(file, 'utf8').split('\n')
                .map((line, i) => ({ line, at: `${relative(SRC, file)}:${i + 1}` }))
                .filter(({ line }) => /\btierAllows\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)))
            .map(({ at }) => at);
        expect(offenders).toEqual([]);
    });

    it('the host facade carries the switches, as a frozen copy', () => {
        const moduleEnabled = { directorBrief: false };
        const state = {
            input: 'x', displayInput: 'x',
            settings: { contextLimit: 8192, aiTier: 'max', moduleEnabled } as unknown as AppSettings,
            context: {}, messages: [], condenser: { condensedUpToIndex: -1 }, loreChunks: [], npcLedger: [], archiveIndex: [],
            activeCampaignId: 'c1',
        } as unknown as TurnState;
        const facade = buildHostFacade(state, {} as TurnCallbacks);

        expect(facade.config.moduleEnabled).toEqual({ directorBrief: false });
        expect(facade.config.moduleEnabled).not.toBe(moduleEnabled);
        expect(Object.isFrozen(facade.config.moduleEnabled)).toBe(true);
    });
});

describe('NPC name validation', () => {
    it('runs with thinking off: the next Send waits on this short answer', async () => {
        const modelCall = vi.fn().mockResolvedValue({ content: '["Therese"]' });
        await validateNPCCandidates(undefined, ['Therese'], 'Therese nods.', modelCall);
        expect(modelCall.mock.calls[0][0].thinkingEffort).toBe('off');
    });
});
