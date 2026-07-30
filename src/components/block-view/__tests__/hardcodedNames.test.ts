import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listTierBlocks, type TierFeature } from '../../../services/turn/aiTier';
import { createFinalUserRegistry } from '../../../services/payload/contributions/builtins';
import { postTurnTracks } from '../../../services/turn/tracks';

/**
 * WORKORDER-P5-02 §8 — the hardcoded-name grep.
 *
 * "No feature id from any registry may appear as a literal in src/components/block-view/."
 * This is the hard failure condition from §4: a feature name appearing as a string literal
 * in the new component fails the work order. The whole value of this view is the compliance
 * property — a feature appears in the graph if and only if it went through a seam.
 *
 * The test enumerates every id the three registries publish and asserts that none appears
 * as a substring of any source file under `src/components/block-view/`. The `blockModel.ts`
 * file legitimately imports the registry accessors by SYMBOL (`listTierBlocks`,
 * `createFinalUserRegistryWithExtensions`, `postTurnTracks`), not by id — those imports are
 * not feature names and are not flagged.
 *
 * False-positive guard: a TierFeature id that happens to be a common English word would
 * match inside a comment or a CSS class. To stay precise, the check counts occurrences of
 * the id as a quoted string-literal token (single OR double quotes, OR as a template
 * literal `${id}`), which is the shape a hardcode would actually take. Bare substring
 * matches inside prose are not hits, because prose is not how a feature gets hardcoded —
 * an `if (id === '<feature>')` is.
 */
const BLOCK_VIEW_DIR = resolve(__dirname, '..');

function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            // Tests legitimately reference feature ids to enumerate them; the §8 rule applies
            // to the component, not its test harness.
            if (entry === '__tests__' || entry === 'node_modules') continue;
            out.push(...listSourceFiles(full));
        } else if (/\.(ts|tsx)$/.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

/** Every id the three registries publish. */
function allRegistryIds(): string[] {
    const tier = listTierBlocks().map((b) => b.id as string);
    const contributions = createFinalUserRegistry().list().map((m) => m.id);
    const tracks = postTurnTracks.list().map((t) => t.id);
    return [...tier, ...contributions, ...tracks];
}

/** A literal occurrence of `id` as a quoted string token in `source`. */
function appearsAsQuotedLiteral(id: string, source: string): boolean {
    // Double-quoted: "id"
    if (source.includes(`"${id}"`)) return true;
    // Single-quoted: 'id'
    if (source.includes(`'${id}'`)) return true;
    // Template literal with the id as its sole expression or a quoted segment: `${id}`
    // would be a SYMBOL reference, not a literal — so do NOT flag that. Only flag a
    // backtick-wrapped literal string that equals the id, e.g. `arcSpawn`.
    if (source.includes('`' + id + '`')) return true;
    return false;
}

describe('WORKORDER-P5-02 §8 — no hardcoded feature names in src/components/block-view/', () => {
    const ids = allRegistryIds();
    const files = listSourceFiles(BLOCK_VIEW_DIR);

    it('the test harness found the block-view source files (guard against a path drift)', () => {
        expect(files.length).toBeGreaterThan(0);
        expect(files.map((f) => f.replace(/\\/g, '/')).some((f) => f.endsWith('blockModel.ts'))).toBe(true);
    });

    it('the test harness enumerated ids from all three registries', () => {
        expect(ids.length).toBeGreaterThanOrEqual(27 + 8 + 3);
    });

    it('no registry id appears as a quoted string literal in any block-view source file', () => {
        const offenders: string[] = [];
        for (const file of files) {
            const source = readFileSync(file, 'utf8');
            for (const id of ids) {
                if (appearsAsQuotedLiteral(id, source)) {
                    offenders.push(`${file.replace(/\\/g, '/')} : "${id}"`);
                }
            }
        }
        expect(offenders, `hardcoded feature names found:\n${offenders.join('\n')}`).toEqual([]);
    });

    it('the arcSpawn id specifically is not hardcoded anywhere (the §5 manual-trigger case)', () => {
        const files2 = listSourceFiles(BLOCK_VIEW_DIR);
        for (const file of files2) {
            const source = readFileSync(file, 'utf8');
            expect(appearsAsQuotedLiteral('arcSpawn', source), `arcSpawn hardcoded in ${file}`).toBe(false);
        }
    });

    it('a sample of TierFeature ids are checked by symbol, not skipped', () => {
        // Guard against the test silently passing because `ids` was empty. Pull a few
        // well-known ids and confirm they are in the enumerated set.
        const sample: TierFeature[] = ['planner', 'directorBrief', 'arcSpawn', 'heartbeatTick', 'enemyDiscovery'];
        for (const id of sample) {
            expect(ids, `expected ${id} in the enumerated id set`).toContain(id);
        }
    });
});