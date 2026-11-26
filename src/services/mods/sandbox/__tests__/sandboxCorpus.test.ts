import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorkerSource } from '../workerPrelude';

const FIXTURE_NAMES = [
    'ok.js',
    'throws.js',
    'infinite.js',
    'memoryhog.js',
    'escape-net.js',
    'escape-store.js',
    'heavy-payload.js',
] as const;

function readFixture(name: string): string {
    return readFileSync(resolve(process.cwd(), 'src/services/mods/sandbox/__tests__/fixtures', name), 'utf8');
}

describe('ported sandbox spike corpus', () => {
    it.each(FIXTURE_NAMES)('%s is a product compute source and is carried into the worker prelude', (name) => {
        const source = readFixture(name);
        const workerSource = buildWorkerSource(source);

        expect(source).toMatch(/^export default async function/);
        expect(workerSource).toContain('globalThis.__sandboxMod = async function');
        expect(workerSource).toContain(source.replace(/^export default\s+/, '').trim());
    });

    it('retains the spike probes and one-megabyte payload', () => {
        expect(readFixture('escape-net.js')).toContain("fetch('https://example.com/')");
        expect(readFixture('escape-store.js')).toContain("'useAppStore'");
        expect(readFixture('heavy-payload.js')).toContain("'x'.repeat(1024 * 1024)");
    });
});

