// Phase 7.5 §3 item 1 — the facade's feature-shaped surface, pinned.
//
// `FacadeData` exposes two fields named after a feature: `enemyCompendium` and
// `enemyCombatConfig`. The phase requires a decision, not an accident, and the
// decision recorded on the type is: **deleted with the subsystem in Phase 8.3,
// not turned into a service role** — because core makes no ask here (`ROLES.md`
// §1's test), and because publishing a permanent role id for something nobody
// wants to replace is worse than having none (`ROLES.md` §6.3).
//
// That ruling is only safe while the reader set stays inside the subsystem that
// is leaving. This test is the mechanical guard on that claim — the same
// species as the epic's other unarguable gates. It walks `src/` and fails if
// any file outside the enemy subsystem reads either field off a facade.
//
// It is deliberately a source scan rather than a type-level trick: the property
// is public on a public interface, so nothing in the type system can express
// "only these files may read it", and Phase 7.5 §5's stop condition is about
// *consumers*, which is a fact about files.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A read of either field off anything facade-shaped: `<expr>.data.<field>`. */
const READ_PATTERN = /\.data\.(enemyCompendium|enemyCombatConfig)\b/;

/**
 * Files allowed to read them.
 *
 * Measured, and it is **one file**: `enemySuggestionTrack.ts`, the post-turn
 * track that IS the departing subsystem. Nothing else in `src/` — not the
 * components, not the store, not the other tracks, not even the facade's own
 * tests — reads either field off a facade.
 *
 * **Adding an entry here is the stop condition firing.** Phase 7.5 §5: *"If
 * removing a feature name from the facade breaks a consumer that is not a mod,
 * stop. That consumer is core depending on a feature, and it needs its own
 * decision before Phase 8 pulls."* A new non-subsystem reader is exactly that,
 * and it must be routed back rather than allowlisted.
 */
const ALLOWED = new Set([
    'services/turn/tracks/enemySuggestionTrack.ts',
    'services/turn/__tests__/facadeReaderSurface.test.ts',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
    }
    return out;
}

describe('Phase 7.5 — the facade\'s feature-shaped fields have exactly one owner', () => {
    it('nothing outside the departing subsystem reads them', () => {
        const offenders: string[] = [];
        for (const file of walk(SRC_ROOT)) {
            const rel = relative(SRC_ROOT, file).split(sep).join('/');
            if (ALLOWED.has(rel)) continue;
            const source = readFileSync(file, 'utf-8');
            if (READ_PATTERN.test(source)) offenders.push(rel);
        }
        expect(offenders).toEqual([]);
    });

    it('the allowlist is not stale — every entry still reads them', () => {
        // An allowlist that outlives its reason silently widens the licence.
        // When Phase 8.3 deletes the track, this fails and the entry must go
        // with it, which is how the pin retires itself.
        const stale: string[] = [];
        for (const rel of ALLOWED) {
            if (rel.endsWith('facadeReaderSurface.test.ts')) continue;
            const source = readFileSync(join(SRC_ROOT, ...rel.split('/')), 'utf-8');
            if (!READ_PATTERN.test(source)) stale.push(rel);
        }
        expect(stale).toEqual([]);
    });

    it('the mod-facing projection never carried them at all', async () => {
        // `ModData` is what a mod sees. It has never exposed these two, so no
        // mod can be depending on them when Phase 8.3 deletes them — the reason
        // §5's stop condition is about non-mod consumers in the first place.
        const modTypes = readFileSync(join(SRC_ROOT, 'services', 'mods', 'modTypes.ts'), 'utf-8');
        const modDataBlock = modTypes.slice(modTypes.indexOf('interface ModData'));
        expect(modDataBlock).not.toMatch(/enemyCompendium|enemyCombatConfig/);
    });
});
