# Narrative Engine (mainApp) — AI System Map & Codebase Guide

> **Comprehensive verified audit** of the Narrative Engine Desktop codebase.
> Every claim below is backed by reading the actual source file. This is the
> authoritative reference for AI agents and human developers touching this repo.
> For exhaustive feature listings see [`FEATURE_INVENTORY.md`](./FEATURE_INVENTORY.md).
> For architectural innovations see [`INNOVATIONS.md`](./INNOVATIONS.md).
> For the full directory layout see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. System Architecture & Tech Stack

Narrative Engine is a self-hosted TTRPG manager designed for lossless session
history recall, semantic memory retrieval, dynamic NPC agency, and engine-driven
anti-sycophancy. It runs as a desktop app (Electron wrapping a Vite React
frontend + Express backend) or as a standalone web app (Vite dev server + Express).
Since v2.0 it is also a **mod platform**: an in-app Extensions system, sandboxed
compute mods, mod-declared tables/panels/screens/tier blocks, and a growing set
of bundled mods (worldmap, enemies, arc) that were previously hard-coded features.

```
   [ CLIENT / FRONTEND ]                            [ SERVER / BACKEND ]
+------------------------------+              +------------------------------+
| React 19 + TypeScript + Vite |              |       Express 5 (ESM)        |
| Zustand (6 slices)           |              |  CORS allowlist (Electron +  |
| Tailwind CSS 4               |              |  Vite + $ALLOWED_ORIGINS),   |
| PixiJS 8 (overworld map)     |              |  127.0.0.1:3001 bind         |
| i18n (en/ko/ru/pl/id)        |              |  Mods platform: loadMods +   |
| Mod sandbox (worker) +       |              |  table/panel/screen registry |
| host facade, event bus,      |              |                              |
| role registry                |              |                              |
+--------------+---------------+              +--------------+---------------+
               |                                            |
     HTTP /api + /assets (Vite proxy in dev,               |
     absolute http://localhost:3001 in Electron)           |
               +-----------------------+--------------------+
                                       |
                +----------------------v----------------------+
                |                server.js (151 lines)          |
                | KeyVault auto-init → ensureDirs → initDb →   |
                | registerLocationTable → warmupEmbedder →    |
                | warmupTts → mount 18 routers + generic +    |
                | mod-table routes → listen 127.0.0.1:3001     |
                +-------+-----------------+-------------------+
                        |                 |
              +---------v------+   +-------v----------+
              | better-sqlite3 |   | File I/O         |
              | + sqlite-vec    |   | data/campaigns/  |
              | (archive_vss,  |   | <id>.archive.md  |
              |  lore_vss,     |   | <id>.archive.    |
              |  rules_vss)    |   |   index.json     |
              | cosine distance|   | <id>.archive.    |
                +---------+------+   |   chapters.json  |
                          |          | <id>.timeline.json
                  +-------v------+    | <id>.entities.json
                  | embedder.js |    | <id>.facts.json
                  | mxbai-embed- |    | <id>.lore.json
                  | large-v1 q8 |    | <id>.npcs.json
                  | 1024 dims   |    | <id>.locations.json
                  | LRU 512     |    | <id>.overworld.json
                  +--------------+    | <id>.divergence.json
                                      | <id>.relationship-memory.*.json
                                      | <id>.migrations.json
                                      | <id>.mod-<modId>-<table>.json
                                      +------------------+
```

| Layer | Technology |
|-------|-----------|
| Frontend | React 19.2 + TypeScript 5.9 (strict) + Vite 8 + Tailwind 4 |
| State | Zustand 5 (6 slices: settings, campaign, chat, ui, map, worldLore) |
| Backend | Express 5 (ESM), Node ≥ 20.19, localhost-only bind (env `HOST` override) |
| Database | JSON files per campaign in `data/campaigns/<id>/` |
| Vector search | better-sqlite3 12 + sqlite-vec 0.1.9 (cosine distance, 3 vec0 tables) |
| Embedding | `@huggingface/transformers` local ONNX `mixedbread-ai/mxbai-embed-large-v1` q8, 1024 dims |
| Token counting | js-tiktoken |
| TTS | `kokoro-js` Kokoro-82M q8 (lazy warmup, SHA-256 WAV cache) |
| Scene images | ComfyUI / OpenAI-compatible / OpenRouter image providers (LLM-composed prompts) |
| Vision | Multimodal image→prose description (`src/services/vision/`) |
| i18n | Dependency-free `src/i18n/` core (en, ko, ru, pl, id + pseudo test locale) |
| LLM streaming | Direct fetch to Ollama / OpenAI / Claude / Gemini via per-endpoint priority queue |
| LLM proxy | Server-side `/llm/proxy` route forwards provider calls to dodge browser CORS |
| Encryption | Node `crypto` AES-256-GCM + PBKDF2-SHA256 600k iterations (password) or 10k (machine key) |
| Desktop | Electron (nodeIntegration:false, contextIsolation:true) |
| Testing | Vitest 4 + React Testing Library + Supertest (336 vitest files, ~4,240 tests) + Playwright e2e (8 specs) |
| Shared core | `@narrative/engine` (file-linked `packages/engine`, platform-pure, no DOM/Node libs) |
| Mods | Folder-based manifests `mods/<mod-id>/manifest.json` + bundled (`public/bundled-mods/`); sandboxed compute, native JS, panels/screens/tables/tier entries |
| E2E | Playwright (headless Chromium against `npm run dev`, specs in `e2e/`) |

---

## 2. Subsystem Feature Map (Logical → Code)

The codebase is organized into ~20 subsystems. Each subsystem has its own
directory under `src/services/` (or `server/`) with co-located or `__tests__/` tests.

| Subsystem | Primary Directory | Key Files | Role |
|---|---|---|---|
| **Turn Orchestration** | `src/services/turn/` (+ `tracks/`) | `turnOrchestrator.ts`, `turnStages.ts` (9 stages), `turnContext.ts`, `pendingCommit.ts`, `contextGatherer.ts`, `contextRecommender.ts`, `postTurnPipeline.ts`, `aiTier.ts`, `toolHandlers.ts`, `toolRegistry.ts`, `contextMinifier.ts`, `sceneContinue.ts`, `sceneStakesTag.ts`, `swipeGeneration.ts`, `tagGeneration.ts`, `gatherProgress.ts`, `directorBrief.ts`, `directorWatchdog.ts`, `hostFacade.ts` + travel suite (`travelState.ts`, `travelPress.ts`, `travelFacts.ts`, `departureComposer.ts`, `mapTravelPreview.ts`) + `absoluteCommand.ts`, `blockEnablement.ts`, `tierBlockRegistry.ts` + `tracks/` (npc/pressure + postCommit + prologue + sequential tracks) | Main game loop, 9 decoupled stages, TurnContext data bus, swipe lifecycle, post-turn tracks, director brief, travel state machine, Absolute Command |
| **NPC Agency** | `src/services/npc/agency/` | `agencyEngine.ts`, `agencyBands.ts`, `agencyPools.ts`, `agencyConstants.ts`, `agencyDice.ts`, `agencyDrift.ts`, `agencyGoals.ts`, `agencyHeartbeat.ts`, `agencyLifecycle.ts`, `agencyProgress.ts`, `agencySelection.ts`, `agencyTimeskip.ts`, `agencyTimeskipRun.ts`, `agencyCollision.ts`, `agencyDigest.ts`, `agencyAudition.ts`, `agencyWantDraw.ts` | Heartbeat-driven off-screen NPC life, goal rolls, hex drift, rung-ladder tier-cross, collision tangling, timeskip |
| **NPC Ledger & Relations** | `src/services/npc/` (+ `npc-generation/`) | `npcDetector.ts`, `npcBehaviorDirective.ts`, `npcPressureTracker.ts`, `reactionMenu.ts`, `reactionRepression.ts`, `relationMeter.ts`, `hexRoll.ts`, `manualAdd.ts`, `npcManualResolve.ts`, `npcReview.ts`, `portraitPrompt.ts`, `signatureKit.ts`, `troublemaker.ts`, `dispositionGroups.ts`, `hexVoiceGuide.ts`, `affinityAccess.ts`, `relationResolve.ts`, `relationDedupe.ts`, `relationshipMemoryCompaction.ts`, `relationshipMemoryReading.ts`, `relationshipStance.ts`, `characterExport.ts`, `importTransform.ts` + `npc-generation/` | Name detection (multi-pass + fail-closed validator), hex roll, reaction menu, repression, relation meter, relationship memory (WO-1/3.5/4/5), cross-campaign import |
| **Prompt Assembly** | `src/services/payload/` (+ `contributions/`) | `payloadBuilder.ts`, `stable.ts`, `volatile.ts`, `volatileSegments.ts`, `world.ts`, `history.ts`, `budgets.ts`, `budgetClaims.ts`, `lodRenderer.ts`, `pinnedMemories.ts`, `traceCollector.ts` + `contributions/{registry,assemble,builtins,extensions,types}.ts` | 5-block payload assembly, budget-claim registry, LOD chapter rendering, contribution registry for final user message |
| **Archive Memory** | `src/services/archive-memory/` | `recall.ts`, `idf.ts`, `scoring.ts`, `dynamicMax.ts`, `dynamicElevation.ts`, `slottedRag.ts`, `condenser.ts`, `deepArchiveSearch.ts`, `archiveChapterEngine.ts`, `archiveManager.ts`, `archivePlanner.ts`, `backfillRunner.ts`, `importanceRater.ts`, `sceneEventExtractor.ts`, `witnessCapture.ts`, `relationshipMemory.ts`, `synopsisBackfill.ts` | RRF hybrid retrieval, IDF, dynamic ceiling, dynamic elevation (WO-11), slotted RAG (WO-12), deep search, chapter funnel, witness capture, relationship memory |
| **Rules RAG** | `src/services/rules/` | `defaultRules.ts`, `rulesIndexer.ts`, `rulesRetriever.ts` | System rules text, RAG rules chunking + IDF+RRF retrieval |
| **Lore RAG** | `src/services/lore/` | `loreChunker.ts`, `loreRetriever.ts`, `loreNPCParser.ts`, `loreLocationParser.ts`, `loreEngineSeeder.ts`, `loreCheck.ts`, `loreKeywordEnricher.ts`, `lootTreeLoader.ts`, `worldLoreAI.ts`, `worldLoreExport.ts`, `worldLoreImport.ts` | Lore chunking with RAG hints, IDF+RRF retrieval, lore-consistency verifier, world-builder AI |
| **Campaign State** | `src/services/campaign-state/` | `divergenceRegister.ts`, `knowledgeScope.ts`, `timelineResolver.ts`, `factClusterer.ts`, `factDeduper.ts` | Divergence register, scoped knowledge tokens, timeline supersession, fact clustering + dedup |
| **LLM Interface** | `src/services/llm/` | `llmService.ts`, `llmRequestQueue.ts`, `apiClient.ts`, `llmFetch.ts`, `cacheTelemetry.ts`, `timeouts.ts`, `utilityCallTracker.ts` + `utils/llmCall.ts`, `utils/llmApiHelper.ts` | Streaming chat, per-endpoint adaptive concurrency queue, utility call tracker, cache telemetry |
| **Engines** | `src/services/engine/` | `engineRolls.ts`, `diceTier.ts`, `lootEngine.ts`, `pcCreationScript.ts` | Pre-rolled dice, fairness DC, 3-gate manual rolls, loot tree walker, PC point-buy |
| **Arc Engine** | `src/services/arc/` + `mods/arc/` | `src/services/arc/{arcConstants,arcSpawn,openThreads,index}.ts` + compute mod `mods/arc/{manifest.json,compute.js,index.js}` | 7-type systemic conflict engine; spawn in-tree, tick/dice/stance in the sandboxed `arc` compute mod (state in `mod.arc.arcs` mod table) |
| **One-Shot Events** | `src/services/oneshot/` | `oneShotEvents.ts` | Manual event injector (7 event types) |
| **OOC / Ask GM** | `src/services/ooc/` | `askGmHandoff.ts`, `oocService.ts`, `context.ts`, `retrieval.ts`, `sections.ts`, `oocSectionRegistry.ts`, `types.ts` | OOC side chat with the utility AI; brief arming; mod-extensible section registry |
| **Map Engine** | `src/services/mapEngine/` | `worldOrchestrator.ts`, `worldGenerator.ts`, `registryLoader.ts`, `registries/{fantasy,medieval,urban,nature,post_apoc,cyberpunk,index}.ts` | Noise-based 100×100 world gen, biome registries, LLM anchors, terrain travel via worldmap mod |
| **Mods Platform** | `src/services/mods/` (55 prod files) + `server/lib/modLoader.js` (1,990 lines) + `server/routes/mods.js` | `modBootstrap.ts`, `modLoader` (server), `sandbox/`, `events/`, `facts/`, `interceptors/`, `lifecycle/`, `loadOrder/`, `macros/`, `mounts/`, `native/`, `budgets/`, `computeTrack.ts`, `modTables.ts`, `modPanels.ts`, `nativeTrustStore.ts`, `tierEntryAdapter.ts`, `screenApiTypes.ts` | `manifest.json` folder mods, sandboxed compute worker, mod event bus, fact publishers, prompt interceptors, tier entries, panels/screens/windows, table registry, load order, i18n per-mod |
| **Roles** | `src/services/roles/` | `roleRegistry.ts`, `roleContext.ts`, `roleEnablement.ts`, `roleFaults.ts`, `roleTypes.ts` | Service-role lease system letting mods claim/override host roles (e.g. `memory.recall`) |
| **Tables** | `src/services/tables/` + `server/lib/tableRegistry.js` | `genericAccessor.ts`, `hydrateTables.ts`, `locationTable.ts` (client) + `tableRegistry.js`, `modTableRegistry.js`, `locationTable.js`, `legacyTables.js`, `legacyAdoption.js` (server) | Generic descriptor-driven campaign JSON tables; mod tables; retired-table legacy adoption (Phase 8.5) |
| **Character** | `src/services/character/` | `aiGuidedGeneration.ts`, `commitCharacterDraft.ts`, `hexQuiz.ts`, `loreExcerptBuilder.ts`, `migratePC.ts`, `parseInterviewLines.ts`, `pcUpdater.ts` | AI-guided PC creation (9-slot interview, 8 phases), hex quiz, legacy PC migration |
| **Vision & Scene Images** | `src/services/vision/` + `src/services/scene-images/` | `describeImage.ts`, `imageSource.ts`, `visionRequest.ts` + `sceneImageContextGatherer.ts`, `sceneImagesClient.ts` | Multimodal image description; scene illustration generation (ComfyUI/OpenAI-compatible/OpenRouter) |
| **TTS** | `src/services/tts/` | `kokoroBuffer.ts`, `proseStripper.ts`, `ttsClient.ts`, `useTtsStatus.ts` | Chunked Kokoro playback, karaoke highlighting, prose stripping |
| **Infrastructure** | `src/services/infrastructure/` | `backgroundQueue.ts`, `jsonExtract.ts`, `tokenizer.ts`, `settingsCrypto.ts`, `assetService.ts` | Background task queue, robust JSON extraction, AES-GCM settings crypto |
| **Server Backend** | `server/` | `server.js`, `vault.js`, `lib/` (16 files), `routes/` (18 files), `services/` (12 files) | Express app, KeyVault, vector store, embedder, NLP, mods loader, table registry, routes, archive service, image providers |
| **State Store** | `src/store/` | `useAppStore.ts`, `campaignStore.ts`, `campaignHydrator.ts`, `relationshipMemoryState.ts`, `relationshipMemoryStore.ts`, `slices/` (7 slice files) | Zustand composition root + 6 slices + hydration orchestrator + relationship-memory persistence seam |
| **UI Components** | `src/components/` | 18 subdirectories + root files (197 files: block-view, character, chat, context-drawer, header, hooks, icons, inventory, location-ledger, map, message, npc-ledger, ooc, panels, primitives, rail, settings-modal, tts, `__tests__`) | All React components, hooks, modals, mod panel renderers |
| **Shared Engine** | `packages/engine/` | `src/{json,loot,retrieval,rolls,npc,panels,tables,mods,roles}/` | Platform-pure shared core consumed by both mainApp and mobileApp |
| **i18n** | `src/i18n/` | `index.ts`, `types.ts`, `useTranslation.ts`, `locales/{en,ko,ru,pl,id,pseudo}.ts` | Dependency-free i18n core + typed keys + per-mod translation registration |
| **Background** | `src/services/background/` | `backgroundManager.ts` | User-selected chat background image (idb-keyval, CSS-variable application) |

---

## 3. Data Flow: Sequence of a Single Turn

```mermaid
sequenceDiagram
    autonumber
    actor Player
    participant UI as ChatArea.tsx
    participant PC as pendingCommit.ts
    participant PT as postTurnPipeline.ts
    participant TO as turnOrchestrator.ts
    participant TS as turnStages.ts
    participant CG as contextGatherer.ts
    participant PB as payloadBuilder.ts
    participant LS as llmService.ts
    participant SRV as Express (server.js)

    Player->>UI: Types message & clicks "Send"
    UI->>PC: commitPendingTurn() (single-flight; finalise PREVIOUS turn)
    PC->>PT: runPostTurnPipeline() on previous committed text
    PT->>PT: prologue tracks (autoProfile, digestClear)
    par Archive + post-turn tracks (Promise.allSettled)
        PT->>PT: runArchiveTrack (durable-commit verify → api.archive.append → sceneId stamp)
    and
        PT->>PT: npcTrack (7-pass detect → tier-gated validate → NPC-Update background)
    and
        PT->>PT: pressureTrack (scanPressure → patch → archive/restore)
    end
    PT->>PT: sequential: agencyTick, locationHeader, onStage, repression
    PT->>PT: post-commit tracks (9): chapterSeal, eventExtraction, inventoryScan,
             locationScan, pcDrift, profileScan, relationshipMemory, traitScan,
             travelAdvance (halt safety valve)
    PT->>SRV: POST /api/campaigns/:id/archive (6 NLP heuristics + embed + events)
    PC->>PC: Auto-condense check; clearPendingTurnSnapshot()

    UI->>TO: runTurn(state, callbacks, abortController)
    TO->>TS: Stage 1 resolveEngineRolls (pre-rolled dice, armed roll/loot/oneshot,
             absolute-command reveal)
    TS->>UI: Stage 2 addUserTurnMessage (sync bubble)
    TS->>CG: Stage 3 gatherTurnContext [phase: gathering-context]
    par
        CG->>CG: planner (LLM, tier-gated)
    and
        CG->>SRV: POST /archive/semantic-candidates (vector search)
    and
        CG->>CG: relationshipStances (tier-gated)
    end
    CG->>CG: archive-recall (RRF fusion) / recommender / lore-rules /
             dynamic-elevation / slotted-RAG / pinned chapters / deep-search (armed)
    TS->>TS: Stage 4 runIntroEngineStage (tier-gated NPC intros)
    TS->>TS: Stage 5 runDirectorStage (travel facts + watchdog dossier + brief;
             skipped under Absolute Command)
    TS->>TS: Stage 5b/5c runPromptInterception / runFactPublication (mod hooks)
    TS->>PB: Stage 6 buildTurnPayload (5-block assembly, cache_control)
    TS->>LS: Stage 7 runGenerationStage (streaming, tool loop max 5, 3-tier retry)
    LS->>SRV: POST /llm/proxy (CORS dodge for NVIDIA etc.)
    LS-->>UI: Stream chunks → updateLastAssistant() [phase: generating]
    TS->>TS: extractAndStripSceneStakes → build SwipeVariant
    TS->>PC: capturePendingTurnSnapshot() (freeze messages + cached payload + TurnContext)
    TS-->>UI: setPipelinePhase('idle')

    Note over Player,UI: Player browses swipes (2-5) generated lazily from cached payload
    Player->>UI: Clicks send again OR switches campaign
    UI->>PC: commitPendingTurn() — loop back to step 2
```

---

## 4. Blast Radius & Impact Matrix

When modifying core files, consult this matrix to trace downstream effects.

```
+-------------------------------------------------------------------------------------------------------+
| MODIFIED FILE / COMPONENT                  | DIRECTLY AFFECTED                | DOWNSTREAM IMPACTS        |
+============================================+==================================+==========================+
| server/lib/vectorStore.js                  | - server/services/vectorService | - Semantic recall fails   |
| (sqlite-vec schema, MMR, dims,             | - server/services/archiveService| - MMR rankings break      |
|  embedding_meta versioning)                | - server/routes/archive.js      | - Campaign loads lock up  |
|                                            | - src/services/llm/apiClient    | - Reindex required        |
+--------------------------------------------+----------------------------------+----------------------------+
| server/lib/modLoader.js                    | - server.js boot + mods route   | - All mods fail to load   |
| (1,990 lines; manifest validation,         | - src/services/mods/modBootstrap| - Bundled mods (worldmap, |
|  sandbox trust, table/panel/tier decls)    | - mod compute tracks, panels,   |   enemies, arc) vanish    |
|                                            |   screens                      | - Mod tables unreadable   |
+--------------------------------------------+----------------------------------+----------------------------+
| server/lib/tableRegistry.js                | - server.js generic + mod-table  | - locations GET/PUT 404s   |
| (descriptor schema, hooks, mounts)         |   route mounts                  | - Mod data tables break   |
|                                            | - transfer.js bundle export     | - Campaign import/export  |
|                                            | - src/services/tables           |   drops tables            |
+--------------------------------------------+----------------------------------+----------------------------+
| server/vault.js                            | - server/routes/vault.js        | - Settings unlock fails   |
| (AES-256-GCM, PBKDF2, NEV1 binary format)  | - server/routes/settings.js     | - API keys lost           |
|                                            | - src/store/slices/settingsSlice| - .nevault import/export  |
|                                            | - src/services/infrastructure/  |   fails                   |
|                                            |   settingsCrypto.ts             | - sceneImages key fetch   |
+--------------------------------------------+----------------------------------+----------------------------+
| src/store/slices/campaignSlice.ts          | - src/store/useAppStore.ts      | - UI render loop breaks   |
| (814 lines; Zustand campaign state)       | - all ledger modals             | - Campaign hydration      |
|                                            | - src/components/ChatArea.tsx   |   fails on reload         |
|                                            | - src/store/slices/chatSlice.ts | - debouncedSaveCampaign   |
|                                            |   (imports debouncedSave fn)    |   State signature changes |
+--------------------------------------------+----------------------------------+----------------------------+
| src/services/llm/llmRequestQueue.ts        | - src/services/llm/llmService.ts| - Network deadlocks       |
| (per-endpoint adaptive concurrency,       | - src/utils/llmCall.ts          | - Tool calls queue        |
|  429/503/529 recovery cap lift)            | - all turn/archive LLM calls    |   indefinitely            |
|                                            | - src/components/ChatArea.tsx   | - Rate-limit recovery     |
|                                            |                                  |   misfires                |
+--------------------------------------------+----------------------------------+----------------------------+
| src/services/turn/pendingCommit.ts         | - src/components/ChatArea.tsx   | - Message swiping breaks  |
| (703 lines; swipe lifecycle,              | - src/services/turn/postTurnPipe| - NLP updates skipped     |
|  single-flight commit, durable commit,      | - src/store/slices/chatSlice.ts | - Duplicated memory logs  |
|  snapshot singleton)                      | - src/App.tsx (reconcileOnLaunch)| - Ghost messages on crash |
+--------------------------------------------+----------------------------------+----------------------------+
| src/services/turn/tracks/                  | - src/services/turn/postTurnPipe| - Bookkeeping scans skip  |
| (runner + track registries)                | - arc/enemies/worldmap mods     | - Mod compute tracks      |
|                                            |   (register postTurn tracks)    |   unregister/break        |
|                                            | - 9 post-commit tracks          | - Travel halt valve dead  |
+--------------------------------------------+----------------------------------+----------------------------+
| server/lib/nlp.js                          | - server/services/archiveService| - Timeline events missing |
| (361 lines; entity parser, keywords,       | - server/services/nlpPipeline.js| - Missing/broken NPC tags |
|  witness heuristic, importance)            | - server/routes/archive.js      | - Fact ledger bloat       |
|                                            | - src/services/npc/npcDetector.ts| - Witness data wrong      |
+--------------------------------------------+----------------------------------+----------------------------+
| src/services/payload/payloadBuilder.ts    | - src/services/turn/turnStages   | - LLM payload malformed   |
| (394 lines; 5-block assembly + cache       | - src/services/turn/sceneContinue| - Cache busts every turn |
|  control + contribution registry)          | - src/services/turn/swipeGenerat| - Token budget overflow   |
|                                            | - src/components/TokenGauge.tsx  | - Wrong system prompt     |
+--------------------------------------------+----------------------------------+----------------------------+
| src/services/payload/contributions/        | - payloadBuilder final user msg  | - Prompt sections vanish  |
| (registry, builtins, assemble)             | - mods (register contributions)  | - Mod prompt extensions   |
|                                            |                                  |   silently dropped        |
+--------------------------------------------+----------------------------------+----------------------------+
| src/services/archive-memory/recall.ts     | - src/services/turn/contextGath | - Recall returns nothing  |
| (RRF fusion, divergence surfacing)         | - src/services/payload/world.ts | - Wrong scenes injected   |
|                                            | - src/services/archive-memory/   | - Divergence continuity   |
|                                            |   archiveChapterEngine.ts       |   breaks                  |
+--------------------------------------------+----------------------------------+----------------------------+
| src/services/npc/agency/agencyEngine.ts   | - tracks/sequential/agencyTrack  | - NPC agency ticks dead   |
| (413 lines; heartbeat, audition, goal roll)| - src/services/payload/world.ts  | - Timeskip narration dead |
|                                            | - src/store/slices/campaignSlice | - Hex drift stops         |
+--------------------------------------------+----------------------------------+----------------------------+
| src/services/rules/defaultRules.ts         | - src/services/payload/stable.ts| - GM loses autonomy rules |
| (system rules text)                        | - src/services/rules/rulesIndexer| - Dialogue format regresses|
|                                            | - src/services/lore/loreChunker | - RAG chunks re-derived   |
+--------------------------------------------+----------------------------------+----------------------------+
| src/types/index.ts + sibling type files    | - All src/ files importing types | - Compile errors          |
| (GameContext, NPCEntry, ChatMessage,       | - packages/engine/src/*         | - Migration logic lost     |
|  TravelState, SceneImageAttachment, etc.)  | - campaignHydrator (arcs        | - Defaults change         |
|                                            |   → mod.arc.arcs migration)      |                          |
+-------------------------------------------------------------------------------------------------------+
```

### Critical Risk Zones (High Blast Radius)

1. **`server/lib/vectorStore.js`** (405 lines) — sqlite-vec schema, MMR algorithm, embedding versioning. A schema change without a migration path breaks `data/embeddings.db` and prevents campaigns from loading. The `EMBEDDING_VERSION = 1` constant + `embedding_meta` table are the migration seam.
2. **`server/lib/modLoader.js`** (1,990 lines, largest file in the repo) — manifest validation, sandbox trust, table/panel/screen/tier declarations. Faults (never throws) but a bad change takes down ALL mods at boot, including bundled worldmap/enemies/arc.
3. **`server/lib/tableRegistry.js`** (375 lines) — descriptor schema + both dynamic route mounts. Breaks `locations` (the one built-in table), all mod tables, and transfer bundling.
4. **`server/vault.js`** (394 lines) — custom binary format with magic bytes `NEV1`. Any change to the IV/ciphertext/tag layout breaks every existing `.nevault` file. PBKDF2 iteration counts re-derive keys. Includes `archiveForRecovery()` reset path.
5. **`src/store/slices/campaignSlice.ts`** (814 lines) — exports `debouncedSaveCampaignState` consumed by chatSlice; registers the live-state getter used by all debounced saves. Renaming or removing any export breaks the save pipeline.
6. **`src/services/turn/pendingCommit.ts`** (703 lines) — owns the in-memory `PendingTurnSnapshot` singleton plus durable-commit persistence and single-flight commit. The snapshot invariant (importance rater must NEVER see next-turn messages) is load-bearing. Launch reconciliation + `retryFailedCommits()` sweep handle renderer death mid-browse.
7. **`src/services/payload/payloadBuilder.ts`** (394 lines) — Anthropic prompt-cache `cache_control: ephemeral` placement is exactly tuned. Moving stable/divergence/pinned blocks out of the cached prefix, or letting contributions write above the cache boundary, busts every cached turn.
8. **`src/types/gamecontext.ts`** — contains `migrateLegacyContext()` plus the `context.arcs → mod.arc.arcs` table migration (in `campaignHydrator.ts`). Changing migration logic without a ledger bump silently corrupts old campaigns.

---

## 5. Test Discipline

| Stat | Value |
|---|---|
| Vitest test files | 336 (292 in `src/` — 276 in `__tests__/` + 16 co-located; 40 in `server/__tests__/`; 4 in `packages/engine/`) |
| Estimated `it/test` blocks | ~4,242 (3,591 src + 595 server + 56 engine) |
| E2E | Playwright: 8 specs (31 tests) in `e2e/`, headless Chromium vs `npm run dev` |
| Naming convention | `*.test.ts(x)` for vitest; `*.spec.ts` only for Playwright e2e |
| Co-location | `__tests__/` subdirectory next to source (a few co-located in `npc/`, `arc/`) |
| Test runner | Vitest 4 with jsdom + React Testing Library; globals enabled |
| Server tests | `server/__tests__/` with `fs.mkdtempSync(os.tmpdir())` + `process.env.DATA_DIR` isolation |
| Coverage | Opt-in via `--coverage` flag; no thresholds set |
| Setup file | `src/test/setup.ts` (jest-dom matchers + scrollIntoView/scrollHeight polyfills) |
| Engine gate | `packages/engine/scripts/boundary-gate.mjs` runs as engine `pretest` to enforce purity |
| Base-app gate | `npm run test:base-app-gate` — single-file proof the app runs with zero mods (`src/services/turn/__tests__/baseAppGate/baseAppGate.test.ts`) |

Largest test files: `server/__tests__/modLoader.test.js` (1,546 lines), `src/services/__tests__/payloadBuilder.test.ts` (1,481 lines), `src/services/mods/lifecycle/__tests__/lifecycleHost.test.ts` (1,042 lines), `src/services/__tests__/archiveChapterEngine.test.ts` (1,009 lines), `src/services/payload/__tests__/historyLod.test.ts` (854 lines).

---

## 6. Key Files for Quick Reference

| "How does X work?" | Read this file |
|---|---|
| "How does a turn work?" | `src/services/turn/turnOrchestrator.ts` (234 lines) + `turnStages.ts` (909 lines, 9 stages) |
| "How is a swipe committed?" | `src/services/turn/pendingCommit.ts` (703 lines) |
| "How is context built?" | `src/services/turn/contextGatherer.ts` (405 lines) + `src/services/payload/payloadBuilder.ts` |
| "How is the payload structured?" | `src/services/payload/{payloadBuilder,stable,volatile,world,history,budgets,budgetClaims,lodRenderer}.ts` |
| "How do prompt contributions work?" | `src/services/payload/contributions/{registry,builtins,assemble}.ts` (10 built-ins, mod-extensible) |
| "How are scenes archived?" | `server/routes/archive.js` + `server/services/archiveService.js` (978 lines) |
| "How does vector search work?" | `server/lib/vectorStore.js` (405 lines, MMR + cosine + embedding versioning) |
| "How does embedding work?" | `server/lib/embedder.js` (202 lines, mxbai-embed-large-v1 q8, 1024 dims, LRU 512) |
| "How does RRF fusion work?" | `src/services/archive-memory/recall.ts` + `packages/engine/src/retrieval/lexicalFusion.ts` |
| "How does IDF work?" | `src/services/archive-memory/idf.ts` (signature-gated cache) |
| "How does dynamic elevation work?" | `src/services/archive-memory/dynamicElevation.ts` (scoped vector search, synopsis-tier verbatim) |
| "How does slotted RAG work?" | `src/services/archive-memory/slottedRag.ts` (on-stage witness-filtered snippets, MAX_SCENES=4) |
| "How does NPC agency tick?" | `src/services/npc/agency/agencyEngine.ts` (413 lines) |
| "How do reaction menus work?" | `src/services/npc/reactionMenu.ts` + `reactionRepression.ts` |
| "How does the relation meter work?" | `src/services/npc/relationMeter.ts` (asymmetric rise/fall thresholds) |
| "How does relationship memory work?" | `src/services/archive-memory/relationshipMemory.ts` + `src/services/npc/relationshipStance.ts` + `relationshipMemoryReading.ts` |
| "How does the hex roll work?" | `src/services/npc/hexRoll.ts` (weighted-never-walled Gaussian) |
| "How are scenes summarized?" | `src/services/saveFile/combinedSeal.ts` (seal + divergence + title in one call) |
| "How do chapters auto-seal?" | `src/services/archive-memory/archiveChapterEngine.ts` + `server/services/chapterFitting.js` (target 25) |
| "How does deep search work?" | `src/services/archive-memory/deepArchiveSearch.ts` (2-round LLM funnel) |
| "How does chapter refit work?" | `server/services/chapterFitting.js` (355 lines) + `/archive/chapters/refit` endpoints |
| "How does the Arc Engine work?" | `src/services/arc/{arcConstants,arcSpawn,openThreads}.ts` + `mods/arc/compute.js` (sandboxed tick) |
| "How does the travel system work?" | `src/services/turn/travelState.ts` (396 lines) + `travelPress.ts` + `departureComposer.ts` + `src/services/location/` |
| "How does Absolute Command work?" | `src/services/turn/absoluteCommand.ts` (binding OOC block, placed last, suppresses director layer) |
| "How does TTS work?" | `server/lib/tts.js` (209 lines, Kokoro-82M q8) + `src/components/tts/TtsPlaybackPanel.tsx` |
| "How does the vault work?" | `server/vault.js` (394 lines, AES-256-GCM, PBKDF2) |
| "What are the system rules?" | `src/services/rules/defaultRules.ts` (241-line template literal) |
| "What data does the store hold?" | `src/store/slices/` (7 slice files, see `useAppStore.ts`) |
| "How are NPCs detected?" | `src/services/npc/npcDetector.ts` (261 lines, multi-pass + LLM fail-closed validator) |
| "How does the priority queue work?" | `src/services/llm/llmRequestQueue.ts` (204 lines, per-endpoint adaptive concurrency) |
| "How are utility calls tracked?" | `src/services/llm/utilityCallTracker.ts` (chained deadline promise + UI strip) |
| "How is the world map generated?" | `src/services/mapEngine/worldGenerator.ts` + `registries/` + `public/bundled-mods/worldmap/` |
| "How is the divergence register rendered?" | `src/services/campaign-state/divergenceRegister.ts` |
| "How does knowledge scoping work?" | `src/services/campaign-state/knowledgeScope.ts` (`isKnownToAnyOnStage`, `parseKnownByToken`) |
| "How is the PC created?" | `src/components/character/AIGuidedCreationWizard.tsx` (836 lines, 9-slot AI interview, 8 phases) |
| "How are scene images generated?" | `server/services/{imageProvider,comfyUiProvider,openRouterImage,sceneImageComposerService}.js` + `src/services/scene-images/` |
| "How is settings state encrypted?" | `src/services/infrastructure/settingsCrypto.ts` (AES-256-GCM, providers-only at rest) |
| "How is JSON extracted from LLM output?" | `src/services/infrastructure/jsonExtract.ts` (`extractJson`, `extractJsonRobust`) |
| "How do mods work?" | `docs/MODDING.md` + `src/services/mods/modBootstrap.ts` + `server/lib/modLoader.js` + `docs/narrative-mod-api.d.ts` |
| "What are the engine packages?" | `packages/engine/src/{json,loot,retrieval,rolls,npc,panels,tables,mods,roles}/` |
| "How does i18n work?" | `src/i18n/index.ts` (261 lines) + `docs/TRANSLATING.md`; check via `npm run i18n:check` |

---

## 7. Dependency Exploration & Impact Analysis Tools

### Graphify (Built-in Script)
This codebase includes a custom parsing script to build interactive dependency graphs:
1. Run: `node scripts/patch-graph-imports.mjs` (348 lines)
2. Open `graphify-out/graph.html` in a browser for an interactive community-colored network visualization
3. Review `graphify-out/import-map.json` for raw dependency mapping data

### Recommended External Tools
1. **CodeLayers** (VS Code Extension) — color-coded blast-radius indicators in the IDE sidebar
2. **dependency-cruiser** (CLI) — circular dependency detection + Mermaid graph rendering
3. **skott** (CLI / Web App) — fast local interactive dependency graphs with dead code analysis

---

## 8. Coding Standards & Architecture (Authoritative)

- **Language**: TypeScript (strict mode, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`) for frontend; Node.js ES Modules (ESM) for backend.
- **State Management**: Central Zustand store (`src/store/useAppStore.ts`) combining 6 slices: `settingsSlice`, `campaignSlice`, `chatSlice`, `uiSlice`, `mapSlice`, `worldLoreSlice`. Avoid ad-hoc state managers. The `create<AppState>()((...a) => ({ ...createXSlice(...a) }))` pattern shares `set`/`get` across slices.
- **Persistence**: NO `persist` middleware. Persistence is manual:
  - Settings → IndexedDB (`idb-keyval`, key `nn_settings`, providers encrypted at rest) + server `PUT /settings` (500ms debounce)
  - Campaign/Chat → server-only via `debouncedSaveCampaignState` (1s debounce) and per-ledger debounced saves
  - UI → ephemeral (no persistence)
  - Map → server `/api/campaigns/:id/overworld` (note: hardcoded `/api` prefix)
  - WorldLore → localStorage (`nn_world_lore_drafts`, the ONLY slice using localStorage)
  - Relationship memory → server `/api/campaigns/:id/relationship-memory` (`relationshipMemoryStore.ts`)
  - Background image → idb-keyval (`ui:bg-image` / `ui:bg-opacity`)
- **Turn Orchestration**: The main game loop flows through `runTurn()` in `turnOrchestrator.ts` → 9 named stages in `turnStages.ts`. Swiping and swipe-commit lifecycles are staged in `pendingCommit.ts` (single-flight `commitPendingTurn`, durable-commit persistence). The `PendingTurnSnapshot` freezes messages + cached payload + TurnContext at swipe-1 completion so the importance rater never sees next-turn messages.
- **Post-Turn Tracks**: `postTurnPipeline.ts` runs prologue tracks, `Promise.allSettled` post-turn tracks (npc, pressure + mod-registered compute tracks like `mod.arc.compute`), sequential tracks (agency, locationHeader, onStage, repression), then 9 post-commit tracks. Tracks live in `src/services/turn/tracks/` and mods register their own.
- **Database & Storage**: JSON file store per campaign in `data/campaigns/<id>/`, indexed by SQLite vector database (`data/embeddings.db`) using `sqlite-vec` for local semantic recall. Three vec0 virtual tables: `archive_vss`, `lore_vss`, `rules_vss` (all cosine distance). Embedding version tracked in `embedding_meta` table. Mod tables stored as `<id>.mod-<modId>-<table>.json` via the table registry.
- **Encryption**: Application settings presets and keys are encrypted via AES-256-GCM using `KeyVault` (`server/vault.js`). Custom binary format with magic bytes `NEV1`. PBKDF2-SHA256 with 600,000 iterations for password-derived keys, 10,000 for machine-bound keys. Atomic writes via `*.tmp` + `fs.renameSync`.
- **Cache Discipline**: Anthropic prompt-cache `cache_control: ephemeral` placed on stable/divergence/pinned + last history message. Volatile + RAG rules + user message ride BELOW the cache boundary. Budgets computed via the `budgetClaims.ts` registry: rules 10% default, NPC 5% guaranteed floor, stable 15% (deep) / 25%, world 60% (deep) / 40% minus NPC floor, volatile 10%.
- **Mod Platform Discipline**: `mods/<mod-id>/manifest.json` folder manifests are validated by `server/lib/modLoader.js` (never throws — faults instead; flat `*.mod.json` files are rejected as legacy). Compute code runs in a worker sandbox (`src/services/mods/sandbox/`) with capability-scoped table/context access. Mod-declared ids are namespace-qualified (`mod.<modId>.<name>`). The base app must run with zero mods (`test:base-app-gate`).
- **Engine Purity**: `packages/engine/` enforces platform purity via `boundary-gate.mjs` (rejects `react`, `react-dom`, `zustand`, `@capacitor*`, `idb-keyval`, `better-sqlite3`, `express`, `node:*`). Run as engine `pretest` hook.
- **Test Discipline**: `*.test.ts(x)` for vitest, `*.spec.ts` for Playwright e2e only. Mostly `__tests__/` folders. Vitest with jsdom. No coverage thresholds (opt-in via `--coverage`).
- **Type Discipline**: Types are structural twins between app (`src/types/`) and engine (`packages/engine/src/*/types.ts`). The app keeps its own `src/types` as source of truth; the engine declares only the fields it reads. Migration logic lives in `src/types/gamecontext.ts` (`migrateLegacyContext`) + `campaignHydrator.ts` (`context.arcs → mod.arc.arcs`).
- **i18n Discipline**: All user-facing strings flow through `src/i18n/` typed keys (`en` is master, 336-line locale file). `npm run i18n:check` reports missing/orphan keys and placeholder mismatches per locale. Mods register their own translation maps.
- **No Comments Rule**: Per AGENTS.md / project convention, DO NOT add comments unless explicitly requested. (Note: the codebase itself contains extensive explanatory comments in core modules — the rule applies to new AI-generated code.)

---

## 9. Subsystem Deep-Dives (Verified)

### 9.1 Turn Orchestration (`src/services/turn/`)

**28 production files top-level + 24 in `tracks/` (+33 test files).**

The main game loop flows through `runTurn()` in `turnOrchestrator.ts` (234 lines — thin composition root): builds `HostFacade` + `TurnContext`, emits `turn.start`, calls 9 stages, guards `!provider`.

`turnStages.ts` (909 lines) — the 9 named stages:
1. **resolveEngineRolls**: Pre-rolls dice pools, resolves armed rolls/loot drops/one-shot injectors, reveals Absolute Command.
2. **addUserTurnMessage**: Synchronously adds the player's message bubble.
3. **gatherTurnContext**: Gathers parallel context via `gatherContext()`.
4. **runIntroEngineStage**: Tier-gated NPC introductions.
5. **runDirectorStage**: Travel facts + watchdog dossier + director brief. Skipped entirely under Absolute Command.
5b. **runPromptInterception**: Mod prompt interceptors (guarded by `hasPromptInterceptors()`).
5c. **runFactPublication**: Mod fact publishers.
6. **buildTurnPayload**: Compiles the 5-block payload; emits `turn.payloadBuilt`.
7. **runGenerationStage**: Streaming LLM calls, recursive tool loop (max 5), 3-tier retry, swipe-set stamping, `capturePendingTurnSnapshot` (early + late), durable-commit persistence, `turn.generated/aborted/failed` events.

`turnContext.ts` (194 lines) — TurnContext data bus threading a single mutable context (turnId via monotonic counter, input, gathered context, director briefs, watchdog nudges, world facts, interception, published facts, payload + traces) through the whole pipeline and across the commit boundary.

`pendingCommit.ts` (703 lines) — swipe lifecycle:
- `capturePendingTurnSnapshot(state, cachedPayload, displayInput, turnContext?)` freezes messages + payload + TurnContext at swipe-1 completion.
- `commitPendingTurn()` is **single-flight** (module promise; callers: send, campaign switch, launch reconcile, Arc Injector).
- `reconcilePendingCommitOnLaunch()` handles Electron/renderer death mid-browse + sweeps buried `commitFailed` turns (`retryFailedCommits`).
- `rebuildStateFromLiveStore(store, recoveredUserInput)` crash-recovery path.
- Durable-commit persistence (`persistPendingTurn`) survives hard crashes.

`postTurnPipeline.ts` (524 lines) — track orchestrator:
- Prologue tracks: `autoProfileTrack`, `digestClearTrack`.
- `Promise.allSettled` post-turn tracks: `npcTrack`, `pressureTrack` + mod-registered compute tracks (e.g. `mod.arc.compute`).
- Sequential tracks: `agencyTrack`, `locationHeaderTrack`, `onStageTrack`, `repressionTrack`.
- Post-commit tracks (9): `chapterSealTrack`, `eventExtractionTrack`, `inventoryScanTrack`, `locationScanTrack`, `pcDriftTrack`, `profileScanTrack`, `relationshipMemoryTrack`, `traitScanTrack`, `travelAdvanceTrack` (halt safety valve only — if the location header names an unrelated place it halts the journey).

`travelState.ts` (396 lines) + `travelPress.ts` + `travelFacts.ts` + `departureComposer.ts` + `mapTravelPreview.ts` — the WO 6.5 travel system: travel is an **engine action, not an LLM turn**. `depart`/`departMultiHop` (pathfinder routes from the worldmap mod), `advance` (one press = one day = one checkpoint), `arrive`, `abandonJourney`, `halt`, `jump`. Engine `role:'system'` checkpoint messages, no model call. `travelFacts` feeds the Continuity Director hard world facts (max 3, silent unless `context.worldDay` set).

`hostFacade.ts` (566 lines) — Phase 4.0 mod-facing facade: frozen data/config/write surface, `model.call` with 6 ModelRoles (`story|utility|auxiliary|summariser|raw-auxiliary|raw-summariser`), `table` adapter (mod-prefixed names only), reactive-read hub, `requestBackup`.

`aiTier.ts` (189 lines) — the canonical feature matrix:
- `TierFeature` union of **27 features** (lite: `npcStance` only; pro: 17 on incl. planner/archiveFunnel/deepScan/recommender/npcValidate/sealChapter/heartbeatTick/timeskipRun/arcTick/arcSpawn/directorBrief/lodDynamicElevation; max: all 27).
- `NPC_UPDATE_COOLDOWN`: `{ lite: Infinity, pro: 5, max: 0 }`.
- `tierAllows` consults built-in MATRIX first, then the mod tier registry (`tierBlockRegistry.ts`), unknown → false.

`blockEnablement.ts` (63 lines) — single `isBlockEnabled(blockId, tier, moduleEnabled)` resolver + `blockTokenCap()`.
`tierBlockRegistry.ts` (116 lines) — registry for mod-declared tier entries (per-tier matrix + cooldown + modId provenance).
`absoluteCommand.ts` (39 lines) — Absolute Command v1: binding `[USER ABSOLUTE COMMAND — OUT OF CHARACTER, BINDING]` block placed LAST, suppressing Director Brief/watchdog/GM_REMINDER for that turn.

### 9.2 NPC Agency (`src/services/npc/agency/`)

**17 production files (+10 test files).**

The agency tick is a heartbeat-driven NPC off-screen life simulator. Every tick:
1. **Timeskip detection** (`detectTimeskip`, 13 regex patterns): if non-ambiguous weeks>0 and tier allows `timeskipRun`, run `runTimeskipPath` (batched engine state + 1 narration LLM call) and return.
2. **Heartbeat trickle** (`rollHeartbeat`): d100 vs DC starting at 20, -5 per miss, floored at 0, resets on fire.
3. **Proximity roster** (`buildProximityRoster`): filter eligible NPCs by region/faction/relation proximity to PC.
4. **Tick target selection** (`selectTickTarget`): audition system. `DEEP_TIER_CAP=3`; `AUDITION_PROB=0.15`; activity decay 0.5.
5. **Goal upgrade** (`upgradeWantsToGoals`): idempotent migration.
6. **Choose tick** (`chooseTick`): color roll → highest-score active+allowed goal → need → idle.
7. **Goal roll** (`rollGoal`): d20 + karma (`min(failStreak * 2, KARMA_CAP=6)`) vs `GOAL_BASE_DC=10`. Bands: critSuccess (nat 20 or margin≥10) / success / successBut / failBut / fail / critFail.
8. **Collision detection**: shared region/keyword + `COLLISION_TANGLE_PROB=0.5` → tangle (ally cooperate; rival contest `+3`; neutral mild contest).
9. **Hex drift** (`agencyDrift.applyGoalOutcomeNudge`): clamped ±1 per event, ±3 band. Rung-ladder tier-cross (`applyTierCross`) requires BOTH progress ≥ quota AND a justified event — grinding alone can NEVER cross.
10. **Digest** (`buildDigest`): player view (filters `direct|report`, caps at 3) + debug view.

Pools (`agencyPools.ts`): `TRAIT_VOCAB` 47 entries (incl. 12 mature-mode), `WANT_POOL` 57 (23 short + 34 medium), `ACTION_POOL` 55 (31 peaceful + 24 dangerous), `REACTION_VOCAB` 29. Bands: 7 relation words, 6 hex axes × 7 words.

**Innovations**: pre-rolled dice with karma bonus, weighted-never-walled hex roll, rung-ladder tier-cross, collision tangle, timeskip narration is the ONLY LLM cost.

### 9.3 NPC Ledger & Relations (`src/services/npc/`)

**23 production files (+15 test files: 4 co-located + 11 in `__tests__/`).**

- **`npcDetector.ts`** (261 lines): multi-pass NPC name extraction (server twin does 6 numbered passes; client adds LLM validation). Blocklist ~300 entries. Title stripping via `src/data/titles.json`. `validateNPCCandidates` is fail-closed (returns `[]` on any LLM error).
- **`npcBehaviorDirective.ts`**: builds the `PLAY AS: ...` runtime directive; engine numbers NEVER reach the LLM — only band-words. Also drift alerts and knowledge boundaries.
- **`reactionMenu.ts`**: engine-built reaction menu. Score = Σ `axisWeights[a] * hex[a]` + relation + trait bonuses; gates (`requireTraitAny`, `forbidTraitAny`, `forbidTraitWhenClose`); top 5 → take top + 2 sampled. Anti-sycophancy: the engine pre-filters, the AI only picks.
- **`reactionRepression.ts`**: inner repression layer. `hideScore = (composure - boldness) - pcRelation - pressure`; `BURST_THRESHOLD=4` forces expression + discharge. Two tells (leaked/concealed).
- **`relationMeter.ts`**: hidden sub-band meter, asymmetric (`RISE_THRESHOLD=100` up, `FALL_THRESHOLD=50` down).
- **`affinityAccess.ts`** / **`relationResolve.ts`** / **`relationDedupe.ts`**: WO-4 canonical affinity accessor + relation-key resolver (fixes live name-keyed bug) + edge normalization.
- **`relationshipMemoryCompaction.ts`** / **`relationshipMemoryReading.ts`** / **`relationshipStance.ts`**: WO-1 relationship memory (per-pair directed records: mood 8 values, impact 4 levels), reading selection (sceneDistance, recency, participant overlap, theme charge, injection score), stance block rendering (token budgets cheap 320 / deep 600; deep budget per tier lite 0 / pro 2 / max 3).
- **`importTransform.ts`**: cross-campaign NPC import modes `full | strip | isekai` (isekai reframes foreign memories as past-life recollections).
- **`hexRoll.ts`**: weighted-never-walled Gaussian hex roll inside envelope (`MIN_WEIGHT_FLOOR=0.005`).
- **`npcPressureTracker.ts`**: per-NPC ignored/engaged pressure; auto-archive stale.

### 9.4 Prompt Assembly (`src/services/payload/`)

**11 production files + `contributions/` (5 files) (+16 test files).**

`payloadBuilder.ts` (394 lines) — 5-block assembly with Anthropic `cache_control: ephemeral`:
1. Stable system message (cached) — `buildStable`
2. Divergence system message (cached)
3. Pinned memories system message (cached)
4. History messages (cached prefix; last history msg stamped)
5. **Final user message** (BELOW cache boundary) — composed via the contribution registry

The final user message is a **contribution registry** (Project 2): 10 built-in modules in priority order — volatileBlock(100) · relations(150) · stance(150) · writerCot(200) · directorBrief(300) · gmReminder(400) · watchdogNudge(500) · askGmBrief(600) · userMessage(700) · absoluteCommand(800, LAST). `GM_REMINDER` text (in `contributions/builtins.ts`): `'[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not default to facilitation.]'`.

`budgetClaims.ts` (290 lines) — budget-claim registry: rules = 10% default; stable = 15% (deep) / 25%; world = 60% (deep) / 40% minus NPC; NPC floor = 5%; volatile = 10%. `budgets.ts` delegates here.
`lodRenderer.ts` (281 lines) — LOD renderer for sealed chapters (tiers `summary | synopsis | dropped`), witness-filtered, budget cascade demotes oldest first.
`volatileSegments.ts` (231 lines) — volatile-block segment seam; segment id IS its budget claim id.
`world.ts` (659 lines, largest): archive recall, elevated scenes, slotted-RAG block, RAG lore, timeline, active NPCs, scoped knowledge, agency/arc digests, relations block, divergence register.
`volatile.ts` (364 lines): location, scene notebook, profile (scene-aware trait retrieval), inventory.
`history.ts` (255 lines): LOD chapter rendering + importance bonus, newest-first fit, ephemeral tool cleanup, orphan protection.
`stable.ts` (117 lines): rules/canon/header/starter/reasoning framework.

### 9.5 Archive Memory (`src/services/archive-memory/`)

**17 production files (+6 test files).**

`recall.ts` (221 lines) — RRF fusion entry point (embedding ranker is now a fusion signal, not a hard filter):
1. `extractContextActivations` (user 1.0, recent assistant 0.7, older 0.3, NPC ledger 1.0).
2. `expandActivationsWithFacts` (1-hop 0.5×, 2-hop 0.25×).
3. Range/exclude scoping → `computeArchiveIdf` (BM25 smoothing) → `applyEventBoost`.
4. `scoreEntry`: IDF-weighted keyword relevance + event boost + planner boost 2.0 + recency/importance tiebreak.
5. Embedding ranker (server-side, scope-filtered) → `fuseRRF` (k=60).
6. Divergence front-loading → `computeDynamicMax` slice.

`dynamicMax.ts` — consensus-based recall ceiling: DEPTH_TIERS lean {5,4,3} / standard {10,7,5} / deep {12,9,7}.
`dynamicElevation.ts` (248 lines, WO-11) — scoped vector search (`scopeSceneIds`) → synopsis-tier scenes surfaced verbatim below the cache boundary; reuses `lodRenderer`.
`slottedRag.ts` (261 lines, WO-12) — one-line verbatim snippets from non-elevated hits; strict on-stage witness filter; MAX_SCENES=4.
`relationshipMemory.ts` (263 lines, WO-1) — LLM extraction of directed per-pair memory records (mood 8, impact 4, event+outcome ≤8 words).
`synopsisBackfill.ts` (165 lines, WO-07) — user-triggered synopsis/abstractTitle generation for sealed chapters missing them.
`condenser.ts` — `VERBATIM_WINDOW=10`, budget ratios tight 0.5 / default 0.75 / deep 0.90.
`deepArchiveSearch.ts` (400 lines) — 2-round LLM deep scan with partitioned summarize.
`archiveChapterEngine.ts` (423 lines) — chapter auto-seal (threshold 25 OR new SESSION_ID) + iterative funnel (3D score → LLM validate → scene fetch).
Server-side chapter refit lives in `server/services/chapterFitting.js` (355 lines, `CHAPTER_SCENE_TARGET = 25`).

### 9.6 Server Backend (`server/`)

**~70 source files** under `server/` plus the root `server.js` (151 lines). 40 test files in `server/__tests__/`.

Key library files:
- **`server/lib/modLoader.js`** (1,990 lines, largest file in repo): folder-manifest validation (`mods/<mod-id>/manifest.json`; flat `*.mod.json` rejected as legacy), compute/native file trust, table/panel/screen/tier declarations, `PROTECTED_SUPPRESSION_IDS`, per-mod i18n.
- **`server/lib/tableRegistry.js`** (375 lines): descriptor schema, `createTableRegistry`, hooks (5 kinds), `mountGenericTableRoutes` (serves `locations` — the one built-in descriptor) + `mountModTableRoutes` (`/mod-tables/:table`, `/mod-data/:modId`).
- **`server/lib/vectorStore.js`** (405 lines): sqlite-vec, 3 vec0 tables (cosine). `EMBEDDING_VERSION=1` + `embedding_meta`. `MMR_LAMBDA=0.7`, `MMR_MIN_POOL=4`, `SCOPE_FALLBACK_OVERFETCH_CAP=64`. Rules never diversified. Dims via `settings.json → settings.embeddingDims` (fallback 1024).
- **`server/lib/embedder.js`** (202 lines): mxbai-embed-large-v1 q8, 1024 dims, LRU 512. `resolveIndexingSpeed`: eco (4, 250ms) / balanced (8, 100ms) / aggressive (16, 0ms). Text caps 500 chars.
- **`server/lib/nlp.js`** (361 lines): NPC name detection (6 numbered passes server-side), `estimateImportance` (base 3, +3 death, +2 MEMORABLE, clamped 1–10), `extractWitnessesHeuristic`, 5 timeline regex predicates, `extractIndexKeywords` (cap 20).
- **`server/lib/entityResolution.js`** (52 lines): 3-tier normalization (exact → substring → Levenshtein, threshold 2/3 by length).
- **`server/lib/tts.js`** (209 lines): Kokoro-82M q8, `DEFAULT_VOICE='af_heart'`, SHA-256 WAV cache. Warmup is a no-op if model not cached. ASAR workaround sets cache env before dynamic import.
- **`server/vault.js`** (394 lines): `MAGIC='NEV1'`, AES-256-GCM, PBKDF2 600k/10k. Format `[4B magic][4B ct len][12B IV][ct][16B tag][optional 16B salt]`. Atomic `*.tmp` + rename. `archiveForRecovery()` reversible reset.

Key service files:
- **`server/services/archiveService.js`** (978 lines, 20 exports): `appendScene` (6 NLP heuristics inline, fire-and-forget embed), `rollbackScenesFrom`, `deleteScene`, `updateSceneAssistant`, `archiveSemanticCandidates` (`{pending:true}` short-circuit), `reindexEmbeddings`, `previewRefitChapters`/`refitChapters`.
- **`server/services/nlpPipeline.js`** (112 lines): deferred LLM extraction on `archive:written`, `setImmediate` after `res.json()`, errors swallowed.
- **`server/services/llmProxy.js`** (193 lines): `TIMELINE_PREDICATES_SERVER` 12-element allowlist, `callLLMWithRetry` exponential backoff capped 4s, witness 5s/1-attempt, timeline 6s/2-attempts.
- **`server/services/chapterFitting.js`** (355 lines): pure chapter-fit functions, repair/hydrate/refit/repoint.
- **`server/services/imageProvider.js`** (203 lines) + `comfyUiProvider.js` (422) + `openRouterImage.js` (77) + `sceneImageComposerService.js` (136): scene illustration pipeline (LLM-composed prompt → ComfyUI / OpenAI-compatible / OpenRouter).
- **`server/services/backup.js`** (163 lines): create/restore/label/prune.
- **`server/services/vectorService.js`** (137 lines): thin wrapper over vectorStore + embedder.

Routes: **18 bespoke routers** mounted in `server.js` (vault, settings, campaigns, archive, chapters, timeline, facts, backups, assets, overworld, transfer, divergence, rules, llmProxy, embedding, tts, sceneImages, mods) + 2 registry-driven mounts (generic tables, mod tables) = 96 bespoke endpoints + 5 dynamic. See `ARCHITECTURE.md` § API Route Table.

### 9.7 Zustand Store (`src/store/`)

**13 files (8 source + tests).** 6 slices composed in `useAppStore.ts` (35 lines):

| Slice | Persistence | Key State |
|---|---|---|
| `settingsSlice` (458 lines) | IndexedDB (`nn_settings`, providers encrypted) + server `PUT /settings` (500ms debounce) | `settings` (47 fields incl. 7 legacy migration-only), `vaultStatus`, 7 endpoint getters (story/image/summarizer/utility/auxiliary/vision) |
| `campaignSlice` (814 lines) | Server-only (4 debounced saves, 1s debounce) | `activeCampaignId`, ledgers (npc/location), suggestions, `archiveIndex`, `chapters`, `timeline`, `entities`, `semanticFacts`, `pinnedChapterIds`, mod tables, `context` (~65 fields), `inventoryItems`, `characterProfileData`, relationship memory collections, bookkeeping counters |
| `chatSlice` (616 lines) | Via shared `debouncedSaveCampaignState` | `messages` (with attachments), `isStreaming`, `condenser`, `divergenceRegister` (18 actions), `pinnedExcerpts`, rename modal |
| `uiSlice` (182 lines) | Ephemeral (no persistence) | 16 boolean toggles + `pipelinePhase`, `streamingStats`, `contextScreen` (sys/world/eng/chpt/mem), armed roll/loot/oneshot/absoluteCommand, `composerInjection`, scene-image draft |
| `mapSlice` | Server `/api/campaigns/:id/overworld` | `overworldMap`, `isMapOpen/Loading`, `playerPosition`, `isPinMode`, `pendingPin` |
| `worldLoreSlice` | localStorage (`nn_world_lore_drafts`, the ONLY slice using localStorage) | `worldLoreDrafts`, `worldLoreActiveDraftId`, `worldLoreModalOpen` |

Non-slice store files: `relationshipMemoryState.ts` (narrow read/write seam so services don't import the whole store shape), `relationshipMemoryStore.ts` (server persistence), `campaignHydrator.ts` (parallel load + `context.arcs → mod.arc.arcs` migration), `campaignStore.ts` (fetch wrappers + CampaignState type).

**Cross-slice dependency graph**:
- Settings → reads `activeCampaignId` (Campaign) for save context.
- Campaign → reads `settings` (Settings), `messages`/`condenser`/`pinnedExcerpts` (Chat) via `CampaignDeps`; exports `debouncedSaveCampaignState` consumed by Chat; dynamically imports `commitPendingTurn`.
- Chat → reads `activeCampaignId`/`context`/`archiveIndex` (Campaign) via `ChatDeps`.
- UI, Map, WorldLore → no cross-slice reads (self-contained).

**Notable patterns**:
- `_registerCampaignStateGetter(getter)` prevents stale-closure races in debounced saves.
- Mirror pattern: inventory/character-profile mutations write BOTH a slice key AND `context.*`.
- `setActiveCampaign` awaits `commitPendingTurn` so a pending commit finishes for the OLD campaign first.

### 9.8 UI Components (`src/components/`)

**18 subdirectories + root files; 197 files (153 source + 44 tests).** Key surfaces:

- **`src/App.tsx`** (221 lines): Vault-gate (loading → VaultUnlockModal → campaign-loading → main), ErrorBoundary wrappers, dynamic `import('./services/turn/pendingCommit')` for crash reconcile. Main branch mounts: Header, ContextNavigationDrawer, ChatArea, ChatRightRail, WindowManager (mod floating windows), WorldMapTravelBridge, SettingsModal, NPCLedgerModal, CharacterLedgerModal, LocationLedgerModal, BlockViewModal, BackupModal, LoreCheckModal, DivergenceReviewModal, CreateTroubleModal, RenameNpcModal, PinnedMemoriesPanel, Toast, IndexingSpeedPrompt.
- **`ChatArea.tsx`** (398 lines): wires `useSwipeVariants`/`useSceneContinue`/`useRetryStoryAI`/`useCondenser`/`useChapterSealing`/`useMessageEditor`/`useChatOperations`/`useChatAttachment` (vision staging). Renders scene-note banner, SelectionActionsMenu, ChatMessageList, ChatActionStrip, IndexingBanner, ArmedAskGmNote, InventoryStagingBar, ChatComposer, AskGmPanel, ChatNavFabs, LootRollModal, DiceRollModal, SceneImageModal, PcPromptModal, RegenerateSheet.
- **`ContextDrawer.tsx`** (91 lines) is a legacy shim re-exporting **`ContextNavigationDrawer.tsx`** (213 lines): 5 context screens (System Context w/ merged Rules Manager, World Info, Engine Tuning, Chapters, Memory) + nav groups (Story / World / Play / Mods) with leaf links (NPCs, Places, Character, Pinned, Blocks, Backups, Mods).
- **`SettingsModal.tsx`** (98 lines): **6 tabs** (providers, presets, global, extensions, advanced, debug). ExtensionsTab (1,103 lines — mod enable/disable, load order, mod data, native trust, mod panels/screens) is the mod management surface.
- **`NPCLedgerModal.tsx`** (409 lines): list/gallery, bulk select, JSON import (with `full|strip|isekai` mode choice via `importTransform.ts`), AI review, portraits, suggestions.
- **`NPCEditForm.tsx`** (944 lines, largest component): hex axes, traits, relations, signature kit, boundaries, relationship memory editor hooks.
- **`character/AIGuidedCreationWizard.tsx`** (836 lines): 9-slot AI-guided interview, 8 phases (idle → generating-questions → answering → hex-choice → quiz → converting → clarifying → reveal), failure ladder never dead-ends.
- **`character/PCEditForm.tsx`** (825 lines) + `CharacterLedgerModal.tsx` (Sheet/Stats/Record/Inventory tabs + `RelationshipMemoryEditor`).
- **`OverworldCanvas.tsx`** (672 lines): PixiJS 8 renderer. `MapPanel.tsx` (174 lines) still exists but is **commented out in App.tsx** — map ships via the worldmap mod + `WorldMapTravelBridge`.
- **`block-view/`**: Blocks ledger UI (block model, modal, tier presets) — surfaces built-in + mod-declared tier blocks.
- **`panels/`**: mod panel mount rendering (ListDetailRenderer, ListPanelRenderer, PanelRenderer).
- **`header/`**: mod action mount region (HeaderModGroup, HeaderScrollRow) — mod buttons render inline in the header.
- **`rail/ChatRightRail.tsx`** + `RailPanelSwitcher.tsx`: right-rail mod panel switcher.

**Selection actions menu** (`useSelectionActions.ts`, 463 lines): Lore Check, Pin Memory, Rename, Add NPC, Add Place.

**TTS playback** (`useTtsPlayback.ts`): per-bubble Kokoro state, karaoke highlighting, disk-chunk preloading.

---

## 10. Cross-Cutting Concerns

### 10.1 LLM Call Tracking
`utilityCallTracker.ts` — `useSyncExternalStore`-based UI strip with live countdown + EXTEND button. `startUtilityCall(label, endpointName, timeoutMs)` creates a chained `deadlinePromise` that re-resolves on `extend`/`resetDeadline`. Terminal states: `running | success | timeout | error | aborted`. MAX_HISTORY=50.

### 10.2 Cache Telemetry
`cacheTelemetry.ts` records DeepSeek prompt-cache hit/miss tokens per day per call-label, localStorage-persisted (`cacheTelemetry.v1`), 14-day retention.

### 10.3 Background Queue
`backgroundQueue.ts` — fire-and-forget queue with campaign-id guards. `makeGuarded(fn, activeCampaignId, label)` no-ops when the campaign switched mid-flight; `assertStillActive` is the fast-fail inside multi-step closures.

### 10.4 JSON Extraction
`jsonExtract.ts`: `extractJson` (single regex) + `extractJsonRobust` (balanced-brace scan). Shared with the engine package.

### 10.5 Settings Crypto
`settingsCrypto.ts` — AES-256-GCM of providers only. Defense-in-depth: `PUT /settings` also runs `stripApiKeys`.

### 10.6 Engine Package Purity
`packages/engine/` — file-linked (`"file:packages/engine"`), purity enforced by `boundary-gate.mjs` (rejects react/react-dom/zustand/@capacitor*/idb-keyval/better-sqlite3/express/node:*). Modules: `json/`, `loot/`, `retrieval/`, `rolls/` (diceTier, engineRolls), `npc/` (dispositionGroups, hexVoiceGuide), `panels/` (descriptor + hooks), `tables/` (descriptor), `mods/` (apiVersion), `roles/` (roleIds).

### 10.7 Mods Platform (v2.0)
The defining v2.0 system. Layers:
- **Server**: `modLoader.js` validates `mods/<mod-id>/manifest.json` folders + bundled `public/bundled-mods/` (worldmap, enemies, example-bundled-tone). `tableRegistry.js` mounts mod tables. `routes/mods.js` serves manifests + mod assets.
- **Client bootstrap**: `modBootstrap.ts` fetches installed mods, registers translations, compute tracks, tier entries. Unreachable mods endpoint is a fault, never a crash.
- **Sandbox**: compute code runs in a worker (`mods/sandbox/`) with capability-scoped APIs (table read/write via `hostFacade.table`, `model.call` with 6 roles, `updateContext`, `addMessage`, event bus).
- **Contribution points**: prompt contributions, prompt interceptors, fact publishers, post-turn compute tracks, tier blocks, panels/screens/windows, header actions, OOC sections, service roles.
- **Bundled mods**: `worldmap` (terrain, pathfinder, travel, discoveries, encounters), `enemies` (Phase 8 successor of the hard-coded enemy system), `arc` (arc engine tick), `example-bundled-tone`.
- **Discipline**: the base app runs with zero mods (`test:base-app-gate`); mods can be fully uninstalled (`e2e/checkpoint3-uninstall-path.spec.ts`).

### 10.8 i18n
Dependency-free core in `src/i18n/` (261 lines). Locales: en (master, 336 lines), ko, ru, pl, id + pseudo (test). Typed `TranslateKey`. Mods register translation maps at bootstrap. `npm run i18n:check` validates coverage + placeholders. See `docs/TRANSLATING.md`.

---

## 11. Build, Test & Run Commands

| Action | Command |
|---|---|
| Start app (frontend + server concurrently) | `npm run dev` (server on 3001, Vite on 5173) |
| Start app with LAN-exposed Vite | `npm run dev:lan` (`vite --host 0.0.0.0`) |
| Start backend server only | `node server.js` (env `HOST`/`ALLOWED_ORIGINS` overridable) |
| Build frontend assets | `npm run build` (`tsc -b && vite build`) |
| Lint codebase | `npm run lint` or `npx eslint .` |
| Run tests | `npm run test` or `npx vitest` |
| Run tests (no watch) | `npm run test:run` |
| Zero-mod base-app gate | `npm run test:base-app-gate` |
| Run tests with coverage | `npm run test:coverage` |
| Run Playwright e2e | `npx playwright test` (spec dir `e2e/`, starts `npm run dev` itself) |
| Check i18n coverage | `npm run i18n:check` |
| Rebuild dependency graph | `node scripts/patch-graph-imports.mjs` |
| Bundle server for Electron | `node build-server.mjs` (esbuild → `server.bundle.cjs`) |
| Engine boundary gate | `node packages/engine/scripts/boundary-gate.mjs` |
| Verify mod sandbox isolation | `node scripts/verify-sandbox.mjs` |
| Verify screen-frame isolation | `node scripts/verify-screen-frame.mjs` |

Windows/Linux launchers at root: `Start_Narrative_Engine.bat` / `start.sh`, `Update_Narrative_Engine.bat` (self-copy-guarded git-pull updater), `Repair_Narrative_Engine.bat/.sh`.

---

## 12. Companion Documents

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — full directory layout, server init order, API route table, frontend→backend contract, state management, data flow.
- [`FEATURE_INVENTORY.md`](./FEATURE_INVENTORY.md) — exhaustive feature list by subsystem.
- [`INNOVATIONS.md`](./INNOVATIONS.md) — architectural innovations and unique patterns.
- [`docs/MODDING.md`](./docs/MODDING.md) — mod manifest reference and authoring guide.
- [`docs/narrative-mod-api.d.ts`](./docs/narrative-mod-api.d.ts) — typed mod API surface.
- [`docs/TRANSLATING.md`](./docs/TRANSLATING.md) — locale contribution guide.
- [`graphify-out/GRAPH_REPORT.md`](file:///d:/Games/AI%20DM%20Project/Automated_system/graphify-out/GRAPH_REPORT.md) — visual dependency graph report.