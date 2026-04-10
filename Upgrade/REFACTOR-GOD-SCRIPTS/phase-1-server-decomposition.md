# Phase 1: server.js Decomposition

**Status:** Complete
**Prerequisites:** Phase 0 complete
**Estimated Time:** 6-8 hours (1A: 2-3h, 1B: 3-4h, 1C: 1h)
**Risk Level:** Low (clearest boundaries, zero frontend coupling)

---

## Objective

Decompose the 1,819-line monolithic `server.js` into focused modules using Express Router and
extracted service layers. Target: **server.js shrinks to ~50 lines** (app.listen + middleware + route mounting).

---

## Current State Analysis

### Dependency Groups (from analysis)

```
GROUP A: Core I/O & Path Helpers  ← used by everything else (LEAF functions)
  ensureDirs, readJson, writeJson, stripApiKeys
  archivePath, archiveIndexPath, chaptersPath, factsPath, entitiesPath, timelinePath

GROUP B: Backup Subsystem  ← nearly self-contained
  computeCampaignHash, campaignFiles, createBackup, pruneAutoBackups
  Cross-deps: readJson, writeJson (from Group A)

GROUP C: Text Analysis / NLP  ← ALL pure functions, ZERO intra-group calls
  extractIndexKeywords, extractNPCNames, estimateImportance
  extractKeywordStrengths, extractNPCStrengths, extractWitnessesHeuristic
  extractTimelineEventsRegex, extractWitnessesLLM, extractTimelineEventsLLM
  DEAD CODE: extractNPCFacts, extractFactsLLM (delete these)

GROUP D: Entity Resolution  ← self-contained
  levenshtein, normalizeEntityName

GROUP E: Vault Routes  ← COMPLETELY ISOLATED (zero cross-dependencies)
  11 route handlers, only talk to external KeyVault object
```

### The Hub Route: POST /api/campaigns/:id/archive (lines 1053-1200)
This single 147-line handler calls **20 local functions** across Groups A, C, and D.
It is the most interconnected unit and will be the hardest extraction — but it is entirely
within the archive routes, so it gets extracted as a block.

---

## Phase 1A: Characterization Tests

Write tests for server.js **before extracting anything**. These tests will:
1. Validate current behavior (catch regressions during extraction)
2. Remain valid after extraction (they test the API surface, not the file structure)

### 1A.1 — Pure NLP function tests

**New file:** `server/__tests__/nlp.test.js`

**Test these functions by importing directly from server.js:**

| Function | Input | Expected Behavior |
|----------|-------|-------------------|
| `extractIndexKeywords(text)` | Rich scene text | Returns array of unique lowercase keywords, filters stopwords |
| `extractIndexKeywords(text)` | Empty string | Returns empty array |
| `extractNPCNames(text)` | Text with capitalized names | Returns array of unique NPC names |
| `extractNPCNames(text)` | Text without names | Returns empty array |
| `estimateImportance(text)` | Various scene texts | Returns numeric importance score |
| `extractKeywordStrengths(text, keywords)` | Text + keyword list | Returns keyword→strength mapping |
| `extractNPCStrengths(text, npcNames)` | Text + NPC name list | Returns name→strength mapping |
| `extractWitnessesHeuristic(npcNames, userContent, assistantContent)` | Scene content | Returns witness list based on name occurrence |
| `extractTimelineEventsRegex(npcNames, text, sceneId, chapterId)` | Scene with events | Returns parsed timeline events |

**Note:** These are pure functions — no mocking needed.

**Target:** ~20-25 test cases

---

### 1A.2 — Entity resolution tests

**New file:** `server/__tests__/entityResolution.test.js`

| Function | Input | Expected Behavior |
|----------|-------|-------------------|
| `levenshtein(a, b)` | Various string pairs | Returns correct edit distance |
| `levenshtein('', 'abc')` | Empty string | Returns 3 |
| `levenshtein('same', 'same')` | Identical strings | Returns 0 |
| `normalizeEntityName(name, knownEntities)` | Name close to known entity | Returns the known entity name |
| `normalizeEntityName(name, [])` | No known entities | Returns the original name (lowercased) |

**Target:** ~8-10 test cases

---

### 1A.3 — Vault route integration tests

**New file:** `server/__tests__/vault.test.js`

Uses `supertest` to hit the Express app via HTTP.

| Test | Method | Endpoint | Validates |
|------|--------|----------|-----------|
| Vault lifecycle | POST | `/api/vault/setup` | Creates encrypted vault |
| | POST | `/api/vault/unlock` | Unlocks with password |
| | GET | `/api/vault/keys` | Returns stored keys |
| | PUT | `/api/vault/keys` | Saves keys |
| | POST | `/api/vault/lock` | Locks vault |
| | POST | `/api/vault/export` | Exports encrypted blob |
| | DELETE | `/api/vault` | Deletes vault |

**Setup:** Create a test Express app that imports server.js (or better: extract `createApp()` so tests can create isolated instances).

**Target:** ~10-12 test cases

---

### 1A.4 — Backup subsystem integration tests

**New file:** `server/__tests__/backup.test.js`

| Test | Validates |
|------|-----------|
| POST `/api/campaigns/:id/backup` | Creates backup with correct metadata |
| GET `/api/campaigns/:id/backups` | Lists backups |
| POST `/api/campaigns/:id/backups/:ts/restore` | Restores from backup |
| DELETE `/api/campaigns/:id/backups/:ts` | Deletes backup |
| Dedup check | Same data doesn't create duplicate backup |
| Auto-prune | Old auto-backups get cleaned up |

**Target:** ~8-10 test cases

---

## Phase 1B: Module Extraction

**Extraction order is critical** — each step depends only on previously extracted modules.

### 1B.1 — Extract `server/lib/fileStore.js`

**Contains:**
- `ensureDirs()`
- `readJson(filePath, fallback)`
- `writeJson(filePath, data)`
- `archivePath(id)`, `archiveIndexPath(id)`, `chaptersPath(id)`
- `factsPath(id)`, `entitiesPath(id)`, `timelinePath(id)`

**Depends on:** `fs`, `path` (stdlib only)
**Depended on by:** Nearly everything else

**In server.js:** Replace with:
```js
import { readJson, writeJson, ensureDirs, archivePath, archiveIndexPath,
         chaptersPath, factsPath, entitiesPath, timelinePath } from './lib/fileStore.js';
```

**Lines removed from server.js:** ~50

---

### 1B.2 — Extract `server/lib/nlp.js`

**Contains:**
- `extractIndexKeywords(text)`
- `extractNPCNames(text)`
- `estimateImportance(text)`
- `extractKeywordStrengths(text, keywords)`
- `extractNPCStrengths(text, npcNames)`
- `extractWitnessesHeuristic(npcNames, userContent, assistantContent)`
- `extractTimelineEventsRegex(npcNames, text, sceneId, chapterId)`

**DELETE dead code:** `extractNPCFacts` (never called) and `extractFactsLLM` (never called)

**Depends on:** Nothing (all pure functions)
**Depended on by:** Archive POST handler only

**Lines removed from server.js:** ~170

---

### 1B.3 — Extract `server/lib/entityResolution.js`

**Contains:**
- `levenshtein(a, b)`
- `normalizeEntityName(name, knownEntities)`

**Depends on:** Nothing (pure functions)
**Depended on by:** Archive POST handler, entities merge route

**Lines removed from server.js:** ~45

---

### 1B.4 — Extract `server/services/llmProxy.js`

**Contains:**
- `extractWitnessesLLM(npcNames, userContent, assistantContent, utilityConfig)`
- `extractTimelineEventsLLM(entityNames, text, sceneId, chapterId, utilityConfig)`

**Depends on:** Nothing external (uses global `fetch`)
**Depended on by:** Archive POST handler only

**Lines removed from server.js:** ~180

---

### 1B.5 — Extract `server/services/backup.js`

**Contains:**
- `computeCampaignHash(id)`
- `campaignFiles(id)`
- `createBackup(id, opts)`
- `pruneAutoBackups(id, keep)`

**Depends on:** `readJson`, `writeJson` from `./lib/fileStore.js`
**Depended on by:** Backup route handlers

**Lines removed from server.js:** ~95

---

### 1B.6 — Extract `server/routes/vault.js`

**Contains:** All 11 vault route handlers (lines 209-362)

**Implementation:**
```js
import { Router } from 'express';
import { KeyVault } from '../server/vault.js';

export function createVaultRouter(vault) {
  const router = Router();
  // ... 11 routes ...
  return router;
}
```

**Depends on:** `KeyVault` instance (passed in or imported)
**Depended on by:** Nothing (routes are leaf nodes)

**This is the SAFEST extraction** — completely isolated, zero cross-dependencies.

**Lines removed from server.js:** ~158

---

### 1B.7 — Extract `server/routes/settings.js`

**Contains:** 2 settings route handlers

**Lines removed:** ~14

---

### 1B.8 — Extract `server/routes/campaigns.js`

**Contains:** 10 campaign/state/lore/NPC route handlers

**Depends on:** `readJson`, `writeJson`, `ensureDirs` from `./lib/fileStore.js`

**Lines removed:** ~114

---

### 1B.9 — Extract `server/routes/archive.js`

**Contains:** 4 archive route handlers including the big POST handler

**Depends on:** `fileStore`, `nlp`, `entityResolution`, `llmProxy`, `getNextSceneNumber`

**This is the most complex extraction** — the POST handler is 147 lines calling 20 functions.
But those functions are already extracted to their own modules, so the route handler just imports them.

**Lines removed:** ~200

---

### 1B.10 — Extract `server/routes/chapters.js`

**Contains:** 6 chapter route handlers

**Depends on:** `readJson`, `writeJson`, `chaptersPath`, `getNextSceneNumber` from `./lib/fileStore.js`

**Lines removed:** ~191

---

### 1B.11 — Extract `server/routes/timeline.js`

**Contains:** 3 timeline route handlers + facts migration logic

**Depends on:** `readJson`, `writeJson`, `timelinePath`, `factsPath` from `./lib/fileStore.js`

**Lines removed:** ~87

---

### 1B.12 — Extract `server/routes/facts.js`

**Contains:** 4 facts/entities route handlers

**Depends on:** `readJson`, `writeJson`, `entitiesPath`, `factsPath`, `normalizeEntityName`

**Lines removed:** ~54

---

### 1B.13 — Extract `server/routes/backups.js`

**Contains:** 5 backup route handlers

**Depends on:** `createBackup` from `./services/backup.js`, `readJson` from `./lib/fileStore.js`

**Lines removed:** ~100

---

### 1B.14 — Extract `server/routes/assets.js`

**Contains:** 1 asset download proxy route

**Depends on:** `fetch` (global)

**Lines removed:** ~28

---

### Expected Result

```
server.js:  ~1,819 lines → ~50 lines
New files:  14 modules in server/lib/, server/services/, server/routes/
```

**server.js after extraction:**
```js
import express from 'express';
import cors from 'cors';
import { KeyVault } from './server/vault.js';
import { createVaultRouter } from './routes/vault.js';
import { createSettingsRouter } from './routes/settings.js';
import { createCampaignsRouter } from './routes/campaigns.js';
import { createArchiveRouter } from './routes/archive.js';
import { createChaptersRouter } from './routes/chapters.js';
import { createTimelineRouter } from './routes/timeline.js';
import { createFactsRouter } from './routes/facts.js';
import { createBackupsRouter } from './routes/backups.js';
import { createAssetsRouter } from './routes/assets.js';
import { stripApiKeys } from './lib/fileStore.js';

const app = express();
app.use(cors());
app.use(express.json());

const vault = new KeyVault(/* ... */);

app.use('/api/vault', createVaultRouter(vault));
app.use('/api/settings', createSettingsRouter());
app.use('/api/campaigns', createCampaignsRouter());
app.use('/api/campaigns/:id/archive', createArchiveRouter());
app.use('/api/campaigns/:id/archive/chapters', createChaptersRouter());
app.use('/api/campaigns/:id/timeline', createTimelineRouter());
app.use('/api/campaigns/:id', createFactsRouter());
app.use('/api/campaigns/:id/backups', createBackupsRouter());
app.use('/api/assets', createAssetsRouter());

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
```

---

## Phase 1C: DRY the LLM Proxy

After extraction, the two LLM functions in `server/services/llmProxy.js` share ~80% identical code:

### Shared boilerplate (extract into `callLLMWithRetry`):
- AbortController with timeout
- fetch() call construction
- Retry loop (up to N attempts with backoff)
- JSON extraction from response (regex fallback)
- Error logging

### Unique per function:
- `extractWitnessesLLM`: Witness-specific prompt + response parsing
- `extractTimelineEventsLLM`: Timeline-specific prompt + response parsing

**Step:** Extract `callLLMWithRetry(prompt, config, retries)` as a shared utility, then rewrite
each function to call it with their unique prompt/parser.

**Target:** ~180 lines → ~90 lines

---

## Verification Checklist (After Each Step)

- [ ] `npm run test:run` passes
- [ ] `npm run build` succeeds
- [ ] App launches
- [ ] Can create/edit/delete a campaign
- [ ] Can send a chat message (triggers archive POST)
- [ ] Can view archive and chapters
- [ ] Can create/restore backups
- [ ] Vault lock/unlock works
- [ ] Commit: `refactor: extract <module> from server.js (phase 1B, step X.Y)`
