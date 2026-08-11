// Legacy-file adoption — Phase 8.5.
//
// ┌─ THE PROBLEM ────────────────────────────────────────────────────────────┐
// │ A feature left core. Its data did not. Every campaign on disk still holds │
// │ files the app wrote for a year and no longer reads, and the mod that now  │
// │ owns that feature reads a different file that does not exist yet.         │
// │                                                                           │
// │ Everything else in the modularity epic can be rolled back. This cannot,   │
// │ so the whole mechanism is built around one sentence: **the legacy file is │
// │ never modified and never deleted.** Adoption is a COPY. If every line     │
// │ below is wrong, the worst outcome is a mod that sees an empty table while │
// │ the user's data sits untouched where it has always been.                  │
// └───────────────────────────────────────────────────────────────────────────┘
//
// ── How it runs ────────────────────────────────────────────────────────────
//
// Lazily, on the mod-table GET route (`tableRegistry.js`), which the campaign
// hydrator calls once per declared table on every campaign load. That is what
// "on campaign load, once, idempotently" means in practice, and it has three
// properties a scheduled migration pass would not:
//
//   • No mod, no adoption. Delete the mod folder and its tables are not
//     registered, so the route 404s before any of this is reached and the
//     legacy files sit dormant — which is exactly what Phase 8.6's gate
//     demands of a deleted mod.
//   • No campaign open, no work. Nothing scans `data/campaigns/` at boot.
//   • No race with the hydrator. The adoption is inside the read the hydrator
//     is already awaiting, so a mod cannot observe the empty table first.
//
// ── Idempotence ────────────────────────────────────────────────────────────
//
// Guarded by the ledger (`<campaignId>.migrations.json`), not by "does the
// target file exist". The difference matters exactly once, and it is the case
// that would be a bug: a user who runs **Delete data** (`DATA_POLICY.md` §3)
// removes the mod's tables, and file-presence alone would re-adopt the legacy
// data on the next open — resurrecting what they just deleted. The ledger says
// "this campaign has passed the adoption point", and passing it is permanent.
//
// ── Repair ─────────────────────────────────────────────────────────────────
//
// Adoption does NOT repair. It parses and re-serialises, nothing more. The
// repair that real campaigns depend on (Phase 8.5 §3.5 — today's 443-line
// schema fixes shapes on load, so live data almost certainly contains records
// that only survive because of it) is the MOD's, and it runs on read, on every
// read, for adopted and native records alike (Phase 8.2 D2). Repairing here as
// well would mean two implementations of the same repair drifting apart, which
// is the failure this epic keeps finding rather than one it should add.

import fs from 'fs';
import path from 'path';
import { CAMPAIGNS_DIR, MIGRATION_LEDGER_SUFFIX, readJson, writeJson, ensureDirs } from './fileStore.js';
import { isRetiredCampaignFile } from './legacyTables.js';

const LEDGER_VERSION = 1;

/** See the read site: `null` is a valid file content, so it cannot mean "failed to read". */
const UNREADABLE = Symbol('legacy-file-unreadable');

/**
 * Does this table file hold nothing? `[]` for an array table, `null` for a
 * single-object one, and an unreadable file — which holds nothing usable and
 * is about to be overwritten by data that is at least parseable.
 */
function isEmptyTable(value) {
    if (value === UNREADABLE || value === null || value === undefined) return true;
    return Array.isArray(value) && value.length === 0;
}

/** The ledger path for a campaign. Caller has already validated the id. */
export function migrationLedgerPath(campaignId) {
    return path.join(CAMPAIGNS_DIR, `${campaignId}${MIGRATION_LEDGER_SUFFIX}`);
}

/**
 * Read the ledger, always as a well-formed object. A missing, unreadable or
 * hand-mangled ledger reads as empty rather than throwing: a broken ledger must
 * cost at most one redundant adoption attempt (which the target-exists guard
 * then turns into a no-op), never a campaign that will not open.
 */
export function readMigrationLedger(campaignId) {
    const raw = readJson(migrationLedgerPath(campaignId), null);
    return normalizeLedger(raw);
}

/**
 * Coerce anything into the ledger shape. Exported because import
 * (`transfer.js`) runs bundle-supplied content through it — a bundle is
 * untrusted input and must not be able to write an arbitrary object into a
 * campaign file the host reads back.
 */
export function normalizeLedger(raw) {
    const out = { version: LEDGER_VERSION, adopted: {}, failures: {} };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const key of ['adopted', 'failures']) {
        const section = raw[key];
        if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
        for (const [table, entry] of Object.entries(section)) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
            out[key][table] = entry;
        }
    }
    return out;
}

function writeLedger(campaignId, ledger) {
    ensureDirs();
    writeJson(migrationLedgerPath(campaignId), ledger);
}

/**
 * Adopt one retired campaign file into one mod table, if there is anything to
 * adopt and it has not happened already.
 *
 * NEVER THROWS. Phase 8.5 §3.6: "A migration that fails must leave the campaign
 * openable, with the failure surfaced." Openable comes first — every failure
 * path here returns a result object and leaves both files exactly as they were.
 * Surfaced comes second: the reason is recorded in the ledger's `failures`
 * (readable at `GET /api/campaigns/:id/migrations`) and logged. A failure is
 * NOT latched: it is retried on the next campaign load, because the likeliest
 * cause is transient (a locked file, a full disk) and a permanent one simply
 * fails again and says so again.
 *
 * @param {string} campaignId
 * @param {{ name: string, fileSuffix: string, recordShape: string, migrateFrom?: string }} descriptor
 * @returns {{ status: 'skipped'|'adopted'|'sealed'|'failed', reason?: string, records?: number|null }}
 */
export function adoptLegacyTable(campaignId, descriptor) {
    const from = descriptor?.migrateFrom;
    if (typeof from !== 'string' || from.length === 0) {
        return { status: 'skipped', reason: 'no-declaration' };
    }
    // Belt-and-braces. `modLoader.js` already rejects a manifest whose
    // `migrateFrom` is not a retired file, so this is unreachable through the
    // loader — which is the point. The check is here too because this is the
    // line that turns a string into a filesystem read, and a defence at the
    // point of use survives a refactor of the defence at the point of entry.
    if (!isRetiredCampaignFile(from)) {
        return { status: 'skipped', reason: 'not-a-retired-file' };
    }

    const sourcePath = path.join(CAMPAIGNS_DIR, `${campaignId}${from}`);
    // The common case by a wide margin — a campaign created after the
    // extraction, or one whose adoption has already run and been cleaned up by
    // a later release. One `existsSync` and out, on every mod-table read.
    if (!fs.existsSync(sourcePath)) {
        return { status: 'skipped', reason: 'no-legacy-file' };
    }

    const ledger = readMigrationLedger(campaignId);
    if (ledger.adopted[descriptor.name]) {
        return { status: 'skipped', reason: 'already-adopted' };
    }

    const targetPath = path.join(CAMPAIGNS_DIR, `${campaignId}${descriptor.fileSuffix}`);

    try {
        // The mod already has data in this table. Do not touch it — the mod's
        // own file is authoritative over a legacy file it has already
        // superseded. Record the pass anyway (`sealed`), so this campaign is
        // past the adoption point: without it, a later **Delete data** would
        // remove the mod's table and the next open would resurrect the legacy
        // records the user had just erased.
        //
        // "Has data" means has RECORDS, not has a file. An empty table file
        // arrives from paths that never held anything — an import bundle, a
        // mod that wrote its defaults before the first read — and treating it
        // as authoritative would seal a campaign's real compendium out of its
        // own mod forever. This cannot discard a user's deliberate emptying of
        // a table, because reaching here at all means the ledger has no entry
        // and adoption has therefore never run for this campaign.
        if (fs.existsSync(targetPath) && !isEmptyTable(readJson(targetPath, UNREADABLE))) {
            ledger.adopted[descriptor.name] = { from, at: Date.now(), sealed: true };
            delete ledger.failures[descriptor.name];
            writeLedger(campaignId, ledger);
            return { status: 'sealed' };
        }

        // A unique sentinel, not `undefined` or `null`: `readJson`'s fallback
        // parameter DEFAULTS to `null` when passed `undefined`, and `null` is
        // also what a legitimate empty single-object file parses to. Only an
        // object identity nothing else can produce distinguishes "unreadable"
        // from "read, and the answer was null".
        const data = readJson(sourcePath, UNREADABLE);
        if (data === UNREADABLE) {
            // `readJson` swallows a parse error and returns the fallback, so
            // this is "the file is there but it is not JSON". Nothing is
            // written; the legacy file is left for a human to look at.
            return recordFailure(campaignId, ledger, descriptor, from, 'legacy file is not readable JSON');
        }

        writeJson(targetPath, data);
        const records = Array.isArray(data) ? data.length : null;
        ledger.adopted[descriptor.name] = { from, at: Date.now(), records };
        delete ledger.failures[descriptor.name];
        writeLedger(campaignId, ledger);
        console.log(
            `[migration] campaign ${campaignId}: adopted ${from} → ${descriptor.name}` +
            (records === null ? '' : ` (${records} record${records === 1 ? '' : 's'})`),
        );
        return { status: 'adopted', records };
    } catch (err) {
        return recordFailure(campaignId, ledger, descriptor, from, err?.message || String(err));
    }
}

function recordFailure(campaignId, ledger, descriptor, from, reason) {
    console.error(`[migration] campaign ${campaignId}: ${from} → ${descriptor.name} FAILED — ${reason}`);
    try {
        ledger.failures[descriptor.name] = { from, at: Date.now(), error: reason };
        writeLedger(campaignId, ledger);
    } catch (err) {
        // The ledger write is the diagnostic, not the guarantee. If even that
        // fails the campaign still opens with its legacy file intact, which is
        // the only promise this module makes.
        console.error(`[migration] campaign ${campaignId}: could not record the failure — ${err.message}`);
    }
    return { status: 'failed', reason };
}
