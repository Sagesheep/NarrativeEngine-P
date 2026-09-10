# Narrative Engine — Architecture Map

Single-file reference for AI agents and developers. Covers directory layout,
server initialization, API routes, frontend→backend contract, state management,
data flow, and the shared engine package.

For the system map & blast radius matrix see [`AI_CODEBASE_MAP.md`](./AI_CODEBASE_MAP.md).
For exhaustive feature listings see [`FEATURE_INVENTORY.md`](./FEATURE_INVENTORY.md).
For architectural innovations see [`INNOVATIONS.md`](./INNOVATIONS.md).

---

## Directory Layout

```
mainApp/
├── server.js                       # Express entry point (151 lines, 127.0.0.1:3001)
├── server/
│   ├── vault.js                    # KeyVault (394 lines, AES-256-GCM, PBKDF2-SHA256 600k/10k iter, NEV1 magic)
│   ├── lib/
│   │   ├── fileStore.js            # DATA_DIR paths, atomic JSON I/O (tmp+rename), 21 campaign file suffixes, MD5 campaign hash
│   │   ├── modLoader.js            # 1,990 lines — mod folder/manifest.json validation, sandbox trust, table/panel/tier decls (never throws)
│   │   ├── tableRegistry.js        # 375 lines — descriptor schema, 5 hook kinds, generic + mod-table route mounts
│   │   ├── modTableRegistry.js     # 240 lines — mod tables[] → descriptors (mod.<modId>.<name>, .mod-<modId>-<table>.json)
│   │   ├── locationTable.js        # 13 lines — the one built-in descriptor: locations (.locations.json)
│   │   ├── legacyTables.js         # 88 lines — retired-table registry (5 enemy files retired in Phase 8.2)
│   │   ├── legacyAdoption.js       # 218 lines — idempotent legacy→mod-table copy, guarded by .migrations.json ledger
│   │   ├── embedder.js             # 202 lines — mxbai-embed-large-v1 q8, 1024 dims, LRU 512
│   │   ├── vectorStore.js          # 405 lines — better-sqlite3 + sqlite-vec, 3 vec0 tables (cosine), MMR (λ=0.7), embedding versioning
│   │   ├── nlp.js                  # 361 lines — 6-pass NPC detection, keywords, importance, witness heuristic, timeline regex
│   │   ├── entityResolution.js     # 52 lines — 3-tier name normalization (exact → substring → Levenshtein 2/3)
│   │   ├── tts.js                  # 209 lines — Kokoro-82M q8, lazy warmup, SHA-256 WAV cache, ASAR workaround
│   │   ├── embedJobs.js            # In-memory bulk embed job tracker (non-blocking signal)
│   │   ├── writeLock.js            # Per-campaign async write serializer (promise-chain lock)
│   │   ├── serverError.js          # AppError class + centralized Express error formatter
│   │   └── asyncHandler.js         # One-liner Express async route wrapper
│   ├── routes/                     # 18 route modules, all export create<Name>Router() factories (96 endpoints)
│   │   ├── vault.js                # /api/vault/* — 12 endpoints, strict allowlist validation on PUT /keys
│   │   ├── settings.js             # /api/settings — GET/PUT, stripApiKeys before persist
│   │   ├── campaigns.js            # /api/campaigns/:id — 14 endpoints, migrations list, relationship-memory, lore bulk-embed
│   │   ├── archive.js              # /api/campaigns/:id/archive — 18 endpoints (append, scenes, semantic-candidates, reindex)
│   │   ├── chapters.js             # /api/campaigns/:id/archive/chapters — 10 endpoints (seal, merge, split, refit)
│   │   ├── timeline.js             # /api/campaigns/:id/timeline — 3 endpoints, lazy v1→v2 migration from facts.json
│   │   ├── facts.js                # /api/campaigns/:id/facts + /entities — 4 endpoints, entity merge
│   │   ├── backups.js              # /api/campaigns/:id/backup(s) — 6 endpoints, labels, pre-restore safety backup
│   │   ├── assets.js               # /api/assets/{upload,download} — 2 endpoints, path-traversal guard
│   │   ├── overworld.js            # /api/campaigns/:id/overworld — 3 endpoints, LLM generation (120s timeout)
│   │   ├── transfer.js             # /api/campaigns/:id/export + /import — 339 lines, bundle, background re-embed
│   │   ├── divergence.js           # /api/campaigns/:id/divergence — GET/PUT
│   │   ├── rules.js                # /api/campaigns/:id/rules — 4 endpoints (embed, embed delete, search, reindex)
│   │   ├── llmProxy.js             # /api/llm/proxy — transparent streaming proxy (CORS dodge for NVIDIA etc.)
│   │   ├── embedding.js            # /api/embedding/runtime + /api/system/specs — model info + system specs
│   │   ├── tts.js                  # /api/tts — 6 endpoints (status, init, voices, check-cache, cached, generate)
│   │   ├── mods.js                 # /api/mods — 2 endpoints (manifest list + asset serving, installed→bundled fallback)
│   │   └── sceneImages.js          # /api/scene-images — 3 endpoints (compose, generate, attachment delete)
│   ├── services/
│   │   ├── archiveService.js      # 978 lines — appendScene, rollback, deleteScene, refit, reindex (20 exports)
│   │   ├── archiveRepository.js   # 136 lines — pure file I/O layer (no locks, no business logic)
│   │   ├── archiveEvents.js       # Shared EventEmitter for archive:written (breaks circular import)
│   │   ├── nlpPipeline.js         # 112 lines — deferred LLM extraction (witness + timeline), setImmediate after res.json()
│   │   ├── llmProxy.js            # 193 lines — witness classification, timeline events, retry+backoff, 12-predicate allowlist
│   │   ├── backup.js              # 163 lines — create/restore/label/prune, MD5 hash dedup
│   │   ├── vectorService.js       # 137 lines — thin wrapper over vectorStore + embedder + embedJobs
│   │   ├── chapterFitting.js      # 355 lines — chapter repair/hydrate/refit/repoint (CHAPTER_SCENE_TARGET=25)
│   │   ├── imageProvider.js       # 203 lines — ComfyUI vs OpenAI-compatible vs OpenRouter routing
│   │   ├── comfyUiProvider.js     # 422 lines — native ComfyUI txt2img (built-in workflow or user JSON with %placeholders%)
│   │   ├── openRouterImage.js     # 77 lines — OpenRouter images glue (aspect_ratio, b64_json)
│   │   └── sceneImageComposerService.js # 136 lines — LLM-composed illustration briefs (pure visual terms)
│   └── __tests__/                  # 40 test files (modLoader 1,546 lines, nlp 479, chapterFitting 351, ...)
├── src/
│   ├── main.tsx                    # Vite entry → createRoot(<App/>)
│   ├── App.tsx                     # 221 lines — vault-gate, ErrorBoundary, CampaignHub | Header+Drawer+ChatArea+modals
│   ├── version.ts                  # Version constant source
│   ├── index.css                   # Tailwind 4 entry
│   ├── lib/
│   │   └── apiBase.ts              # API_BASE / ASSET_BASE (file:// → absolute localhost:3001, else relative /api)
│   ├── types/                      # 14 files, barrel at index.ts
│   │   ├── index.ts                # Barrel re-export
│   │   ├── llm.ts                  # ApiFormat, AiTier, LLMProvider, AIPreset, AppSettings (47 fields: 40 current + 7 legacy)
│   │   ├── character.ts           # InventoryItem, CharacterProfile, CharacterTrait, NPCEntry, PersonalityHex, Goal
│   │   ├── archive.ts              # ArchiveIndexEntry, ArchiveScene, ArchiveChapter, TimelineEvent, TIMELINE_PREDICATES
│   │   ├── campaign.ts            # SwipeVariant, ChatMessage (attachments, sceneId, swipeSet), Campaign, PinnedExcerpt
│   │   ├── divergence.ts          # DivergenceEntry, DivergenceRegister (v2), TopicClusters
│   │   ├── gamecontext.ts        # GameContext (~65 fields incl. travel trio), migrateLegacyContext()
│   │   ├── arc.ts                # ArcType, ArcStance, ArcRecord
│   │   ├── loot.ts               # LootTree, LootProfile, LootDropResult, ArmedLoot
│   │   ├── lore.ts               # LoreChunk, RuleChunkMeta, WorldLoreDraft
│   │   ├── location.ts           # LocationEntry, LocationConnection, LocationSuggestion
│   │   ├── map.ts                # WorldMap, BiomeDefinition, WorldAnchor, MapPin, EngineSeed
│   │   └── sceneImage.ts         # SceneImageAspect, SceneImageAttachment, SceneImageDraft, prompt package types
│   ├── data/
│   │   ├── titles.json            # Nobility/military/religious/family/academic titles for NPC name stripping
│   │   └── portraitStyles.ts     # Persisted portrait art-style options (incl. legacy values)
│   ├── i18n/                       # Dependency-free i18n core
│   │   ├── index.ts               # 261 lines — LOCALES registry, registerModTranslations
│   │   ├── types.ts               # Typed TranslateKey
│   │   ├── useTranslation.ts      # React binding
│   │   └── locales/               # en (master, 336 lines), ko, ru, pl, id, pseudo (test)
│   ├── store/
│   │   ├── useAppStore.ts         # 35 lines — Zustand composition root (6 slices)
│   │   ├── campaignStore.ts       # CampaignState type + fetch/save helpers (NOT a Zustand store)
│   │   ├── campaignHydrator.ts    # hydrateCampaign() — parallel load, context.arcs → mod.arc.arcs migration
│   │   ├── relationshipMemoryState.ts  # Narrow typed read/write seam (avoids whole-store imports in services)
│   │   ├── relationshipMemoryStore.ts  # Server persistence for relationship-memory collections
│   │   └── slices/
│   │       ├── settingsSlice.ts   # 458 lines — settings + vault lifecycle, 7 endpoint selectors
│   │       ├── settingsHelpers.ts # Pure helpers, defaults, migrateSettings (3 legacy shapes), debouncedSaveSettings
│   │       ├── campaignSlice.ts   # 814 lines — largest slice, ~45 actions, debouncedSaveCampaignState (1s)
│   │       ├── chatSlice.ts       # 616 lines — messages, condenser, divergence register (18 actions), attachments
│   │       ├── uiSlice.ts         # 182 lines — 16 toggles + contextScreen + armed states + absoluteCommand
│   │       ├── mapSlice.ts        # Overworld map state
│   │       └── worldLoreSlice.ts  # World-builder drafts (ONLY slice using localStorage: nn_world_lore_drafts)
│   ├── services/
│   │   ├── apiClient.ts           # Frontend HTTP client (api.archive.*, api.chapters.*, api.vault.*, etc.)
│   │   ├── chatEngine.ts          # Barrel: payloadBuilder + llmService + npcGeneration + tagGeneration
│   │   ├── archiveMemory.ts       # Barrel re-export from archive-memory/
│   │   ├── saveFileEngine.ts      # Thin re-export; real logic in saveFile/
│   │   ├── saveFile/              # combinedSeal (seal + divergence + title one call), chapterSummary, headerIndex
│   │   ├── campaignInit.ts        # New campaign initialization (chunk lore, seed engines, parse NPCs)
│   │   ├── characterProfileParser.ts / characterTraitParser.ts / inventoryParser.ts # PC auto-scans
│   │   ├── locationParser.ts      # Location auto-scan + connectionBand
│   │   ├── locationHeader.ts      # resolveLocationHeader (resolved/feature-only/unknown)
│   │   ├── locationEnrich.ts      # queueLocationEnrichment (LLM background fill)
│   │   ├── sceneImagesClient.ts   # Scene image HTTP client
│   │   ├── llm/
│   │   │   ├── llmService.ts       # sendMessage streaming (Ollama/OpenAI/Claude/Gemini)
│   │   │   ├── llmRequestQueue.ts # 204 lines — per-endpoint adaptive concurrency (cloud=∞, local=1), 429/503/529 recovery
│   │   │   ├── apiClient.ts        # api.* barrel (archive, chapters, facts, timeline, entities, campaigns, settings, backups, vault, rules)
│   │   │   ├── llmFetch.ts         # Drop-in fetch replacement → /llm/proxy (CORS dodge)
│   │   │   ├── cacheTelemetry.ts  # DeepSeek prompt-cache hit/miss telemetry (14-day retention, localStorage)
│   │   │   ├── timeouts.ts        # AI_CALL_TIMEOUT_MS=180s, ENGINE_CALL_TIMEOUT_MS=30s
│   │   │   └── utilityCallTracker.ts # In-flight utility call UI strip + EXTEND button (useSyncExternalStore)
│   │   ├── turn/                   # 28 production files + tracks/ (24 files)
│   │   │   ├── turnOrchestrator.ts # 234 lines — runTurn() thin composition root (9 stages)
│   │   │   ├── turnStages.ts      # 909 lines — the 9 named stages
│   │   │   ├── turnContext.ts     # 194 lines — TurnContext data bus (WO-P1-01)
│   │   │   ├── pendingCommit.ts   # 703 lines — swipe lifecycle, single-flight commit, durable commit
│   │   │   ├── postTurnPipeline.ts # 524 lines — prologue/post-turn/sequential/post-commit track orchestration
│   │   │   ├── contextGatherer.ts # 405 lines — parallel gather with 180s race backstop
│   │   │   ├── contextRecommender.ts # LLM-based context selection
│   │   │   ├── hostFacade.ts      # 566 lines — mod-facing facade (model.call 6 roles, table adapter, reactive reads)
│   │   │   ├── aiTier.ts          # 189 lines — TierFeature matrix (27 features), NPC_UPDATE_COOLDOWN
│   │   │   ├── blockEnablement.ts # 63 lines — isBlockEnabled + blockTokenCap
│   │   │   ├── tierBlockRegistry.ts # 116 lines — mod-declared tier entries
│   │   │   ├── absoluteCommand.ts # 39 lines — binding OOC block, placed LAST
│   │   │   ├── toolHandlers.ts    # Lore/notebook/dice/inventory tool handlers
│   │   │   ├── toolRegistry.ts    # Declarative tool registry
│   │   │   ├── contextMinifier.ts # Markdown strip + field abbreviations + category-prefixed lore
│   │   │   ├── sceneContinue.ts   # Continue button (MAX_CONTINUE_TOOL_CALLS=3)
│   │   │   ├── sceneStakesTag.ts  # [[SCENE_STAKES]] tag strip + LLM fallback classifier
│   │   │   ├── sceneStakesTelemetry.ts # localStorage counter for fallback frequency
│   │   │   ├── swipeGeneration.ts # Lazy swipes 2-5 from cached payload
│   │   │   ├── tagGeneration.ts   # AI tag populate for engine fields
│   │   │   ├── gatherProgress.ts # useSyncExternalStore stage indicator
│   │   │   ├── directorBrief.ts   # 448 lines — Director Brief LLM call + per-(campaignId,userMessage) cache
│   │   │   ├── directorWatchdog.ts # 342 lines — deterministic off-screen NPC dossier
│   │   │   ├── travelState.ts     # 396 lines — pure travel state machine (depart/advance/arrive/halt/jump)
│   │   │   ├── travelPress.ts     # One press = one day = one checkpoint message
│   │   │   ├── travelFacts.ts     # Max 3 hard world facts for the Continuity Director
│   │   │   ├── departureComposer.ts # Shared departure flow (map/Places/composer TRAVEL)
│   │   │   ├── mapTravelPreview.ts # Emits mod.worldmap.planTravel for map preview
│   │   │   └── tracks/            # runner.ts + npc/pressure + prologue/autoProfile/digestClear +
│   │   │       │                   # sequential/agency/locationHeader/onStage/repression +
│   │   │       │                   # postCommit (chapterSeal, eventExtraction, inventoryScan, locationScan,
│   │   │       │                   #   pcDrift, profileScan, relationshipMemory, traitScan, travelAdvance)
│   │   │       └── __tests__/      # 25 test files + 8 in tracks/
│   │   ├── payload/                # 11 production files + contributions/ (5 files)
│   │   │   ├── payloadBuilder.ts  # 394 lines — 5-block assembly + cache_control + contribution registry
│   │   │   ├── stable.ts          # 117 lines — system prompt (rules, canon, header, starter, reasoning)
│   │   │   ├── volatile.ts        # 364 lines — location, notebook, profile traits, inventory
│   │   │   ├── volatileSegments.ts # 231 lines — volatile-block segment seam (id = budget claim id)
│   │   │   ├── world.ts           # 659 lines — recall, elevated scenes, slotted RAG, lore, timeline, NPCs, relations
│   │   │   ├── history.ts         # 255 lines — LOD chapter rendering, newest-first fit, tool cleanup
│   │   │   ├── budgets.ts         # 71 lines — delegates to budgetClaims
│   │   │   ├── budgetClaims.ts    # 290 lines — budget-claim registry (rules 10%, NPC floor 5%, stable 15/25%, world 60/40%)
│   │   │   ├── lodRenderer.ts      # 281 lines — LOD tiers (summary|synopsis|dropped), witness-filtered cascade
│   │   │   ├── pinnedMemories.ts  # [PINNED MEMORIES] block formatter
│   │   │   ├── traceCollector.ts  # Debug-only trace + section collector
│   │   │   └── contributions/     # registry, assemble, builtins (10 modules + GM_REMINDER), extensions, types
│   │   ├── archive-memory/         # 17 production files
│   │   │   ├── recall.ts          # RRF fusion (activations → IDF → boost → score → embed rank → fuse → dynamic max)
│   │   │   ├── idf.ts             # Signature-gated IDF cache (BM25 smoothing, campaign-scoped)
│   │   │   ├── scoring.ts         # scoreEntry, activations, fact expansion (1-hop + 2-hop), event boost
│   │   │   ├── dynamicMax.ts      # Consensus-based recall ceiling (lean 5/4/3, standard 10/7/5, deep 12/9/7)
│   │   │   ├── dynamicElevation.ts # WO-11 — scoped vector search, synopsis-tier verbatim scenes
│   │   │   ├── slottedRag.ts      # WO-12 — on-stage witness-filtered one-line snippets (MAX_SCENES=4)
│   │   │   ├── condenser.ts       # VERBATIM_WINDOW=10, ratios (tight 0.5 / default 0.75 / deep 0.90)
│   │   │   ├── deepArchiveSearch.ts # 400 lines — 2-round LLM deep scan
│   │   │   ├── archiveChapterEngine.ts # 423 lines — auto-seal (25 OR new SESSION_ID) + iterative funnel
│   │   │   ├── archiveManager.ts  # Rollback + clear (pre-rollback backup)
│   │   │   ├── archivePlanner.ts  # LLM planner (rank candidate scenes)
│   │   │   ├── backfillRunner.ts  # Frontend wrapper for server reindex endpoint
│   │   │   ├── importanceRater.ts # LLM 1-5 rating + heuristic fallback
│   │   │   ├── sceneEventExtractor.ts # LLM structured event extraction
│   │   │   ├── witnessCapture.ts  # Regex NPC ID extraction + LLM fallback
│   │   │   ├── relationshipMemory.ts # WO-1 — per-pair directed memory records (mood 8, impact 4)
│   │   │   └── synopsisBackfill.ts # WO-07 — user-triggered synopsis generation for sealed chapters
│   │   ├── npc/                    # 23 production files (some tests co-located)
│   │   │   ├── npcDetector.ts     # 261 lines — multi-pass extraction + fail-closed LLM validator
│   │   │   ├── npcBehaviorDirective.ts # PLAY AS directive, drift alert, knowledge boundary, reaction menu line
│   │   │   ├── npcPressureTracker.ts # Per-NPC pressure, auto-archive stale
│   │   │   ├── reactionMenu.ts    # Engine-build reaction menu (anti-sycophancy)
│   │   │   ├── reactionRepression.ts # Inner repression (concealed/leaked, BURST_THRESHOLD=4)
│   │   │   ├── relationMeter.ts   # Hidden sub-band relation meter (asymmetric rise/fall)
│   │   │   ├── affinityAccess.ts  # The ONE affinity accessor (WO-4/WO-5 seam)
│   │   │   ├── relationResolve.ts # Canonical relation-key resolver
│   │   │   ├── relationDedupe.ts  # Edge normalization + dedup
│   │   │   ├── relationshipMemoryCompaction.ts # Record-list compaction
│   │   │   ├── relationshipMemoryReading.ts # Reading selection (sceneDistance, recency, overlap, themeCharge)
│   │   │   ├── relationshipStance.ts # Stance block (budgets cheap 320 / deep 600)
│   │   │   ├── importTransform.ts # Cross-campaign import: full | strip | isekai
│   │   │   ├── characterExport.ts # Filename sanitization + export shaping
│   │   │   ├── hexRoll.ts         # Weighted-never-walled Gaussian hex roll
│   │   │   ├── manualAdd.ts, npcManualResolve.ts, npcReview.ts, portraitPrompt.ts, signatureKit.ts
│   │   │   ├── troublemaker.ts    # 4 trouble arc seeds (legacy; Arc mod is successor)
│   │   │   ├── dispositionGroups.ts, hexVoiceGuide.ts # Re-exports from @narrative/engine
│   │   │   └── agency/            # 17 production files (+10 tests) — see AI_CODEBASE_MAP §9.2
│   │   ├── npc-generation/         # shared.ts, charIntroEngine.ts, profileRefit.ts (+ tests)
│   │   ├── character/              # aiGuidedGeneration, commitCharacterDraft, hexQuiz, migratePC, pcUpdater (+ tests)
│   │   ├── rules/                  # defaultRules (241-line template literal), rulesIndexer, rulesRetriever
│   │   ├── lore/                   # 11 files — chunker, retriever, NPC/location parsers, seeder, check, enricher,
│   │   │                           #   lootTreeLoader, worldLoreAI/Export/Import
│   │   ├── campaign-state/         # divergenceRegister, knowledgeScope, timelineResolver, factClusterer, factDeduper
│   │   ├── engine/                 # engineRolls, diceTier, lootEngine (re-exports), pcCreationScript
│   │   ├── arc/                    # arcConstants, arcSpawn, openThreads, index — tick lives in mods/arc compute mod
│   │   ├── oneshot/                # oneShotEvents (7 event types)
│   │   ├── ooc/                    # askGmHandoff, oocService, context, retrieval, sections, oocSectionRegistry, types
│   │   ├── mapEngine/              # worldOrchestrator, worldGenerator (100×100 noise), registryLoader, registries/ (6 biome sets)
│   │   ├── context-gatherer/       # archiveRecall (incl. planner), semanticCandidates, recommenderGather,
│   │   │                           #   loreRulesGather, pinnedChaptersGather, deepSearchGather
│   │   ├── retrieval/              # lexicalFusion (engine re-export), retrievalCore, semanticMemory, semanticReranker
│   │   ├── mods/                   # 55 production files — bootstrap, sandbox/, events/, facts/, interceptors/,
│   │   │                           #   lifecycle/, loadOrder/, macros/, mounts/, native/, budgets/, computeTrack,
│   │   │                           #   modTables, modPanels, nativeTrustStore, tierEntryAdapter, screenApiTypes
│   │   ├── roles/                  # roleRegistry, roleContext, roleEnablement, roleFaults, roleTypes (service-role leases)
│   │   ├── tables/                 # genericAccessor, hydrateTables, locationTable (client twin of server registry)
│   │   ├── panels/                 # tests only — panel registry lives in @narrative/engine (panels/)
│   │   ├── vision/                 # describeImage, imageSource, visionRequest (multimodal image→prose)
│   │   ├── scene-images/           # sceneImageContextGatherer (prompt-package composition)
│   │   ├── tts/                    # kokoroBuffer, proseStripper, ttsClient, useTtsStatus
│   │   ├── location/               # distance (DISTANCE_BANDS, day ranges), travelModes, travelModeMap
│   │   ├── saveFile/               # combinedSeal, chapterSummary, headerIndex, shared
│   │   ├── background/             # backgroundManager (chat background image, idb-keyval)
│   │   └── infrastructure/         # backgroundQueue, jsonExtract, tokenizer, settingsCrypto, assetService
│   ├── utils/
│   │   ├── uid.ts, helpers.ts      # ID generator, misc helpers
│   │   ├── llmCall.ts             # 142 lines — non-streaming utility wrapper (retries, priority, tracking, timeout)
│   │   ├── llmApiHelper.ts        # 422 lines — URLs, headers, bodies, stream extraction, thinking reserve
│   │   ├── samplingProfiles.ts    # Preset sampling profiles
│   ├── stripThink.ts          # stripThinkTags - <think> block stripper
│   │   ├── stopWords.ts, noise.ts, ledgerFilters.ts, locationIds.ts
│   │   ├── entityResolution.ts    # Frontend twin of server/lib/entityResolution.js
│   │   └── openRouterImage.ts     # Frontend OpenRouter image glue
│   ├── hooks/                      # useChatOperations, useChatPersistence, useChatKeyboard, useAutoresizeInput,
│   │                               #   useEmbeddingStatus, useRulesIndexer, useUiScale
│   ├── test/
│   │   └── setup.ts               # jest-dom + scrollIntoView/scrollHeight polyfills
│   └── components/                 # 18 subdirectories + root files; 197 files (153 source + 44 tests)
│       ├── App.tsx / Header.tsx (256 lines: mod action mount) / ChatArea.tsx (398 lines)
│       ├── ContextDrawer.tsx (91-line shim) → ContextNavigationDrawer.tsx (213 lines, 5 screens + nav)
│       ├── CampaignHub.tsx / CampaignFormModal.tsx / CoverflowCarousel.tsx
│       ├── SettingsModal.tsx (98 lines, 6 tabs: providers/presets/global/extensions/advanced/debug)
│       ├── NPCLedgerModal.tsx (409) / LocationLedgerModal.tsx (637) / CharacterLedgerModal (in character/)
│       ├── WorldLoreModal.tsx (295) / PinnedMemoriesPanel.tsx (211) / BackupModal / VaultUnlockModal
│       ├── TokenGauge / Toast / ErrorBoundary / PayloadTraceView / SceneNoteEditor
│       ├── IndexingSpeedPrompt / CreateTroubleModal / RenameNpcModal / LoreCheckModal
│       ├── DivergenceReviewModal / DedupReviewModal / NPCReviewModal
│       ├── block-view/             # BlockCard, blockModel, BlockViewModal, TierPresetBar (blocks ledger)
│       ├── character/              # AIGuidedCreationWizard (836), PCEditForm (825), RelationshipMemoryEditor,
│       │                           #   pcBonds, profileFields, tabs/ (Sheet/Stats/Record/Inventory), WorldPrimerPanel
│       ├── chat/                   # Composer, ActionStrip, MessageList, DiceRollModal, LootRollModal,
│       │                           #   SceneImageModal, RegenerateSheet, SelectionActionsMenu, ToolCallChips,
│       │                           #   AbandonJourneyChip, ChatAttachmentChip, useSelectionActions (463 lines)
│       ├── context-drawer/         # RulesTab, RulesManagerTab, LoreTab, EnginesTab (679), ChapterTab (519),
│       │                           #   ChapterCard (368), MemoryTab, memory-tab/ (FactsView 893, ReviewView)
│       ├── header/                 # HeaderModGroup, HeaderScrollRow (mod actions)
│       ├── hooks/                  # useSwipeVariants (358), useSceneContinue, useRetryStoryAI, useMessageEditor,
│       │                           #   useChapterSealing, useCondenser, useNpcPortraits, useNpcReview,
│       │                           #   useTtsPlayback, useVisionDescribe, useChatAttachment, sceneContinueFallback
│       ├── icons/                  # CommandSealIcon
│       ├── inventory/              # InventoryStagingBar
│       ├── location-ledger/        # LocationEditForm, LocationSuggestionsPanel
│       ├── map/                    # MapPanel (174, commented out in App.tsx), OverworldCanvas (672, PixiJS 8)
│       ├── message/                # MessageMarkdown, MessageActionRail, InlineMessageEditor, SwipeIndicator,
│       │                           #   ReasoningViewer, MessageActionsOverlay, MessageBelowSlots,
│       │                           #   PlayerAttachmentView, SceneImageAttachmentView
│       ├── npc-ledger/             # NPCEditForm (944, largest), NPCListView, NPCGalleryView, NPCPortraitSection,
│       │                           #   NPCSuggestionsPanel, ImportChoiceDialog
│       ├── ooc/                    # AskGmPanel, ArmedAskGmNote
│       ├── panels/                 # PanelRenderer, ListPanelRenderer (462), ListDetailRenderer (mod panels)
│       ├── primitives/             # Backdrop, Buttons, ScreenSection
│       ├── rail/                   # ChatRightRail, RailPanelSwitcher (right-rail mod panels)
│       ├── settings-modal/         # ProvidersTab (474), PresetsTab, GlobalSettingsTab (560), ExtensionsTab (1,103 —
│       │                           #   mod management), AdvancedTab (360), DebugTab, LanguageSection,
│       │                           #   LoadOrderSection, ModDataDialog, ModPanels, ModScreens, NativeTrustDialog,
│       │                           #   ScreenFrame, VaultSection
│       ├── tts/                    # TtsPlaybackPanel
│       └── __tests__/              # 13 component test files
├── packages/
│   └── engine/                     # @narrative/engine — platform-pure shared core
│       ├── package.json            # name: @narrative/engine, main: dist/index.js, exports ./roles/roleIds + ./mods/apiVersion
│       ├── tsconfig.json            # lib: ES2022 only (NO DOM/Node — enforces purity)
│       ├── scripts/boundary-gate.mjs # pretest hook: rejects react/zustand/@capacitor*/idb-keyval/better-sqlite3/express/node:* imports
│       └── src/
│           ├── index.ts            # Barrel
│           ├── json/jsonExtract.ts # extractJson, extractJsonRobust
│           ├── loot/lootEngine.ts  # Loot tree walker
│           ├── retrieval/lexicalFusion.ts # fuseRRF (k=60), computeIdf (BM25 smoothing)
│           ├── rolls/              # engineRolls (3-gate dice), diceTier (mapTier), types
│           ├── npc/                # dispositionGroups (envelopes/modifiers), hexVoiceGuide (buildVoiceDirective), types
│           ├── panels/             # panelDescriptor (createPanelRegistry), panelHooks (runPanelHook)
│           ├── tables/tableDescriptor.ts # createTableRegistry
│           ├── mods/apiVersion.ts # Mod API version constant
│           ├── roles/roleIds.ts   # SERVICE_ROLE_IDS ('memory.recall')
│           └── __tests__/          # 4 test files (json, loot, retrieval, rolls)
├── mods/                           # Installed mods dir (arc/, ability-compendium/)
├── public/
│   ├── assets/                     # 443 files: tilesets (246), portraits (93), Snow Pack (89), textures, props
│   └── bundled-mods/                # worldmap/, enemies/, example-bundled-tone/ (29 files, i18n per mod)
├── scripts/
│   ├── patch-graph-imports.mjs     # Graphify dependency graph builder (348 lines)
│   ├── i18n-check.mjs              # i18n coverage report (missing/orphan keys, placeholder mismatches)
│   ├── migrate-buildPayload-options.mjs # One-shot codemod: positional buildPayload args → options object
│   ├── seed-relationship-memory.mjs # Dev tool: seed 3 NPC↔MC relationship-memory edges
│   ├── measure-enemy-reactivity.mjs / measure-tables-gate.mjs # Perf benchmarks
│   └── verify-sandbox.mjs / verify-screen-frame.mjs # Mod isolation proofs (+ screen-frame-fixtures/)
├── e2e/                            # 8 Playwright specs + helpers (worldMapTravel, checkpoints 1-3, extensions, screens)
├── docs/                           # MODDING.md, narrative-mod-api.d.ts, TRANSLATING.md, phase inventories
├── electron/                       # Electron main process (nodeIntegration:false, contextIsolation:true)
├── build-server.mjs               # esbuild server → server.bundle.cjs for Electron ASAR
├── data/                           # (gitignored) campaigns/, backups/, embeddings.db, settings.json, apikeys.vault, caches
├── index.html                      # Vite entry (root div, /src/main.tsx)
├── package.json                    # narrative-engine v2.0.0, type:module, 18 deps + 25 devDeps
├── vite.config.ts                  # Vite 8 + React + Tailwind 4 plugins; /api + /assets proxy → :3001; base './'
├── vitest.config.ts                # jsdom + setupFiles; includes src/** + server/__tests__/** (engine has own config)
├── playwright.config.ts            # e2e/: headless Chromium, baseURL :5173, webServer npm run dev
├── tsconfig.json                   # Solution-style (references app + node)
├── tsconfig.app.json               # strict, verbatimModuleSyntax, erasableSyntaxOnly, excludes __tests__
├── tsconfig.node.json              # For vite.config.ts
├── eslint.config.js                # ESLint 9 flat config (tseslint + react-hooks + react-refresh)
├── .nvmrc                          # Node 22
├── Start_Narrative_Engine.bat / start.sh     # Launchers with Node pre-flight
├── Update_Narrative_Engine.bat    # Self-copy-guarded git-pull updater
└── Repair_Narrative_Engine.bat/.sh # Fixes for two common start failures
```

---

## Server Initialization Order (`server.js`)

```
1.  new KeyVault(DATA_DIR)                     — init crypto vault
2.  ensureDirs()                               — create data/, data/campaigns/, data/backups/,
                                                data/portraits (prod) or public/assets/portraits (dev),
                                                mods/, public/bundled-mods/
3.  Auto-create vault with machine key         — if missing
4.  Auto-unlock machine-key vaults             — on startup; password vaults require manual frontend unlock
5.  CORS allowlist                             — 'null' (Electron) + http://localhost:5173 (Vite) + $ALLOWED_ORIGINS
6.  express.json({ limit: '500mb' })           — middleware
7.  express.static mounts                      — /assets/portraits, /assets/campaigns
8.  initDb()                                   — SQLite + sqlite-vec (3 vec0 tables, cosine distance)
9.  registerLocationTable(serverTableRegistry) — locations descriptor live at boot
10. warmupEmbedder() (fire-and-forget)         — pre-load mxbai-embed-large-v1 q8
11. warmupTts() (fire-and-forget, no-op if not cached) — pre-load Kokoro-82M q8
12. Mount 18 bespoke routers in order:
    vault, settings, campaigns, archive, chapters, timeline, facts, backups,
    assets, overworld, transfer, divergence, rules, llmProxy, embedding, tts,
    sceneImages, mods (at /api/mods)
13. registerModTablesAtBoot()                  — loadMods + registerModTables (never throws)
14. mountGenericTableRoutes()                  — GET/PUT /api/campaigns/:id/locations + future descriptors
15. mountModTableRoutes()                      — mod-tables/:table GET/PUT + mod-data/:modId DELETE
16. Central error handler (serverError)        — 5xx → generic message, 4xx → actual message
17. app.listen(3001, process.env.HOST || '127.0.0.1') — localhost-only bind by default
```

---

## API Route Table

All routes are mounted under `/api`. All route files export `create<Name>Router()` factories.
96 bespoke endpoints + 5 registry-driven dynamic endpoints = 101 total.

### Vault (12 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/vault/status` | `{exists, unlocked, hasRemember}` |
| POST | `/api/vault/setup` | Create with `{password, presets}` |
| POST | `/api/vault/unlock` | Unlock with `{password, remember}` |
| POST | `/api/vault/unlock-remembered` | Unlock via OS-safeStorage remembered key |
| POST | `/api/vault/lock` | Lock vault |
| GET | `/api/vault/keys` | Get decrypted presets (403 if locked) |
| PUT | `/api/vault/keys` | Save presets (strict allowlist validation) |
| POST | `/api/vault/export` | Export as `.nevault` (encrypted with password) |
| POST | `/api/vault/import` | Import `.nevault` (merge by preset name) |
| POST | `/api/vault/reset` | `archiveForRecovery()` — reversible rename to apikeys.vault.recovery-<ts> |
| DELETE | `/api/vault/remember` | Clear remembered key |
| DELETE | `/api/vault` | Delete vault |

### Settings (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/settings` | Read `data/settings.json` |
| PUT | `/api/settings` | Write after `stripApiKeys()` (zeroes apiKey in all presets) |

### Campaigns (14 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns` | List all (sorted by lastPlayedAt desc) |
| GET/PUT/DELETE | `/api/campaigns/:id` | Campaign CRUD |
| GET | `/api/campaigns/:id/migrations` | Legacy-adoption migration ledger |
| GET/PUT | `/api/campaigns/:id/state` | Game state (pinnedExcerpts preservation guard) |
| GET/PUT | `/api/campaigns/:id/lore` | Lore chunks (PUT triggers background bulk-embed with job tracking) |
| GET/PUT | `/api/campaigns/:id/npcs` | NPC ledger |
| GET | `/api/campaigns/:id/relationship-memory/npc-to-mc` | Directed NPC→MC memory records |
| GET | `/api/campaigns/:id/relationship-memory/npc-to-npc` | Directed NPC→NPC memory records |
| PUT | `/api/campaigns/:id/relationship-memory` | Save relationship-memory collections |

### Archive (18 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/archive/next-scene` | Next scene number + padded sceneId |
| POST | `/api/campaigns/:id/archive` | Append scene (6 NLP heuristics inline, fire-and-forget embed, chapter auto-lifecycle) |
| DELETE | `/api/campaigns/:id/archive` | Clear archive (md + index + chapters + timeline) |
| GET | `/api/campaigns/:id/archive` | `{exists, sceneCount}` |
| GET | `/api/campaigns/:id/archive/index` | Full archive index |
| PATCH | `/api/campaigns/:id/archive/witnesses` | Patch witnesses on index entries |
| PATCH | `/api/campaigns/:id/archive/events` | Patch events on index entries |
| GET | `/api/campaigns/:id/archive/scenes?ids=001,002,...` | Fetch verbatim scenes by comma-separated IDs |
| POST | `/api/campaigns/:id/archive/rename` | Whole-word rename across prose + index |
| DELETE | `/api/campaigns/:id/archive/scenes-from/:sceneId` | Rollback: remove all scenes ≥ sceneId |
| DELETE | `/api/campaigns/:id/archive/scenes/:sceneId` | Surgical single-scene delete |
| PATCH | `/api/campaigns/:id/archive/scenes/:sceneId/assistant` | Edit-sync: rewrite + rebuild index + re-embed (awaited) |
| GET | `/api/campaigns/:id/archive/open` | Open archive in OS default editor |
| POST | `/api/campaigns/:id/archive/semantic-candidates` | Vector search (returns `{sceneIds}` or `{pending:true}`; supports `scopeSceneIds`) |
| POST | `/api/campaigns/:id/lore/semantic-candidates` | Lore semantic search |
| GET | `/api/campaigns/:id/embeddings/status` | `{scenes, lore, rules, version}` with stale counts |
| GET | `/api/embeddings/info` | Global `{modelId, dims, embeddingVersion}` |
| POST | `/api/campaigns/:id/embeddings/reindex` | Reindex stale + unversioned (`{type: 'scene'|'lore'|'all'}`) |

### Chapters (10 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET/PUT/POST | `/api/campaigns/:id/archive/chapters` | List / replace all / create (auto-ID `CH{NN}`) |
| PATCH/DELETE | `/api/campaigns/:id/archive/chapters/:chapterId` | Patch (allowlist fields) / delete |
| GET | `/api/campaigns/:id/archive/chapters/refit/preview` | Preview chapter refit (chapterFitting) |
| POST | `/api/campaigns/:id/archive/chapters/refit` | Apply chapter refit |
| POST | `/api/campaigns/:id/archive/chapters/seal` | Seal open + create new open |
| POST | `/api/campaigns/:id/archive/chapters/merge` | Merge two adjacent chapters |
| POST | `/api/campaigns/:id/archive/chapters/:chapterId/split` | Split at `atSceneId` into A/B halves |

### Timeline (3 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/timeline` | List (auto-migrates from `.facts.json` on first access) |
| POST | `/api/campaigns/:id/timeline` | Add manual event (auto-increment `tl_NNNN`) |
| DELETE | `/api/campaigns/:id/timeline/:eventId` | Remove event |

### Facts & Entities (4 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET/PUT | `/api/campaigns/:id/facts` | Semantic facts |
| GET | `/api/campaigns/:id/entities` | Entity list |
| POST | `/api/campaigns/:id/entities/merge` | Merge entities (survivor absorbs consumed.aliases, rewrites facts) |

### Backups (6 endpoints)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/campaigns/:id/backup` | Create (auto-skip if hash unchanged) |
| PATCH | `/api/campaigns/:id/backups/:ts` | Update backup label |
| GET | `/api/campaigns/:id/backups` | List sorted by timestamp desc |
| GET | `/api/campaigns/:id/backups/:ts` | Get meta + file list |
| POST | `/api/campaigns/:id/backups/:ts/restore` | Pre-restore safety backup + restore (allowlist-filtered) |
| DELETE | `/api/campaigns/:id/backups/:ts` | Delete backup directory |

### Assets (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/assets/upload` | Upload portrait (data URL, path-traversal guard) |
| POST | `/api/assets/download` | Download remote asset (502 on ENOTFOUND/ECONNREFUSED/ETIMEDOUT) |

### Overworld (3 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/overworld` | Get overworld data (404 if missing) |
| PUT | `/api/campaigns/:id/overworld` | Save overworld data |
| POST | `/api/campaigns/:id/overworld/generate` | LLM-generate (120s timeout, world_type allowlist, 8-anchor cap) |

### Transfer (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/export` | Export portable bundle (includes scenes parsed from archive.md + table files) |
| POST | `/api/campaigns/import` | Import bundle (ID collision check, background re-embed via setImmediate) |

### Divergence (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/campaigns/:id/divergence` | Get divergence register (v2 migration) |
| PUT | `/api/campaigns/:id/divergence` | Save divergence register |

### Rules RAG (4 endpoints)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/campaigns/:id/rules/embed` | Upsert rule chunk embedding |
| DELETE | `/api/campaigns/:id/rules/embed/:chunkId` | Delete a rule chunk embedding |
| POST | `/api/campaigns/:id/rules/search` | Vector search rule chunks (no MMR — rules not diversified) |
| POST | `/api/campaigns/:id/rules/reindex` | Reindex stale rule embeddings |

### LLM Proxy (1 endpoint)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/llm/proxy` | Transparent streaming proxy (forwards `{target, method, headers, body}`) |

### Embedding & System (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/embedding/runtime` | `{modelId, dims, provider, ready}` |
| GET | `/api/system/specs` | System spec readout (host, node, memory) |

### TTS (6 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/tts/status` | `{modelReady, initializing, voice, modelId, dtype}` |
| POST | `/api/tts/init` | Init TTS model (lazy load) |
| GET | `/api/tts/voices` | List voices |
| POST | `/api/tts/check-cache` | Check disk cache for a text+voice key |
| GET | `/api/tts/cached` | Fetch cached WAV |
| POST | `/api/tts/generate` | Synthesize WAV (returns audio blob) |

### Mods (2 endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET | `/api/mods` | Installed mod manifests (supports `?order=` load-order override) |
| GET | `/api/mods/:folder/*path` | Mod asset serving (installed dir → bundled dir fallback, realpath containment) |

### Scene Images (3 endpoints)
| Method | Path | Behavior |
|---|---|---|
| POST | `/api/scene-images/compose` | LLM-composed illustration brief (pure visual terms) |
| POST | `/api/scene-images/generate` | Generate via ComfyUI / OpenAI-compatible / OpenRouter |
| DELETE | `/api/scene-images/attachment` | Delete generated image attachment |

### Generic & Mod Tables (5 dynamic endpoints)
| Method | Path | Behavior |
|---|---|---|
| GET/PUT | `/api/campaigns/:id/locations` | Registry-driven (locationTable descriptor; more can register) |
| GET/PUT | `/api/campaigns/:id/mod-tables/:table` | Mod tables; GET runs legacy adoption (Phase 8.5) |
| DELETE | `/api/campaigns/:id/mod-data/:modId` | Purge a mod's campaign data files |

---

## Frontend → Backend Contract

`src/services/llm/apiClient.ts` calls → `src/lib/apiBase.ts` (`API_BASE`) → Vite proxy (`/api` → localhost:3001) in dev, or absolute `http://localhost:3001/api` in Electron.

| apiClient namespace | HTTP calls | Server route file |
|--------------------|------------|-------------------|
| `api.archive.*` | POST/GET/DELETE/PATCH `/campaigns/:id/archive/...` | archive.js |
| `api.chapters.*` | GET/POST/PATCH `/campaigns/:id/archive/chapters/...` | chapters.js |
| `api.facts.*` | GET `/campaigns/:id/facts` | facts.js |
| `api.timeline.*` | GET/POST/DELETE `/campaigns/:id/timeline/...` | timeline.js |
| `api.entities.*` | GET/POST `/campaigns/:id/entities/...` | facts.js |
| `api.settings.*` | GET/PUT `/settings` | settings.js |
| `api.backups.*` | POST/GET/PATCH/DELETE `/campaigns/:id/backup(s)/...` | backups.js |
| `api.vault.*` | GET/POST/PUT/DELETE `/vault/...` | vault.js |
| `api.rules.*` | POST/DELETE `/campaigns/:id/rules/...` | rules.js |
| `api.mods.*` | GET `/mods` | mods.js |
| `api.sceneImages.*` | POST/DELETE `/scene-images/...` | sceneImages.js |
| `api.tts.*` | GET/POST `/tts/...` | tts.js |

`src/store/campaignStore.ts` + `src/services/tables/genericAccessor.ts` call → same `API_BASE` for campaign CRUD, lore, NPCs, state save/load, locations (generic table), archive index, semantic facts, entities, chapters, backups, timeline, divergence, relationship memory, migrations ledger, mod tables.

`src/services/mods/modClient.ts` calls → `GET /api/mods` at bootstrap (unreachable endpoint = fault, never a crash).

`src/services/llm/llmFetch.ts` calls → `POST /api/llm/proxy` to forward provider calls (CORS dodge for NVIDIA etc.).

---

## State Management (Zustand)

```
useAppStore = settingsSlice + campaignSlice + chatSlice + uiSlice + mapSlice + worldLoreSlice
```

| Slice | Key State | Actions | Persistence |
|---|---|---|---|
| **settingsSlice** (458 lines) | `settings` (47 fields: 40 current + 7 legacy migration-only), `vaultStatus`, `vaultLoading` | loadSettings, updateSettings, preset CRUD, 7 endpoint selectors (story/image/summarizer/utility/auxiliary/vision), provider CRUD, vault lifecycle (incl. reset) | IndexedDB (`nn_settings`, providers encrypted) + server `PUT /settings` (500ms debounce) |
| **campaignSlice** (814 lines) | `activeCampaignId`, ledgers, suggestions, `archiveIndex`, `chapters`, `timeline`, `entities`, `semanticFacts`, `pinnedChapterIds`, mod tables, `context` (~65 fields), `inventoryItems`, `characterProfileData`, relationship memory, bookkeeping counters | ~45 actions (setActiveCampaign w/ commit flush, lore/NPC/location CRUD, mergeOrRename, timeline CRUD, pinChapter, context update, inventory/profile, mod tables, preOpBackup) | Server-only (4 debounced saves, 1s debounce) |
| **chatSlice** (616 lines) | `messages` (with attachments), `isStreaming`, `condenser`, `divergenceRegister`, `pinnedExcerpts`, `renameModalOpen/Text` | 30+ actions (message CRUD, condenser, divergence register 18 actions, pinned excerpts w/ token cap, attachments, rename) | Via shared `debouncedSaveCampaignState` |
| **uiSlice** (182 lines) | 16 boolean toggles (settingsOpen, drawerOpen, npcLedgerOpen, pcPanelOpen, locationLedgerOpen, blockViewOpen, backupModalOpen, loreCheckOpen, divergenceEntryOpen, deepArmed, diceRollModalOpen, lootRollModalOpen, troubleModalOpen, troubleLoading, pinnedMemoriesOpen, sceneImageModalOpen) + `pipelinePhase`, `streamingStats`, `contextScreen` (sys/world/eng/chpt/mem), armed roll/loot/oneshot/absoluteCommand, `composerInjection`, scene-image draft | 25+ toggle/set actions | Ephemeral (no persistence) |
| **mapSlice** | `overworldMap`, `isMapOpen/Loading`, `playerPosition`, `isPinMode`, `pendingPin` | toggleMap, generateMap, loadMap, saveMap, addPin, deletePin, ... | Server `/api/campaigns/:id/overworld` |
| **worldLoreSlice** | `worldLoreDrafts`, `worldLoreActiveDraftId`, `worldLoreModalOpen` | draft CRUD, toggle | localStorage (`nn_world_lore_drafts`, the ONLY slice using localStorage) |

**Cross-slice dependencies**:
- `settingsSlice` reads `activeCampaignId` (Campaign) for save context.
- `campaignSlice` reads `settings` (Settings), `messages`/`condenser`/`pinnedExcerpts` (Chat) via `CampaignDeps`; exports `debouncedSaveCampaignState` consumed by Chat; dynamically imports `commitPendingTurn` from `services/turn/pendingCommit`.
- `chatSlice` reads `activeCampaignId`/`context`/`archiveIndex` (Campaign) via `ChatDeps`.
- `uiSlice`, `mapSlice`, `worldLoreSlice` → no cross-slice reads (self-contained).

**Non-slice store modules**: `relationshipMemoryState.ts` (typed narrow read/write seam), `relationshipMemoryStore.ts` (server persistence), `campaignHydrator.ts` (parallel load + `context.arcs → mod.arc.arcs` table migration), `campaignStore.ts` (CampaignState + fetch wrappers).

---

## Data Flow: Single User Turn

```
1. User types message → ChatArea.tsx
2. commitPendingTurn() (single-flight; finalise PREVIOUS turn):
   a. Read chosen variant via swipeActiveIndex
   b. classifySceneStakes if GM omitted tag (tier-gated)
   c. Build commitState with frozen snapshot.messages (NEVER live)
   d. runPostTurnPipeline(commitState, callbacks, text, snapshotMessages, turnContext?):
      - Prologue tracks: autoProfile, digestClear
      - Promise.allSettled post-turn tracks:
        i. Archive track (inline): durable-commit verify/re-link (SNIPPET_MATCH_CHARS=80) →
           rateImportance (tier-gated) → api.archive.append → stamp sceneId → refresh
           index/timeline/chapters → bookkeeping gate
        ii. npcTrack: extractNPCNames (multi-pass) → validateNPCCandidates (tier-gated,
            fail-closed) → NPC-Update + NPC-Drives-Backfill (background, cooldown)
        iii. pressureTrack: scanPressure → buildPressurePatch → auto-archive stale /
             auto-restore mentioned
        (+ mod-registered compute tracks, e.g. mod.arc.compute)
      - Sequential tracks: agencyTick (heartbeat tier-gated), locationHeader,
        onStage (parsePresentHeader), repression (once-per-turn dice)
      - Post-commit tracks (9, background): chapterSeal, eventExtraction,
        inventoryScan, locationScan, pcDrift, profileScan, relationshipMemory,
        traitScan, travelAdvance (halt safety valve only)
   e. Auto-condense check (shouldCondense → computeTrimIndex → setCondensed)
   f. Clear swipeSet/pendingCommit/swipeActiveIndex
   g. clearPendingTurnSnapshot()

3. runTurn(state, callbacks, abortController) — 9 stages (turnStages.ts):
   a. resolveEngineRolls: rollEngines(context) → pre-rolled dice pool;
      armed roll/loot/oneshot resolved; Absolute Command revealed
   b. addUserTurnMessage (synchronous bubble)
   c. gatherTurnContext [phase: gathering-context] — parallel stages with 180s race backstop:
      - planner (LLM, tier-gated) + semantic-candidates (vector) + relationshipStances start together
      - archive-recall (RRF fusion; awaits semantic+planner), recommender (LLM),
        lore-rules (IDF+RRF), dynamic-elevation (scoped vector, tier-gated)
      - then sequentially: slotted RAG (pure), pinned chapters, deep-search (armed), semantic facts
   d. runIntroEngineStage (tier-gated NPC intros)
   e. runDirectorStage: travel facts + watchdog dossier + Director Brief
      (skipped entirely under Absolute Command)
   f. runPromptInterception + runFactPublication (mod hooks)
   g. buildTurnPayload [phase: building-prompt] — 5-block assembly with cache_control;
      final user message via contribution registry (10 built-ins + mod extensions)
   h. runGenerationStage [phase: generating] — sendMessage streaming via per-endpoint
      queue (/llm/proxy for CORS):
      - Tool calls via TOOL_REGISTRY (max 5 per turn)
      - 3-tier retry (retry → retry without tools → give up)
      - extractAndStripSceneStakes → build SwipeVariant → stamp swipeSet
      - capturePendingTurnSnapshot (freeze messages + cached payload + TurnContext)
      - persistTurnState (durable commit)
   i. Phase 'idle'

4. Player browses swipes (2-5) generated lazily from cached payload (swipeGeneration.ts)
5. Player clicks send again OR switches campaign → loop back to step 2
```

**Travel flow (WO 6.5, engine action — no LLM turn)**: departure from map / Places panel / composer TRAVEL → `departureComposer.composeDeparture` → `travelState.departur(e|MultiHop)` (worldmap mod pathfinder routes) → each `travelPress` = one day = one `role:'system'` checkpoint message → `arrive` / `abandonJourney` / `halt` (post-commit safety valve if location header names an unrelated place). `travelFacts` feeds the Continuity Director hard world facts (max 3).

---

## Server-Side Archive Pipeline (per scene append)

```
POST /api/campaigns/:id/archive
  → archiveService.appendScene():
    1. Synchronous: getNextSceneNumber + build markdown block + appendFileSync (serializes concurrent appends)
    2. Run 6 NLP heuristics inline:
       - extractIndexKeywords (proper nouns + quoted strings + [MEMORABLE:"..."] tags, cap 20)
       - extractNPCNames (6-pass, excludeNames list)
       - extractWitnessesHeuristic (bracketed dialogue OR user "talk to/ask/tell X")
       - extractKeywordStrengths (frequency + position + proximity bonus)
       - extractNPCStrengths (death=1.0, 3+ mentions OR dialogue=0.7, 2=0.5, 1=0.3)
       - estimateImportance (base 3, +3 death verbs, +2 MEMORABLE, +1 royalty/treasure/quest; clamp 1-10)
    3. withCampaignLock #1 — index write
    4. Fire-and-forget embedding (embedText → storeArchiveEmbedding, NOT awaited)
    5. Pre-compute entity name union for deferred timeline extraction
    6. withCampaignLock #2 — entity registry update + chapter auto-lifecycle
    7. Emit 'archive:written' event for deferred NLP pipeline
  → res.json({sceneId, ...})

  → nlpPipeline listener (setImmediate after res.json):
    1. If utilityConfig.endpoint AND npcNames.length > 0:
       a. extractWitnessesLLM (5000ms timeout, 1 attempt) → patchWitnesses
       b. extractTimelineEventsLLM (6000ms timeout, 2 attempts) OR regex fallback
          → normalizeEntityName → append to timeline store with auto-incremented tl_NNNN IDs
    2. Each write under withCampaignLock
    3. Errors logged and swallowed (deferred failures must not crash)
```

---

## Mods Platform (v2.0)

Narrative Engine 2.0 is a mod platform. Formerly hard-coded features (world map,
enemies, arc engine) now ship as bundled sandboxed mods; users can disable or
uninstall them without breaking the base app.

```
mods/<mod-id>/manifest.json      # folder-based manifests (flat *.mod.json files are rejected as legacy)
├── manifest keys: id, name, version, description, tables[], panels[], screens[],
│   windows[], tierEntries[], compute{file,hook,capabilities}, native{js,hooks},
│   interceptors[], contributions[], i18n/
└── server: modLoader.js validates (never throws) → client: modBootstrap registers
    translations + compute tracks + tier entries → sandbox runs compute JS in a
    worker with capability-scoped host APIs (hostFacade)
```

- **Bundled mods** (`public/bundled-mods/`): `worldmap` (terrain, pathfinder, travel, discoveries, encounters — powers the PixiJS map + travel), `enemies` (Phase 8 successor of the enemy system), `example-bundled-tone`, plus optional local `arc` mod at `mods/arc/` (arc tick as `mod.arc.compute` post-turn track).
- **Mod tables**: `mod.<modId>.<table>` names, persisted as `<campaignId>.mod-<modId>-<table>.json`.
- **Legacy adoption** (Phase 8.5): retired built-in tables (5 enemy files) are one-time copied into adopting mod tables, guarded by `<campaignId>.migrations.json`.
- **Contribution points**: prompt contributions, prompt interceptors, fact publishers, post-turn compute tracks, tier blocks, OOC sections, panels/screens/windows, header actions, service roles (`memory.recall`).
- **Discipline**: base app runs with zero mods (`test:base-app-gate`); uninstall path proven by e2e. See `docs/MODDING.md` + `docs/narrative-mod-api.d.ts`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19.2 + TypeScript 5.9 (strict) + Vite 8 + Tailwind 4 |
| State | Zustand 5 (6 slices) |
| Styling | Tailwind CSS 4 + @tailwindcss/typography |
| 2D Rendering | PixiJS 8 + pixi-filters (overworld map) |
| Markdown | react-markdown 10 + remark-gfm 4 |
| Icons | lucide-react |
| Backend | Express 5 (ESM), Node ≥ 20.19 (.nvmrc: Node 22) |
| Database | JSON files per campaign in `data/campaigns/<id>/` |
| Vector search | better-sqlite3 12 + sqlite-vec 0.1.9 (3 vec0 tables, cosine distance) |
| Embedding | @huggingface/transformers 4 (mxbai-embed-large-v1 q8, 1024 dims, LRU 512) |
| TTS | kokoro-js 1.2.1 (Kokoro-82M q8, af_heart default voice, SHA-256 WAV cache) |
| Token counting | js-tiktoken 1 |
| LLM streaming | Direct fetch to Ollama / OpenAI / Claude / Gemini via per-endpoint priority queue |
| LLM proxy | Server-side `/llm/proxy` route forwards provider calls to dodge browser CORS |
| Encryption | Node `crypto` AES-256-GCM + PBKDF2-SHA256 (600k iter password / 10k machine key) |
| Settings storage | idb-keyval 6 (IndexedDB, providers encrypted at rest) |
| Desktop | Electron (nodeIntegration:false, contextIsolation:true) |
| Testing | Vitest 4 + React Testing Library 16 + Supertest 7 (336 test files, ~4,240 tests) |
| E2E | Playwright 1.62 (8 specs in `e2e/`, headless Chromium) |
| Build | esbuild 0.28 (server bundle for Electron) + Vite 8 (frontend) |
| Linting | ESLint 9 flat config + typescript-eslint 8 + react-hooks + react-refresh |
| Shared core | @narrative/engine (file-linked `packages/engine`, platform-pure, boundary-gate enforced) |

---

## Engine Package (`packages/engine/`)

The `@narrative/engine` package is a **file-linked local dependency** (`"file:packages/engine"` in `package.json`). It is consumed by both `mainApp` (desktop) and `mobileApp` (mobile) for platform-pure shared logic.

**Purity enforcement**: `packages/engine/scripts/boundary-gate.mjs` runs as the `pretest` hook. It rejects imports of:
- `react`, `react-dom`
- `zustand`
- `@capacitor*`
- `idb-keyval`
- `better-sqlite3`
- `express`
- `node:*`

**tsconfig**: `lib: ["ES2022"]` only — NO DOM/Node libs. This enforces platform purity at the compiler level.

**Modules**:
- `src/json/jsonExtract.ts` — `extractJson`, `extractJsonRobust` (balanced-brace scan)
- `src/loot/lootEngine.ts` — Loot tree walker (`resolveLootDrop`)
- `src/retrieval/lexicalFusion.ts` — `fuseRRF` (k=60, Cormack et al. 2009), `computeIdf` (BM25 smoothing)
- `src/rolls/engineRolls.ts` — 3-gate dice engine; `src/rolls/diceTier.ts` — `mapTier`, `validateBands`
- `src/npc/dispositionGroups.ts` — hex envelopes/modifiers; `src/npc/hexVoiceGuide.ts` — `buildVoiceDirective`
- `src/panels/panelDescriptor.ts` — `createPanelRegistry` + `panelHooks.ts` — `runPanelHook`, `evaluatePanelComputed`
- `src/tables/tableDescriptor.ts` — `createTableRegistry`
- `src/mods/apiVersion.ts` — Mod API version constant
- `src/roles/roleIds.ts` — frozen `SERVICE_ROLE_IDS` (`memory.recall`)

**Exports** (package.json): `.` (barrel), `./roles/roleIds`, `./mods/apiVersion`.

**Type strategy**: Types are structural twins. The app keeps its own `src/types/` as source of truth; the engine declares only the fields it reads in `packages/engine/src/*/types.ts`. This avoids a circular dep where the engine imports app types.

---

## Key Files for Quick Reference

| Need to understand... | Read this file |
|---|---|
| "How does a turn work?" | `src/services/turn/turnOrchestrator.ts` + `turnStages.ts` |
| "How is a swipe committed?" | `src/services/turn/pendingCommit.ts` |
| "How is context built?" | `src/services/turn/contextGatherer.ts` + `src/services/payload/payloadBuilder.ts` |
| "How is the payload structured?" | `src/services/payload/{payloadBuilder,stable,volatile,world,history,budgetClaims,lodRenderer}.ts` + `contributions/` |
| "How are scenes archived?" | `server/routes/archive.js` + `server/services/archiveService.js` |
| "How does vector search work?" | `server/lib/vectorStore.js` + `server/lib/embedder.js` |
| "How does RRF fusion work?" | `src/services/archive-memory/recall.ts` + `packages/engine/src/retrieval/lexicalFusion.ts` |
| "How does NPC agency tick?" | `src/services/npc/agency/agencyEngine.ts` |
| "How do reaction menus work?" | `src/services/npc/reactionMenu.ts` + `reactionRepression.ts` |
| "How does the hex roll work?" | `src/services/npc/hexRoll.ts` |
| "How does the travel system work?" | `src/services/turn/travelState.ts` + `travelPress.ts` + `src/services/location/` |
| "How are scenes summarized?" | `src/services/saveFile/combinedSeal.ts` |
| "How do chapters auto-seal?" | `src/services/archive-memory/archiveChapterEngine.ts` + `server/services/chapterFitting.js` |
| "How does deep search work?" | `src/services/archive-memory/deepArchiveSearch.ts` |
| "How does TTS work?" | `server/lib/tts.js` + `src/components/tts/TtsPlaybackPanel.tsx` |
| "How does the vault work?" | `server/vault.js` |
| "What are the system rules?" | `src/services/rules/defaultRules.ts` |
| "What data does the store hold?" | `src/store/slices/` (7 slice files) |
| "How are NPCs detected?" | `src/services/npc/npcDetector.ts` |
| "How does the priority queue work?" | `src/services/llm/llmRequestQueue.ts` |
| "How do mods work?" | `docs/MODDING.md` + `server/lib/modLoader.js` + `src/services/mods/modBootstrap.ts` |
| "How is the world map generated?" | `src/services/mapEngine/worldGenerator.ts` + `public/bundled-mods/worldmap/` |
| "How is the divergence register rendered?" | `src/services/campaign-state/divergenceRegister.ts` |
| "How is the PC created?" | `src/components/character/AIGuidedCreationWizard.tsx` + `src/services/character/` |
| "How is settings state encrypted?" | `src/services/infrastructure/settingsCrypto.ts` |
| "What are the engine packages?" | `packages/engine/src/{json,loot,retrieval,rolls,npc,panels,tables,mods,roles}/` |
