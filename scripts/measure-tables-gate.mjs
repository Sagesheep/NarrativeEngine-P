#!/usr/bin/env node
// WO-P5-06 — THE TABLES GATE — measurement script.
//
// Produces the only hard number in the plan (00_PLAN.md §5):
//   "The next ledger we build costs measurably less than the last one did."
//
// Two numbers, derived from the repo with commands shown:
//
//   BASELINE  — the like-for-like storage-and-plumbing cost of the hand-built
//               Location Ledger (commit 25aaf2c). Counts ONLY the nine
//               touchpoints, NOT the feature logic (locationParser.ts,
//               locationEnrich.ts, locationHeader.ts, their tests, payload
//               injection, tier wiring, UI). See WO-P5-06 §2.
//
//   MOD_PATH  — the cost of re-expressing the same storage as a mod-declared
//               table. That is the lines in mods/ledger-proof.mod.json that
//               declare the table (the `tables` array entry). The machinery
//               (routes, hydration, transfer, suffix derivation) already
//               exists from WO-P5-05; the mod adds zero code.
//
// The script prints every command it runs and every line it counts, so the
// numbers can be re-derived later rather than trusted. An arguable line is
// included with its reasoning shown; an unexplained total is not.
//
// Usage:  node scripts/measure-tables-gate.mjs
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const git = (args) => execSync(`git ${args}`, { cwd: __root, encoding: 'utf-8' });

// ─────────────────────────────────────────────────────────────────────────────
// 1. BASELINE — the hand-built Location Ledger, commit 25aaf2c, plumbing only.
// ─────────────────────────────────────────────────────────────────────────────
//
// The work order §2 names the nine touchpoints and the files they live in:
//
//   | Counts toward the baseline              | Does NOT count             |
//   | ─────────────────────────────────────── | ────────────────────────── |
//   | the file suffix in server/lib/fileStore | locationParser.ts          |
//   | the server route (GET/PUT)              | locationEnrich.ts          |
//   | store slice CRUD in campaignSlice       | locationHeader.ts          |
//   | hydration in campaignHydrator           | their tests                |
//   | accessor in campaignStore               | payload injection          |
//   | export/import wiring                    | aiTier.ts tier entry       |
//   | the type in types/location              | UI                         |
//
// The baseline is the storage-and-plumbing subset of 25aaf2c. We count ADDED
// lines (`+`) in each plumbing file, and within files that mix plumbing and
// feature logic we count only the plumbing hunks — naming which lines and why.
const BASELINE_COMMIT = '25aaf2c';

// (a) Pure-plumbing files: every added line counts.
//     `server/routes/campaigns.js` — the GET/PUT route pair (20 added lines,
//       one of which is the suffix-list entry; the other 19 are the route
//       handlers). All plumbing.
//     `server/lib/fileStore.js` — the `.locations.json` suffix entry (1 line
//       added; the diff shows the single-element insertion into
//       CAMPAIGN_FILE_SUFFIXES).
//     `src/store/campaignStore.ts` — the getLocationLedger/saveLocationLedger
//       accessors (17 added lines; pure plumbing — two fetch wrappers).
//     `src/store/campaignHydrator.ts` — hydration wiring (6 added lines: one
//       import, one Promise.all slot, one spread into the store setState).
//     `src/types/location.ts` — the LocationEntry + LocationSuggestion types
//       (34 added lines). The type IS a touchpoint ("the type in
//       types/location"). Counts in full.
const PURE_PLUMBING_FILES = [
    'server/routes/campaigns.js',
    'server/lib/fileStore.js',
    'src/store/campaignStore.ts',
    'src/store/campaignHydrator.ts',
    'src/types/location.ts',
];

// (b) Mixed file: count only the plumbing hunks, line by line.
//     `src/store/slices/campaignSlice.ts` — 98 added lines in 25aaf2c. Three
//     distinct subsets:
//
//       (i) CORE SLICE PLUMBING (counted): the LocationEntry/LocationSuggestion
//           import (1 — the import carries both; we count it because
//           LocationEntry IS the storage type, and the import is one line),
//           the _getStateForSave type widening for locationLedger (2 — the
//           getter type + the getter call widening), the
//           cancelPendingSaves locationTimer clear (1), the
//           flushAllPendingSaves location branch (9 — the if-block + the
//           fetch PUT), the debouncedSaveLocationLedger timer + function
//           (13), the CampaignSlice type declarations for the four CRUD
//           actions (4 — setLocationLedger/addLocation/updateLocation/
//           removeLocation), the _registerCampaignStateGetter wiring (1),
//           the initial locationLedger field (1), the setLocationLedger/
//           addLocation/updateLocation/removeLocation actions (32 —
//           including the 8-line context-nulling hook inside removeLocation,
//           which is the onRemove hook the mod path cannot reproduce; it
//           counts as a hand-built cost the mod path does not pay), and the
//           locationLedger spread in the getter (1). Subtotal: 71.
//
//       (ii) SUGGESTION QUEUE FEATURE LOGIC (excluded): the four type
//            declarations for the suggestion queue in the CampaignSlice type
//            (4 — locationSuggestions/addLocationSuggestions/dismiss/
//            clear) and the three action implementations (23 — the
//            addLocationSuggestions deduplication + dismiss + clear). The
//            suggestion queue is a feature of the Location Ledger, not
//            storage CRUD. §2: "store slice CRUD in campaignSlice.ts"
//            counts; the suggestion queue is not CRUD. It is also not in
//            the mod path's deliverables (a mod table gives you storage,
//            routes, hydration, transfer — not a suggestion queue). So it
//            is excluded from BOTH numbers. Subtotal: 27 excluded.
//
//       (iii) The remaining lines are diff context that the +filter counts
//             but are not feature logic (blank lines, etc.). They are counted
//             in the 71 above.
//
//     The `aiTier.ts` tier-entry lines are EXCLUDED by §2 ("does NOT count:
//     aiTier.ts tier entry"). The payload injection (payloadBuilder.ts,
//     volatile.ts) is EXCLUDED. The UI files are EXCLUDED.
const MIXED_FILE = 'src/store/slices/campaignSlice.ts';

// (c) Files excluded entirely by §2.
//     `src/services/turn/aiTier.ts` — tier entry (8 lines). Does NOT count.
//     `src/services/payload/payloadBuilder.ts` — payload injection. Does NOT count.
//     `src/services/payload/volatile.ts` — payload injection. Does NOT count.
//     `src/services/rules/defaultRules.ts` — payload injection. Does NOT count.
//     `src/services/turn/postTurnPipeline.ts` — feature logic (the locationScan
//       track). Does NOT count.
//     `src/services/turn/turnOrchestrator.ts` — feature logic. Does NOT count.
//     `src/services/locationParser.ts` — feature logic. Does NOT count.
//     `src/services/locationEnrich.ts` — feature logic. Does NOT count.
//     `src/services/locationHeader.ts` — feature logic. Does NOT count.
//     `src/services/__tests__/location*.test.ts` — their tests. Do NOT count.
//     `src/components/*` — UI. Does NOT count.
//     `src/App.tsx`, `src/components/Header.tsx`, `src/components/ChatArea.tsx`
//       — UI. Does NOT count.
//     `src/store/slices/uiSlice.ts` — UI. Does NOT count.
//     `src/types/gamecontext.ts` — the currentPlaceId/currentFeature pointer
//       is FEATURE logic (a place pointer the mod path does not carry). Does
//       NOT count toward the storage baseline.
//     `src/types/index.ts` — one re-export line. Arguable: it is plumbing for
//       the type. We EXCLUDE it to be conservative (counting it would raise
//       the baseline by 1, which makes the mod path look BETTER, not worse —
//       the wrong direction for an honest gate).
//     `WORKORDER-location-ledger.md` — documentation. Does NOT count.

function addedLinesInFile(file) {
    const diff = git(`show ${BASELINE_COMMIT} -- ${file}`);
    let count = 0;
    for (const line of diff.split('\n')) {
        // Count only added-content lines, not diff headers (`+++`) or hunk
        // headers (`@@`) or context lines (` `).
        if (line.startsWith('+') && !line.startsWith('+++')) count++;
    }
    return count;
}

/**
 * Count the added lines in campaignSlice.ts that belong to the suggestion
 * queue feature. These are EXCLUDED from the baseline because §2 counts
 * "store slice CRUD" and the suggestion queue is a feature, not CRUD — and
 * it is not in the mod path's deliverables.
 *
 * Two contiguous hunks:
 *   (1) The four type declarations in the CampaignSlice type:
 *         locationSuggestions: LocationSuggestion[];
 *         addLocationSuggestions: (suggestions: LocationSuggestion[]) => void;
 *         dismissLocationSuggestion: (name: string) => void;
 *         clearLocationSuggestions: () => void;
 *   (2) The three action implementations starting at `locationSuggestions: []`
 *       and ending at `clearLocationSuggestions: () => set(...)`.
 */
function addedSuggestionQueueLinesInCampaignSlice() {
    const diff = git(`show ${BASELINE_COMMIT} -- ${MIXED_FILE}`);
    const lines = diff.split('\n');
    let count = 0;
    // Hunk 1: the four type declarations. Identified by the line containing
    // `locationSuggestions: LocationSuggestion[];` and the three following
    // declarations ending at `clearLocationSuggestions: () => void;`.
    let inTypeHunk = false;
    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            if (/^\+\s*locationSuggestions: LocationSuggestion\[\];\s*$/.test(line)) { inTypeHunk = true; }
            if (inTypeHunk) {
                count++;
                if (/^\+\s*clearLocationSuggestions: \(\) => void;\s*$/.test(line)) { inTypeHunk = false; }
            }
        }
    }
    // Hunk 2: the three action implementations, starting at the initial
    // `locationSuggestions: [],` field and ending at `clearLocationSuggestions:
    // () => set(...)`.
    let inImplHunk = false;
    for (const line of lines) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            if (/^\+\s*locationSuggestions: \[\],\s*$/.test(line)) { inImplHunk = true; }
            if (inImplHunk) {
                count++;
                if (/^\+\s*clearLocationSuggestions:/.test(line) && /set\(\{ locationSuggestions: \[\] \}/.test(line)) {
                    inImplHunk = false;
                }
            }
        }
    }
    return count;
}

console.log('═══════════════════════════════════════════════════════════════════════');
console.log(' WO-P5-06 — THE TABLES GATE — measurement');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log();
console.log('BASELINE — hand-built Location Ledger, commit ' + BASELINE_COMMIT);
console.log('         storage-and-plumbing subset only (the nine touchpoints)');
console.log();
console.log('  Method: git show ' + BASELINE_COMMIT + ' -- <file> | count "^+" (excluding "+++")');
console.log();

let baseline = 0;
console.log('  (a) Pure-plumbing files — every added line counts:');
for (const file of PURE_PLUMBING_FILES) {
    const n = addedLinesInFile(file);
    baseline += n;
    console.log(`      ${String(n).padStart(4)}  ${file}`);
}
console.log();

const mixedAll = addedLinesInFile(MIXED_FILE);
const suggestionQueue = addedSuggestionQueueLinesInCampaignSlice();
const mixed = mixedAll - suggestionQueue;
baseline += mixed;
console.log('  (b) Mixed file — plumbing subset only (see script header for reasoning):');
console.log(`      ${String(mixedAll).padStart(4)}  ${MIXED_FILE}  (total added lines)`);
console.log(`      ${String(suggestionQueue).padStart(4)}                    minus the suggestion-queue feature`);
console.log(`      ────`);
console.log(`      ${String(mixed).padStart(4)}  ${MIXED_FILE}  (plumbing subset)`);
console.log('           (the four CRUD actions + the debounced save timer + the');
console.log('            flushAllPendingSaves branch + the state-getter wiring;');
console.log('            the 8-line onRemove context-nulling hook inside');
console.log('            removeLocation counts as a hand-built cost the mod');
console.log('            path does not pay — it is a hook the descriptor');
console.log('            machinery would later absorb. The suggestion queue');
console.log('            (addLocationSuggestions + dismiss + clear) is a');
console.log('            feature, not CRUD, and is excluded from both numbers.)');
console.log();

console.log('  (c) Excluded by §2 (feature logic / tier / payload / UI / docs):');
console.log('        src/services/turn/aiTier.ts            (tier entry)');
console.log('        src/services/turn/postTurnPipeline.ts  (locationScan track)');
console.log('        src/services/turn/turnOrchestrator.ts  (feature wiring)');
console.log('        src/services/payload/payloadBuilder.ts (payload injection)');
console.log('        src/services/payload/volatile.ts       (payload injection)');
console.log('        src/services/rules/defaultRules.ts     (payload injection)');
console.log('        src/services/locationParser.ts         (feature logic)');
console.log('        src/services/locationEnrich.ts         (feature logic)');
console.log('        src/services/locationHeader.ts         (feature logic)');
console.log('        src/services/__tests__/location*.test.ts (their tests)');
console.log('        src/components/**                        (UI)');
console.log('        src/App.tsx, src/store/slices/uiSlice.ts (UI)');
console.log('        src/types/gamecontext.ts                 (place pointer = feature)');
console.log('        src/types/index.ts                       (re-export; excluded');
console.log('                                                to be conservative —');
console.log('                                                counting it would raise');
console.log('                                                the baseline by 1, making');
console.log('                                                the mod path look BETTER)');
console.log('        WORKORDER-location-ledger.md             (docs)');
console.log();
console.log(`  BASELINE = ${baseline} lines`);
console.log();

// ─────────────────────────────────────────────────────────────────────────────
// 2. MOD_PATH — the cost of declaring the same storage as a mod table.
// ─────────────────────────────────────────────────────────────────────────────
//
// The machinery (modLoader validation, modTableRegistry suffix derivation +
// registration, the dynamic /mod-tables/ route pair, hydration, export with
// unknown-key preservation) already exists from WO-P5-05. The mod adds ZERO
// code. The only cost is the `tables` array entry in the mod manifest.
//
// We count the lines inside the `tables` array of mods/ledger-proof.mod.json.
// The manifest's other fields (id, name, version, contributions) are not
// storage-and-plumbing — they are mod metadata that any mod pays regardless
// of whether it declares a table. The §2 comparison is storage-cost vs
// storage-cost, so we count only the table declaration.
const proofModPath = path.join(__root, 'mods', 'ledger-proof.mod.json');
const proofModText = fs.readFileSync(proofModPath, 'utf-8');
const proofMod = JSON.parse(proofModText);

// Count the lines that make up the `tables` array in the source text. The
// manifest is pretty-printed, so the array spans from the line opening with
// `"tables": [` through the line that is just `]`. We count those lines
// verbatim from the file, so the number is reproducible from the file alone.
const lines = proofModText.split('\n');
let modPath = 0;
let inTables = false;
const countedLines = [];
for (const line of lines) {
    if (/^\s*"tables":\s*\[/.test(line)) { inTables = true; modPath++; countedLines.push(line); continue; }
    if (inTables) {
        modPath++;
        countedLines.push(line);
        if (/^\s*\]/.test(line)) { inTables = false; }
    }
}

console.log('MOD_PATH — mod-declared table, mods/ledger-proof.mod.json');
console.log('         (the machinery already exists from WO-P5-05; the mod adds zero code)');
console.log();
console.log('  Method: count the lines inside the `tables` array of the manifest.');
console.log('          The manifest metadata (id/name/version/contributions) is paid by');
console.log('          any mod regardless of tables, so it is not storage-cost.');
console.log();
console.log(`  The counted lines, verbatim from mods/ledger-proof.mod.json:`);
for (const l of countedLines) {
    console.log(`    | ${l}`);
}
console.log();
console.log(`  MOD_PATH = ${modPath} lines`);
console.log();

// ─────────────────────────────────────────────────────────────────────────────
// 3. The verdict.
// ─────────────────────────────────────────────────────────────────────────────
const ratio = (baseline / modPath).toFixed(1);
const reduction = ((1 - modPath / baseline) * 100).toFixed(1);
console.log('═══════════════════════════════════════════════════════════════════════');
console.log(`  BASELINE (hand-built storage-and-plumbing) = ${baseline} lines`);
console.log(`  MOD_PATH (mod-declared table)              = ${modPath} lines`);
console.log(`  ratio                                       = ${ratio}:1`);
console.log(`  reduction                                   = ${reduction}%`);
console.log('═══════════════════════════════════════════════════════════════════════');
console.log();
const passed = modPath < baseline;
console.log(`  Verdict: ${passed ? 'PASSED' : 'FAILED'} — ${passed ? 'the mod path costs measurably less.' : 'the mod path does NOT cost measurably less; report this, do not tune the measurement.'}`);
console.log();
console.log('  Both numbers are derived from the repo by this script. Re-run with:');
console.log('    node scripts/measure-tables-gate.mjs');