// Server-side table registry — Project 5 / WO-P5-03 Step 2.
//
// Structural twin of the TS descriptor + registry in
// packages/engine/src/tables/tableDescriptor.ts. The server is plain Node
// ESM JS and cannot import the engine dist (extensionless ESM); it holds its
// own registry instance here. The shapes match by convention, the same way
// src/types and packages/engine/src/*/types.ts are structural twins
// (AI_CODEBASE_MAP §8).
//
// This module builds the machinery and converts nothing. With no descriptors
// registered, every helper degrades to today's behaviour:
//   - getCampaignFileSuffixes() returns the built-in 18.
//   - mountGenericTableRoutes() mounts zero routes.
//   - isCampaignMetaFile() falls back to the built-in suffix set.
//
// WO-P5-03 §1: only 5 of 18 tables have all nine touchpoints, so every
// touchpoint here is optional. WO-P5-03 §3: five escape-hatch hook kinds max.
//
// The registry NEVER branches on descriptor.name. The opaque-id test
// (src/services/tables/__tests__/tableDescriptor.test.ts) is the contract.

import { Router } from 'express';
import {
    CAMPAIGNS_DIR,
    BUILTIN_CAMPAIGN_FILE_SUFFIXES,
    readJson, writeJson, ensureDirs, validateCampaignId,
} from './fileStore.js';
import { wrapAsync } from './asyncHandler.js';
import path from 'path';
import fs from 'fs';

const isPresent = (t) => Boolean(t && t.present === true);

// Re-export the built-in suffix list so callers have one import source. The
// constant itself lives in fileStore.js (WO-P5-03 Step 2.1 source-of-truth
// fallback); tableRegistry.js imports it and re-exports here.
export { BUILTIN_CAMPAIGN_FILE_SUFFIXES } from './fileStore.js';

/**
 * The five escape-hatch hook kinds (WO-P5-03 §3). The registry stores hook
 * references but never invokes them — the route mounter / accessor factory
 * in the app layer does. Capped at five: a sixth means the descriptor design
 * is wrong.
 */
export const HOOK_KINDS = Object.freeze([
    'onBeforeWrite', 'onAfterWrite', 'onAfterRead', 'onRemove', 'writeLock',
]);

/**
 * A server-side descriptor. Every field except name/fileSuffix/recordShape is
 * optional. Structural twin of the TS TableDescriptor.
 *
 *   hooks: optional map of { onBeforeWrite, onAfterWrite, onAfterRead,
 *   onRemove, writeLock } — see HOOK_KINDS.
 *   serverRoutes: { present: true, value: { get: true, put: true } } to opt
 *   into the generic GET/PUT pair.
 *   transfer: { present: true, value: { bundleKey: string } } to opt into
 *   export/import.
 */
export function createDescriptor(descriptor) {
    if (!descriptor || typeof descriptor.name !== 'string' || !descriptor.name) {
        throw new Error('[tables] descriptor requires a name');
    }
    if (typeof descriptor.fileSuffix !== 'string' || !descriptor.fileSuffix) {
        throw new Error(`[tables] descriptor ${descriptor.name} requires a fileSuffix`);
    }
    if (descriptor.recordShape !== 'array' && descriptor.recordShape !== 'single-object') {
        throw new Error(`[tables] descriptor ${descriptor.name} recordShape must be 'array' | 'single-object'`);
    }
    if (descriptor.hooks) {
        for (const kind of Object.keys(descriptor.hooks)) {
            if (!HOOK_KINDS.includes(kind)) {
                throw new Error(`[tables] descriptor ${descriptor.name} declares unknown hook kind '${kind}'. Allowed: ${HOOK_KINDS.join(', ')}`);
            }
        }
    }
    return { ...descriptor };
}

export function createTableRegistry() {
    const byName = new Map();
    const order = [];

    return {
        register(descriptor) {
            const d = createDescriptor(descriptor);
            if (byName.has(d.name)) {
                throw new Error(`[tables] duplicate descriptor: ${d.name}`);
            }
            byName.set(d.name, d);
            order.push(d.name);
        },
        unregister(name) {
            const removed = byName.delete(name);
            if (removed) {
                const idx = order.indexOf(name);
                if (idx >= 0) order.splice(idx, 1);
            }
            return removed;
        },
        list() {
            return order.map((n) => byName.get(n));
        },
        get(name) {
            return byName.get(name);
        },
        clear() {
            byName.clear();
            order.length = 0;
        },
        suffixes() {
            return order.map((n) => byName.get(n).fileSuffix);
        },
        transferable() {
            return order.map((n) => byName.get(n)).filter((d) => isPresent(d.transfer));
        },
        withGenericRoutes() {
            return order.map((n) => byName.get(n)).filter((d) => isPresent(d.serverRoutes));
        },
    };
}

/**
 * The single shared registry instance for the server. WO-P5-03 registers
 * nothing here; WO-P5-04 will. Empty → every derived helper degrades to the
 * built-in default (default-as-plugin).
 */
export const serverTableRegistry = createTableRegistry();

/**
 * Derive the campaign file suffix set from the registry, falling back to the
 * built-in 18 when the registry is empty (default-as-plugin).
 *
 * WO-P5-03 §5 Step 2.1: the derived set must be set-equal to today's 18 when
 * nothing is registered. That is the gate test.
 *
 * The fallback is the FULL built-in list, not a delta — a registered
 * descriptor's suffix REPLACES its entry in the fallback (by suffix string),
 * so converting a table never produces a duplicate. Suffixes that are not the
 * built-in 18 are appended in registration order.
 */
export function getCampaignFileSuffixes(registry = serverTableRegistry) {
    const registered = registry.suffixes();
    if (registered.length === 0) {
        return [...BUILTIN_CAMPAIGN_FILE_SUFFIXES];
    }
    const out = [];
    const seen = new Set();
    // Registered suffixes first, in registration order.
    for (const s of registered) {
        if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
    // Then any built-in suffixes not already covered (preserves the full set
    // when only some tables are converted — WO-P5-04 converts one at a time).
    for (const s of BUILTIN_CAMPAIGN_FILE_SUFFIXES) {
        if (!seen.has(s)) { seen.add(s); out.push(s); }
    }
    return out;
}

/**
 * The derived positive test (WO-P5-03 §4): a campaign METADATA file is a `.json`
 * whose name has no registered campaign-file suffix.
 *
 * Replaces the two drifted negative filters in campaigns.js:20-33 and
 * transfer.js:150, which independently maintained hand-written exclusion lists
 * that had already drifted (§4). A derived positive test cannot drift: a new
 * suffix is either registered (and excluded here) or it is not.
 *
 * "No registered suffix" means: the filename does not end with any suffix in
 * the derived set OTHER than `.json` itself. A bare `{id}.json` ends with
 * `.json` and with no other suffix, so it is a metadata file. A
 * `{id}.state.json` ends with `.state.json`, so it is not.
 *
 * The `data.id && data.name` check stays in the caller — it is load-bearing and
 * belt-and-braces is correct (§4).
 */
export function isCampaignMetaFile(filename, registry = serverTableRegistry) {
    if (!filename || !filename.endsWith('.json')) return false;
    const suffixes = getCampaignFileSuffixes(registry);
    for (const suffix of suffixes) {
        if (suffix === '.json') continue;
        if (filename.endsWith(suffix)) return false;
    }
    return true;
}

/**
 * Mount the generic GET/PUT route pair for every descriptor that declares
 * `serverRoutes`. WO-P5-03 §5 Step 2.2: opt-in, registered only for descriptors
 * that declare it. Mount AFTER all existing routers so it never shadows the
 * seven bespoke route files (§2).
 *
 * With no descriptors registered (today), this mounts nothing.
 *
 * The generic pair reads/writes `{id}{fileSuffix}` in CAMPAIGNS_DIR. For an
 * `array` table the GET default is `[]`; for a `single-object` table it is
 * `null`. PUT writes `req.body` verbatim. The `onBeforeWrite`/`onAfterWrite`
 * hooks fire if declared (§3). This pair does NOT handle `onAfterRead` or
 * `onRemove` — those belong to the client accessor / slice factory (Step 3);
 * the server GET is a plain read.
 */
export function mountGenericTableRoutes(registry = serverTableRegistry) {
    const router = Router();
    for (const descriptor of registry.withGenericRoutes()) {
        const { fileSuffix, recordShape, name } = descriptor;
        const fallback = recordShape === 'array' ? [] : null;

        router.get(`/api/campaigns/:id/${name}`, wrapAsync((req, res) => {
            validateCampaignId(req.params.id);
            const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}${fileSuffix}`);
            res.json(readJson(filePath, fallback));
        }));

        router.put(`/api/campaigns/:id/${name}`, wrapAsync((req, res) => {
            validateCampaignId(req.params.id);
            ensureDirs();
            const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}${fileSuffix}`);
            let body = req.body;
            const onBeforeWrite = descriptor.hooks?.onBeforeWrite;
            if (typeof onBeforeWrite === 'function') {
                body = onBeforeWrite({ campaignId: req.params.id, filePath, body });
            }
            writeJson(filePath, body);
            res.json({ ok: true });
            const onAfterWrite = descriptor.hooks?.onAfterWrite;
            if (typeof onAfterWrite === 'function') {
                onAfterWrite({ campaignId: req.params.id, filePath, body });
            }
        }));
    }
    return router;
}

/**
 * WO-P5-05 Step 3 — the dynamic mod-table route pair.
 *
 * Built-in tables get a per-descriptor route mounted at startup
 * (`mountGenericTableRoutes`). Mod tables are different: they are installed
 * and uninstalled without a server restart, so their routes must be looked
 * up in the registry AT REQUEST TIME, not baked in at mount time.
 *
 * This mounts a single dynamic GET/PUT pair under `/api/campaigns/:id/mod-tables/:table`.
 * The `:table` parameter is the full namespaced name (`mod.<modId>.<name>`).
 * The handler checks the registry and returns 404 BEFORE any path is built if
 * the table is not registered — §2 defence #3: "a request for a table that
 * is not in the registry is a 404 before any path is built. Never interpolate
 * a URL parameter into a filename."
 *
 * The `mod-tables` prefix in the path keeps mod table routes in their own
 * namespace, so they can never shadow a built-in route. A mod table named
 * `mod.compendium.powers` is served at
 * `/api/campaigns/:id/mod-tables/mod.compendium.powers`.
 */
export function mountModTableRoutes(registry = serverTableRegistry) {
    const router = Router();

    router.get('/api/campaigns/:id/mod-tables/:table', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        // Defence #3: look up the registry BEFORE building any path. An
        // unregistered name is a 404 here — no file is touched.
        const descriptor = registry.get(req.params.table);
        if (!descriptor || !descriptor.serverRoutes || descriptor.serverRoutes.present !== true) {
            return res.status(404).json({ error: `Unknown mod table "${req.params.table}"` });
        }
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}${descriptor.fileSuffix}`);
        const fallback = descriptor.recordShape === 'array' ? [] : null;
        res.json(readJson(filePath, fallback));
    }));

    router.put('/api/campaigns/:id/mod-tables/:table', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        const descriptor = registry.get(req.params.table);
        if (!descriptor || !descriptor.serverRoutes || descriptor.serverRoutes.present !== true) {
            return res.status(404).json({ error: `Unknown mod table "${req.params.table}"` });
        }
        ensureDirs();
        const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}${descriptor.fileSuffix}`);
        let body = req.body;
        const onBeforeWrite = descriptor.hooks?.onBeforeWrite;
        if (typeof onBeforeWrite === 'function') {
            body = onBeforeWrite({ campaignId: req.params.id, filePath, body });
        }
        writeJson(filePath, body);
        res.json({ ok: true });
        const onAfterWrite = descriptor.hooks?.onAfterWrite;
        if (typeof onAfterWrite === 'function') {
            onAfterWrite({ campaignId: req.params.id, filePath, body });
        }
    }));

    return router;
}

/**
 * WO-P5-03 §5 Step 2.3: iterate descriptors that declare `transfer` for the
 * export/import bundle. Tables that do not declare `transfer` stay out (§6).
 *
 * Returns the list of { bundleKey, fileSuffix, recordShape } for the bundle
 * assembly. With no descriptors registered, this is empty — the existing
 * hand-written bundle in transfer.js is unchanged.
 */
export function getTransferableTables(registry = serverTableRegistry) {
    return registry.transferable().map((d) => ({
        bundleKey: d.transfer.value.bundleKey,
        fileSuffix: d.fileSuffix,
        recordShape: d.recordShape,
        name: d.name,
    }));
}