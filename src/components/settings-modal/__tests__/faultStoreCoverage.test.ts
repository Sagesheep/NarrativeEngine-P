import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Every fault store must reach the Extensions screen.
 *
 * A fault store exists so a user can see that one of their mods misbehaved.
 * A store nothing renders is worse than no store: the failure is recorded,
 * the code reads as if it were handled, and the user is told nothing.
 *
 * This has now happened five times. `macroFaultStore` shipped in Phase 5.1
 * without being wired, which the comment in `ExtensionsTab.tsx` records —
 * and then `mountFaultStore` (19 report sites), `factFaultStore` (19),
 * `budgetFaultStore` (4) and `oocSectionFaultStore` (3) repeated it, so 45
 * report sites fed a list no screen read.
 *
 * The cause is two hand-maintained lists (`collectRuntimeFaults` and
 * `RUNTIME_FAULT_STORES`) that a new store has to be added to by hand. Until
 * the stores self-register, this test is what keeps the lists honest: it
 * discovers every `*FaultStore` singleton in the services tree and asserts
 * the screen both collects and subscribes to it.
 */

const SRC = resolve(__dirname, '../../..');
const SERVICES = join(SRC, 'services');
const EXTENSIONS_TAB = join(SRC, 'components/settings-modal/ExtensionsTab.tsx');

/** Recursively list .ts/.tsx files, skipping test folders. */
function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === '__tests__' || entry === 'fixtures') continue;
            sourceFiles(full, out);
        } else if (/\.tsx?$/.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

/** Every exported `<name>FaultStore` singleton under src/services. */
function discoverFaultStores(): string[] {
    const names = new Set<string>();
    for (const file of sourceFiles(SERVICES)) {
        const text = readFileSync(file, 'utf-8');
        for (const m of text.matchAll(/^export const (\w*FaultStore)\s*=/gm)) {
            names.add(m[1]);
        }
    }
    return [...names].sort();
}

describe('Extensions screen fault coverage', () => {
    const stores = discoverFaultStores();
    const tab = readFileSync(EXTENSIONS_TAB, 'utf-8');

    it('discovers the fault stores at all (guards the guard)', () => {
        // If this regex stops matching, every assertion below passes vacuously.
        expect(stores.length).toBeGreaterThanOrEqual(12);
        expect(stores).toContain('sandboxFaultStore');
    });

    it.each(stores)('%s is collected into the runtime fault list', (store) => {
        expect(tab).toContain(`...${store}.getFaults()`);
    });

    it.each(stores)('%s is subscribed to for refreshes', (store) => {
        // The store must also appear in RUNTIME_FAULT_STORES, or its faults
        // render only until the next unrelated re-render.
        const subscribeList = tab.slice(tab.indexOf('const RUNTIME_FAULT_STORES'));
        const listBody = subscribeList.slice(0, subscribeList.indexOf('] as const'));
        expect(listBody).toContain(store);
    });
});
