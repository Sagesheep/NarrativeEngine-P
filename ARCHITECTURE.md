# GM Cockpit — Architecture Map

Single-file reference for AI agents. Covers directory layout, server routes, frontend-backend contract, state management, and data flow.

---

## Directory Layout

```
mainApp/
├── server.js                  # Express entry point (port 3001)
├── server/
│   ├── vault.js               # KeyVault class (AES-256-GCM encryption)
│   ├── routes/
│   │   ├── vault.js           # /api/vault/* — vault CRUD & lock/unlock
│   │   ├── settings.js        # /api/settings — app-wide settings (in vault)
│   │   ├── campaigns.js       # /api/campaigns/:id — campaign CRUD + lore/NPCs
│   │   ├── archive.js         # /api/campaigns/:id/archive — scene storage + NLP + embedding
│   │   ├── chapters.js        # /api/campaigns/:id/archive/chapters — chapter seal/merge/split
│   │   ├── timeline.js        # /api/campaigns/:id/timeline — timeline events
│   │   ├── facts.js           # /api/campaigns/:id/facts + /entities — semantic facts & entity merge
│   │   ├── backups.js         # /api/campaigns/:id/backup(s) — create/restore/delete
│   │   └── assets.js          # /api/assets/download — download portrait images
│   ├── lib/
│   │   ├── fileStore.js       # DATA_DIR paths, readJson/writeJson, path helpers
│   │   ├── embedder.js        # @huggingface/transformers embedding (warmup, embedText, embedBatch)
│   │   ├── vectorStore.js     # better-sqlite3 + sqlite-vec for vector search
│   │   ├── nlp.js             # Keyword extraction, NPC name detection, importance estimation
│   │   └── entityResolution.js # Levenshtein + name normalization for entity matching
│   └── services/
│       ├── llmProxy.js        # Server-side LLM calls (witness extraction, timeline events)
│       └── backup.js          # Campaign snapshot zip/tar creation + hash verification
├── src/
│   ├── main.tsx               # React entry → renders App
│   ├── App.tsx                # Root layout: CampaignHub | ChatArea + Header + ContextDrawer + modals
│   ├── lib/apiBase.ts         # API_BASE ('/api' dev, 'http://localhost:3001/api' prod)
│   ├── types/index.ts         # All shared TypeScript types
│   ├── store/
│   │   ├── useAppStore.ts     # Zustand store: combines all 4 slices
│   │   ├── campaignStore.ts   # Campaign CRUD API functions (not a store, just fetch wrappers)
│   │   └── slices/
│   │       ├── settingsSlice.ts  # Presets, vault state, endpoint accessors
│   │       ├── campaignSlice.ts  # Active campaign data, context, lore, NPCs, archive
│   │       ├── chatSlice.ts      # Messages, streaming state, condenser state
│   │       └── uiSlice.ts        # Modal/panel open/close toggles
│   ├── services/
│   │   ├── apiClient.ts       # Frontend HTTP client for all server routes
│   │   ├── turnOrchestrator.ts # Main game loop: gather context → build payload → call LLM → post-process
│   │   ├── chatEngine.ts      # Barrel: payloadBuilder + llmService + npcGeneration + tagGeneration
│   │   ├── llmService.ts      # sendMessage() → llmRequestQueue → fetch to user's configured endpoint
│   │   ├── llmRequestQueue.ts # Priority queue (critical/normal/background) with concurrency control
│   │   ├── callLLM.ts         # Thin wrapper around llmQueue for utility LLM calls
│   │   ├── payloadBuilder.ts  # Builds the full system+user payload from context, lore, history
│   │   ├── contextGatherer.ts # Selects relevant archive scenes, lore chunks, NPC data for context
│   │   ├── contextRecommender.ts # LLM-based context selection
│   │   ├── postTurnPipeline.ts # After LLM response: rate importance, save to archive, detect NPCs
│   │   ├── aiPlayerEngine.ts  # AI player character interventions between user turns
│   │   ├── toolHandlers.ts    # LLM tool calls: lore search, notebook edits
│   │   ├── archiveManager.ts  # Frontend archive operations (rollback, open, clear)
│   │   ├── condenser.ts       # Auto-summarize old chat history to reduce tokens
│   │   ├── campaignInit.ts    # New campaign initialization: chunk lore, seed engines, parse NPCs
│   │   ├── saveFileEngine.ts  # Chapter summary generation via LLM
│   │   ├── importanceRater.ts # LLM-based scene importance scoring
│   │   ├── npcDetector.ts     # Extract & classify NPC names from AI responses
│   │   ├── npcGeneration.ts   # Generate NPC profiles/portraits via LLM
│   │   ├── tagGeneration.ts   # Auto-populate engine tags via LLM
│   │   ├── loreChunker.ts     # Split lore files into chunks for embedding
│   │   ├── loreRetriever.ts   # Semantic lore search (client-side matching)
│   │   ├── loreNPCParser.ts   # Parse NPC definitions from lore text
│   │   ├── loreEngineSeeder.ts # Extract engine seed data from lore
│   │   ├── archiveMemory.ts   # Recall archive scenes by keyword/semantic search
│   │   ├── archiveChapterEngine.ts # Chapter-based archive recall with ranking
│   │   ├── engineRolls.ts     # Dice rolling, fairness checks
│   │   ├── tokenizer.ts       # Token counting via js-tiktoken
│   │   ├── contextMinifier.ts # Minify lore/NPC text for payload compression
│   │   ├── timelineResolver.ts # Resolve timeline contradictions/supersessions
│   │   ├── assetService.ts    # Download images to local assets dir
│   │   ├── backgroundQueue.ts # Queue for non-critical background tasks
│   │   ├── settingsCrypto.ts  # Encrypt/decrypt settings presets via vault
│   │   └── lib/payloadSanitizer.ts # Clean/sanitize LLM payloads before API calls
│   └── components/
│       ├── CampaignHub.tsx     # Landing page: campaign list + create/import
│       ├── ChatArea.tsx        # Main play view: messages, input, condenser, chapter sealing
│       ├── Header.tsx          # Top bar: campaign name, backup, settings, token gauge
│       ├── ContextDrawer.tsx   # Side panel: rules, lore, engines, save file, bookkeeping, chapters
│       ├── SettingsModal.tsx   # Preset management, endpoint config, vault keys
│       ├── BackupModal.tsx     # Create/restore/delete campaign backups
│       ├── NPCLedgerModal.tsx  # NPC list/gallery view + edit + portrait generation
│       ├── VaultUnlockModal.tsx # Password prompt for encrypted vault
│       ├── TokenGauge.tsx      # Token usage progress bar
│       ├── MessageBubble.tsx   # Single chat message renderer
│       ├── CondensedPanel.tsx  # Shows condensed summary block
│       ├── Toast.tsx           # Global toast notification system
│       ├── ErrorBoundary.tsx   # React error boundary wrapper
│       ├── PayloadTraceView.tsx # Debug view for last LLM payload
│       ├── SceneNoteEditor.tsx # Inline scene note editor in context drawer
│       ├── CampaignFormModal.tsx # New campaign creation form
│       ├── CoverflowCarousel.tsx # Campaign cover image carousel
│       ├── hooks/
│       │   ├── useCampaignForm.ts  # Campaign creation/initialization logic
│       │   ├── useMessageEditor.ts # Message edit/delete/undo operations
│       │   ├── useChapterSealing.ts # Chapter seal/auto-seal logic
│       │   └── useCondenser.ts     # Auto-condense trigger + manual condense
│       ├── context-drawer/
│       │   ├── RulesTab.tsx        # System prompt + engine rules editor
│       │   ├── LoreTab.tsx         # Lore chunk list + editor
│       │   ├── EnginesTab.tsx      # Engine toggle + tag generation
│       │   ├── SaveFileTab.tsx     # Canon state + header index + template fields
│       │   ├── BookkeepingTab.tsx  # Character profile + inventory scanning
│       │   ├── ChapterTab.tsx      # Chapter list + pinning + resolved state
│       │   └── ...                 # TokenCounter, Toggle, TemplateField, TimelineDotRow, etc.
│       └── npc-ledger/
│           ├── NPCListView.tsx     # Table view of NPCs
│           ├── NPCGalleryView.tsx  # Card gallery view
│           ├── NPCEditForm.tsx     # Edit NPC details
│           └── NPCPortraitSection.tsx # Portrait display + regenerate
└── electron/
    └── main.cjs              # Electron wrapper: spawns server.js, loads index.html
```

---

## Server Initialization Order (`server.js`)

```
1. new KeyVault(DATA_DIR)       — init crypto vault
2. ensureDirs()                 — create data/ subdirectories
3. vault.create() / .unlock()   — auto-init or unlock vault
4. app.use(cors(), json())      — middleware
5. express.static(assets)       — portrait serving
6. initDb()                     — SQLite + sqlite-vec for vector search
7. warmupEmbedder()             — pre-load embedding model
8. app.use(router...) × 9       — mount all route modules
9. app.listen(3001)             — start Express
```

---

## API Route Table

| Method | Path | Route File | Key Operations |
|--------|------|------------|----------------|
| **Vault** |||
| GET | `/api/vault/status` | vault.js | exists/unlocked/hasRemember |
| POST | `/api/vault/setup` | vault.js | create with password or machine key |
| POST | `/api/vault/unlock` | vault.js | unlock with password |
| POST | `/api/vault/lock` | vault.js | lock vault |
| GET/PUT | `/api/vault/keys` | vault.js | read/write API key presets |
| POST | `/api/vault/export` | vault.js | encrypted export |
| POST | `/api/vault/import` | vault.js | encrypted import |
| DELETE | `/api/vault` | vault.js | delete vault |
| **Settings** |||
| GET | `/api/settings` | settings.js | load from vault |
| PUT | `/api/settings` | settings.js | save to vault |
| **Campaigns** |||
| GET | `/api/campaigns` | campaigns.js | list all campaign IDs |
| GET/PUT/DELETE | `/api/campaigns/:id` | campaigns.js | campaign CRUD |
| GET/PUT | `/api/campaigns/:id/state` | campaigns.js | game state (context, messages) |
| GET/PUT | `/api/campaigns/:id/lore` | campaigns.js | lore chunks |
| GET/PUT | `/api/campaigns/:id/npcs` | campaigns.js | NPC ledger |
| **Archive** |||
| POST | `/api/campaigns/:id/archive` | archive.js | append scene (triggers NLP + embedding) |
| GET | `/api/campaigns/:id/archive/index` | archive.js | scene metadata index |
| GET | `/api/campaigns/:id/archive/scenes` | archive.js | fetch scenes by ID list |
| DELETE | `/api/campaigns/:id/archive/scenes-from/:id` | archive.js | delete from scene onward |
| GET | `/api/campaigns/:id/archive/open` | archive.js | open in file explorer |
| POST | `/api/campaigns/:id/archive/semantic-candidates` | archive.js | vector search for relevant scenes |
| **Chapters** |||
| GET | `/api/campaigns/:id/archive/chapters` | chapters.js | list chapters |
| POST | `/api/campaigns/:id/archive/chapters` | chapters.js | create chapter |
| POST | `/api/campaigns/:id/archive/chapters/seal` | chapters.js | seal current + create new |
| POST | `/api/campaigns/:id/archive/chapters/merge` | chapters.js | merge two chapters |
| POST | `/api/campaigns/:id/archive/chapters/:cid/split` | chapters.js | split at scene |
| **Timeline** |||
| GET/POST | `/api/campaigns/:id/timeline` | timeline.js | list/add events |
| DELETE | `/api/campaigns/:id/timeline/:eid` | timeline.js | remove event |
| **Facts & Entities** |||
| GET/PUT | `/api/campaigns/:id/facts` | facts.js | semantic facts |
| GET | `/api/campaigns/:id/entities` | facts.js | entity list |
| POST | `/api/campaigns/:id/entities/merge` | facts.js | merge entities |
| **Backups** |||
| POST | `/api/campaigns/:id/backup` | backups.js | create backup |
| GET | `/api/campaigns/:id/backups` | backups.js | list backups |
| POST | `/api/campaigns/:id/backups/:ts/restore` | backups.js | restore from timestamp |
| DELETE | `/api/campaigns/:id/backups/:ts` | backups.js | delete backup |
| **Assets** |||
| POST | `/api/assets/download` | assets.js | download image to local assets |

---

## Frontend → Backend Contract

`src/services/apiClient.ts` calls → `src/lib/apiBase.ts` (`API_BASE`) → Vite proxy (`/api` → `localhost:3001`)

| apiClient namespace | HTTP calls | Server route file |
|--------------------|------------|-------------------|
| `api.archive.*` | POST/GET/DELETE `/campaigns/:id/archive/...` | archive.js |
| `api.chapters.*` | GET/POST/PATCH `/campaigns/:id/archive/chapters/...` | chapters.js |
| `api.facts.*` | GET `/campaigns/:id/facts` | facts.js |
| `api.timeline.*` | GET/POST/DELETE `/campaigns/:id/timeline/...` | timeline.js |
| `api.entities.*` | GET/POST `/campaigns/:id/entities/...` | facts.js |
| `api.settings.*` | GET/PUT `/settings` | settings.js |
| `api.backups.*` | POST/GET/DELETE `/campaigns/:id/backup(s)/...` | backups.js |
| `api.vault.*` | GET/POST/PUT/DELETE `/vault/...` | vault.js |

`src/store/campaignStore.ts` calls → same `API_BASE` for campaign CRUD, lore, NPCs, state save/load.

---

## State Management (Zustand)

```
useAppStore = settingsSlice + campaignSlice + chatSlice + uiSlice
```

| Slice | Key State | Actions |
|-------|-----------|---------|
| **settingsSlice** | `settings` (presets, activePresetId, contextLimit), `vaultStatus` | Vault CRUD, preset management, endpoint getters |
| **campaignSlice** | `activeCampaignId`, `loreChunks`, `archiveIndex`, `chapters`, `npcLedger`, `semanticFacts`, `timeline`, `entities`, `context` (GameContext) | Load/save campaign, manage lore/NPCs/chapters |
| **chatSlice** | `messages`, `isStreaming`, `condenser` | Add/update/delete messages, condenser control |
| **uiSlice** | `settingsOpen`, `drawerOpen`, `npcLedgerOpen`, `backupModalOpen`, `lastPayloadTrace` | Toggle modals/panels |

**Cross-slice dependencies:**
- `campaignSlice` reads `settings.activePresetId`
- `chatSlice` reads `campaignSlice.activeCampaignId`, `campaignSlice.archiveIndex`
- `settingsSlice` calls `api.vault.*`, `api.settings.*`

---

## Data Flow: Single User Turn

```
1. User types message → ChatArea.tsx
2. turnOrchestrator.runTurn() called
3.   contextGatherer.gatherContext()
      → archiveMemory: recall relevant past scenes
      → archiveChapterEngine: rank chapters for relevance
      → contextRecommender: LLM picks best context
4.   payloadBuilder.buildPayload()
      → assembles system prompt (rules + lore + canon + engines)
      → appends chat history (or condensed summary)
      → attaches user message
5.   llmService.sendMessage()
      → llmRequestQueue (priority queue)
      → fetch() to user's configured LLM endpoint
6.   aiPlayerEngine.handleInterventions() (if AI player enabled)
7.   Stream response back → chatSlice.updateLastAssistant()
8.   postTurnPipeline.runPostTurnPipeline():
      → importanceRater: score scene importance
      → api.archive.append(): save scene to server
        → server archive.js: NLP extraction + embedding + vector store
      → npcDetector: extract new NPCs from response
      → characterProfileParser / inventoryParser: scan for changes
      → backgroundQueue: enqueue non-critical follow-ups
9.   useCondenser hook: check if condensation needed
10.  useChapterSealing hook: check if auto-seal threshold met
```

---

## Server-Side Archive Pipeline (per scene append)

```
POST /api/campaigns/:id/archive
  → nlp.extractIndexKeywords()     — keyword extraction
  → nlp.extractNPCNames()          — NPC name detection
  → nlp.estimateImportance()       — heuristic importance
  → nlp.extractTimelineEventsRegex() — regex timeline extraction
  → llmProxy.extractWitnessLLM()   — LLM-based witness extraction (if configured)
  → llmProxy.extractTimelineEventsLLM() — LLM timeline events
  → entityResolution.normalizeEntityName() — normalize entity names
  → embedder.embedText()           — generate embedding vector
  → vectorStore.storeArchiveEmbedding() — store in SQLite + sqlite-vec
  → writeJson() to disk            — persist scene data
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TypeScript + Vite |
| State | Zustand (4 slices) |
| Styling | Tailwind CSS |
| Backend | Express.js (ESM) |
| Database | JSON files on disk |
| Vector search | better-sqlite3 + sqlite-vec |
| Embedding | @huggingface/transformers (local model) |
| Token counting | js-tiktoken |
| Encryption | Node.js crypto (AES-256-GCM) for vault |
| Desktop | Electron (wraps Express + serves React) |
| Testing | Vitest + React Testing Library + Supertest |

---

## Key Files for Quick Reference

| Need to understand... | Read this file |
|----------------------|----------------|
| "How does a turn work?" | `src/services/turnOrchestrator.ts` |
| "How is context built?" | `src/services/contextGatherer.ts` + `payloadBuilder.ts` |
| "How are scenes archived?" | `server/routes/archive.js` |
| "How does vector search work?" | `server/lib/vectorStore.js` + `embedder.js` |
| "What data does the store hold?" | `src/store/slices/` (all 4) |
| "How are NPCs managed?" | `src/services/npcDetector.ts` + `npcGeneration.ts` |
| "How does the vault work?" | `server/vault.js` (crypto) + `server/routes/vault.js` (API) |
| "What API endpoints exist?" | `server/routes/*.js` (see table above) |
| "How does condensation work?" | `src/services/condenser.ts` + `auto-condenser.md` |
