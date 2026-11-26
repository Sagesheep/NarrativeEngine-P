// Phase 0.5 — the zero-mod base-app gate.
//
// This is the gate the CONTRACT.md green rule is enforceable through. It runs
// one canonical turn against a fresh fixed fixture with an empty mods root,
// captures the full OpenAIMessage[] payload + the ordered post-turn effect
// trace, and asserts byte-identity against a checked-in baseline.
//
// A failure prints a focused diff — the first divergent effect or the first
// changed payload byte — so a regression is locatable, not just detectable.
//
// The gate must pass from a clean checkout with no network and no running app.
// It does NOT normalize, sort, redact, or weaken the comparison (Phase 0.5 §2):
// a changed byte is a changed base-app behavior.
//
// Baseline updates require a separately approved product-behavior decision
// and a reviewable fixture diff (CONTRACT.md green rule). Refactors, mount
// points, registries, and service migrations do not justify a baseline refresh.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { runCanonicalTurn } from './runCanonicalTurn';
import { postTurnTracks } from '../../tracks';
import { getExtensionModules } from '../../../payload/contributions/extensions';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(HERE, 'baseline.json');

// Canonical serialization — stable key order via JSON.stringify's natural
// string-key ordering. The trace is already deep-normalized by the recorder
// (functions dropped, circular refs replaced), so this is the byte contract.
function serialize(trace: unknown): string {
    return JSON.stringify(trace, null, 0);
}

function readBaseline(): string | null {
    if (!existsSync(BASELINE_PATH)) return null;
    return readFileSync(BASELINE_PATH, 'utf-8');
}

function writeBaseline(serialized: string): void {
    writeFileSync(BASELINE_PATH, serialized, 'utf-8');
}

// Focused diff — find the first divergent byte and print a small window
// around it so a regression is locatable. The gate's failure output is the
// most-read artefact it produces, so it is worth making legible.
//
// The trace is one JSON line, so a line-based diff is useless. We walk
// character-by-character to find the first divergence, then print the
// surrounding context with a caret pointing at the exact byte.
function focusedDiff(actual: string, expected: string): string {
    if (actual === expected) return 'traces are byte-identical';
    const maxLen = Math.max(actual.length, expected.length);
    let firstDiff = -1;
    for (let i = 0; i < maxLen; i++) {
        const a = actual[i] ?? '';
        const e = expected[i] ?? '';
        if (a !== e) { firstDiff = i; break; }
    }
    if (firstDiff === -1 && actual.length !== expected.length) {
        firstDiff = Math.min(actual.length, expected.length);
    }
    const ctxStart = Math.max(0, firstDiff - 80);
    const ctxEnd = Math.min(maxLen, firstDiff + 120);
    const aCtx = actual.slice(ctxStart, ctxEnd);
    const eCtx = expected.slice(ctxStart, ctxEnd);
    const caret = ' '.repeat(firstDiff - ctxStart) + '^';
    const lines: string[] = [];
    lines.push(`First divergent byte at offset ${firstDiff}:`);
    lines.push(`  expected: ...${eCtx}...`);
    lines.push(`  actual:   ...${aCtx}...`);
    lines.push(`            ${caret}`);
    // Decode any escape-sequence divergence (\n vs literal etc.) so a byte
    // change in a JSON string body is legible.
    const eByte = expected[firstDiff] ?? '<EOF>';
    const aByte = actual[firstDiff] ?? '<EOF>';
    lines.push(`  expected byte: ${JSON.stringify(eByte)}  actual byte: ${JSON.stringify(aByte)}`);
    return lines.join('\n');
}

describe('Phase 0.5 — zero-mod base-app gate', () => {
    beforeEach(() => {
        // Ensure no leftover mod tracks or extension modules from prior tests.
        for (const track of postTurnTracks.list()) {
            if (track.id.startsWith('mod.') && track.id.endsWith('.compute')) {
                postTurnTracks.unregister(track.id);
            }
        }
    });

    afterEach(() => {
        // Defensive cleanup — a test that registered a mod track would
        // contaminate the next run.
        for (const track of postTurnTracks.list()) {
            if (track.id.startsWith('mod.') && track.id.endsWith('.compute')) {
                postTurnTracks.unregister(track.id);
            }
        }
    });

    it('proves the fixture is a real no-mod state', async () => {
        const result = await runCanonicalTurn();
        expect(result.modsRegistered).toBe(false);
        expect(result.computeTracksRegistered).toBe(false);
        expect(getExtensionModules().length).toBe(0);
        const computeTracks = postTurnTracks.list().filter(t => t.id.startsWith('mod.') && t.id.endsWith('.compute'));
        expect(computeTracks).toHaveLength(0);
    });

    it('produces a non-empty payload + at least one post-turn effect', async () => {
        const result = await runCanonicalTurn();
        expect(result.trace.payload.length).toBeGreaterThan(0);
        expect(result.trace.effects.length).toBeGreaterThan(0);
        // The archive append must land (the post-turn pipeline's primary job).
        const archiveAppend = result.trace.effects.find(
            e => e.kind === 'api' && e.name.includes('archive') && e.name.includes('append'),
        );
        // The effect recorder sees the fetch log; the api route names are
        // matched by URL, so look for any api effect referencing the archive
        // POST. If the recorder did not capture it by name, the fetch log
        // is the fallback.
        const archiveFetch = result.fetchLog.find(
            f => f.url.endsWith(`/campaigns/${result.trace.finalMessages.length ? 'camp-base-app-gate' : 'camp-base-app-gate'}/archive`) && f.method === 'POST',
        );
        expect(archiveAppend || archiveFetch).toBeTruthy();
    });

    it('matches the checked-in baseline byte-for-byte (the green rule)', async () => {
        const result = await runCanonicalTurn();
        const actualSerialized = serialize(result.trace);
        const expected = readBaseline();

        if (expected === null) {
            // First run — write the baseline and fail with a clear message so
            // the reviewer sees the new artefact. Per the green rule, a
            // baseline update is a reviewable diff, not a silent acceptance.
            writeBaseline(actualSerialized);
            expect.fail(
                'No baseline found at baseline.json — wrote the first baseline from this run.\n' +
                'Review the file before accepting it. A baseline update requires a separately\n' +
                'approved product-behavior decision (CONTRACT.md green rule).',
            );
        }

        if (actualSerialized !== expected) {
            expect.fail(
                `Base-app gate FAILED — the canonical turn diverged from the baseline.\n` +
                `A changed byte is a changed base-app behavior. Per the green rule, a baseline\n` +
                `update requires a separately approved product-behavior decision.\n\n` +
                focusedDiff(actualSerialized, expected),
            );
        }
        // Byte-identity is the gate. If we reach this assertion, the trace
        // matched exactly.
        expect(actualSerialized).toBe(expected);
    });
});