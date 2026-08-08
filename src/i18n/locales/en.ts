/**
 * English — the source of truth for every translatable string in the app.
 *
 * ── Rules for this file ──────────────────────────────────────────────────
 * 1. Keys are flat and follow `domain.component.element`. Frozen in
 *    Upgrade/LanguageFramework/MASTERPLAN.md (Locked Decision 5). Do not
 *    invent a different shape — translators are working against this one.
 * 2. Values here must be BYTE-IDENTICAL to the English text that was in the
 *    component before extraction. An English user must not be able to tell
 *    the i18n framework landed (MASTERPLAN acceptance gate 4).
 * 3. Interpolation uses `{{name}}`. See `t()` in ../index.ts.
 * 4. Plurals use CLDR category suffixes on the SAME base key:
 *      'x.count.one' / 'x.count.few' / 'x.count.many' / 'x.count.other'
 *    Only `.other` is mandatory. English needs one/other; Russian needs
 *    one/few/many/other. See `t(key, { count })`.
 *
 * ── Coverage status ──────────────────────────────────────────────────────
 * PHASE 1 (wave 1) — complete: Header, SettingsModal, CampaignHub, LanguageSection.
 * PHASE 2 — everything else. Add keys here as files are extracted; untranslated
 * locales fall back to this file automatically, so partial coverage always ships.
 */
export const en = {
    // ── Header ───────────────────────────────────────────────────────────
    'header.drawer.open': 'Open context drawer',
    'header.drawer.close': 'Close context drawer',
    'header.title': 'Narrative Engine',
    'header.version.tooltip': 'Narrative Engine version {{version}}',
    'header.backup.tooltip': 'Create backup',
    'header.backup.aria': 'Create backup',
    'header.backup.label': 'Backup',
    'header.backup.toast.noChanges': 'No changes since last backup',
    'header.backup.toast.created': 'Backup created',
    'header.backup.toast.failed': 'Failed to create backup',
    'header.backups.tooltip': 'Backup manager',
    'header.backups.aria': 'Open backup manager',
    'header.backups.label': 'Backups',
    'header.character.tooltip': 'Character',
    'header.character.aria': 'Open character panel',
    'header.character.label': 'Character',
    'header.npcLedger.tooltip': 'NPC Ledger',
    'header.npcLedger.aria': 'Open NPC Ledger',
    'header.npcLedger.label': 'NPC Ledger',
    'header.enemyCompendium.tooltip': 'Enemy Compendium - scanner {{state}}',
    'header.enemyCompendium.aria': 'Open Enemy Compendium - scanner {{state}}',
    'header.enemyCompendium.label': 'Enemies: {{state}}',
    'header.enemyCompendium.state.on': 'ON',
    'header.enemyCompendium.state.off': 'OFF',
    'header.places.tooltip': 'Location Ledger',
    'header.places.aria': 'Open Location Ledger',
    'header.places.label': 'Places',
    'header.blockView.tooltip': 'Block View — one turn as a chain of blocks',
    'header.blockView.aria': 'Open Block View',
    'header.blockView.label': 'Blocks',
    'header.aiTier.tooltip': 'AI Tier: {{tier}} (click to cycle Lite → Pro → Max)',
    'header.aiTier.aria': 'AI Tier: {{tier}}, click to cycle',
    'header.pinned.tooltip': 'Pinned memories',
    'header.pinned.aria': 'Open pinned memories',
    'header.pinned.label': 'Pinned',
    'header.settings.tooltip': 'Settings',
    'header.settings.aria': 'Open settings',
    'header.settings.label': 'Settings',
    'header.exit.tooltip': 'Exit campaign',
    'header.exit.aria': 'Exit campaign',
    'header.exit.label': 'Exit',

    // ── Settings modal (shell) ───────────────────────────────────────────
    'settings.dialog.aria': 'Settings',
    'settings.title': '⚙ SETTINGS',
    'settings.version.tooltip': 'Installed Narrative Engine version',
    'settings.close.aria': 'Close settings',
    'settings.tab.providers': 'Providers',
    'settings.tab.presets': 'Presets',
    'settings.tab.global': 'Global',
    'settings.tab.advanced': 'Advanced',
    'settings.tab.debug': 'Debug',
    'settings.tab.extensions': 'Extensions',

    // ── Settings → Language ──────────────────────────────────────────────
    'settings.language.label': 'Interface Language',
    'settings.language.help': 'Changes menus and buttons only. Anything not yet translated stays in English.',
    'settings.language.contribute': 'Missing your language? See docs/TRANSLATING.md — one file, no tools needed.',
    'settings.language.pseudoWarning': 'Layout test only — not a real language. Use it to spot text that overflows its button.',
    'settings.language.complete': 'Fully translated.',
    // Plural reference example. English needs one/other; Russian additionally
    // needs few/many. Only `.other` is mandatory — a locale that defines just
    // `.other` still renders correctly. Call as: t('...untranslated', { count }).
    'settings.language.untranslated.one': '{{count}} item still shows in English.',
    'settings.language.untranslated.other': '{{count}} items still show in English.',

    // ── Settings → Extensions ────────────────────────────────────────────
    'settings.extensions.title': 'Extensions',
    // Locked decision D4: enablement is global, not per-campaign. Said plainly, once.
    'settings.extensions.scope': 'Switching a module off applies to every campaign, including saves already in progress.',
    'settings.extensions.reset': 'Reset',
    'settings.extensions.toggle.aria': 'Enable {{name}}',
    'settings.extensions.mod.meta': 'v{{version}} · {{file}}',
    'settings.extensions.builtin.title': 'Built-in',
    'settings.extensions.builtin.help': "The engine's own contributions to each prompt. Switching one off removes just that block — nothing else changes.",
    'settings.extensions.mods.title': 'Installed mods',
    'settings.extensions.mods.help': 'Mod files are read from the mods folder at the app root. Drop one in and rescan — no restart needed.',
    'settings.extensions.mods.rescan': 'Rescan',
    'settings.extensions.mods.loading': 'Reading the mods folder…',
    'settings.extensions.mods.error': 'Could not reach the server to list mods. Play is unaffected; previously loaded mods stay as they were.',
    'settings.extensions.mods.empty': 'No mods installed. Add a .mod.json file to the mods folder, then press Rescan.',
    'settings.extensions.guide.show': 'Guide to making a mod',
    'settings.extensions.guide.hide': 'Hide guide',
    // The path stays out of the translatable string — a file path is not prose and must not be
    // localised, or a translator's copy of it stops resolving to a real file.
    'settings.extensions.guide.path': 'You can also read the full document at {{path}} in the app folder.',
    'settings.extensions.faults.title': 'Mod faults',
    'settings.extensions.faults.help': 'These files could not run safely, so their changes were not applied. Fix the reason shown and rescan.',
    'settings.extensions.faults.runtime': 'A runtime fault disables a mod for this turn; repeated failures disable it until the app reloads.',
    // Phase 6.1 — the native-tier trust dialog (TRUST.md §D). The dialog title
    // and the two action button labels are the only translatable strings; the
    // warning body is pasted verbatim in NativeTrustDialog.tsx and MUST NOT be
    // localised (§D: "Phase 6.1 must paste it without editing").
    'settings.extensions.nativeTrust.title': 'Enable native mod?',
    'settings.extensions.nativeTrust.confirm': 'Enable native mod',
    'settings.extensions.nativeTrust.cancel': 'Cancel',
    // Phase 6.1 — mod row metadata. The tier badge labels map to the three
    // tiers from TRUST.md §A. `state.enabled`/`state.disabled` are the row's
    // current enablement summary; `state.rejected` is shown for a mod whose
    // load or runtime faults match this mod's file.
    'settings.extensions.mod.tier.declarative': 'declarative',
    'settings.extensions.mod.tier.sandboxed': 'sandboxed',
    'settings.extensions.mod.tier.native': 'native',
    'settings.extensions.mod.author': 'by {{author}}',
    'settings.extensions.mod.folder': 'Folder: {{folder}}',
    'settings.extensions.mod.settings': 'Settings',
    'settings.extensions.mod.faultInline': 'This mod could not run: {{reason}}',

    // ── Campaign hub ─────────────────────────────────────────────────────
    'hub.import.tooltip': 'Import Campaign',
    'hub.settings.tooltip': 'Settings',
    'hub.worldLore.tooltip': 'Create World Lore',
    'hub.tagline': 'AI Game Master System',
    'hub.brand.lead': 'Narrative',
    'hub.brand.accent': 'Nexus',
    'hub.subtitle': 'Choose your world. Shape its fate.',
    'hub.delete.confirm': 'Delete this campaign? All data — chat history, lore, saves — will be lost forever.',
    'hub.delete.cancel': 'Cancel',
    'hub.delete.confirmAction': 'Delete',
    'hub.export.failed': 'Export failed',
    'hub.import.success': '"{{name}}" imported — search index rebuilding in background',
    'hub.import.failed': 'Import failed — invalid campaign file',

    // ── Tier blocks (WO-P5-01 §4 Step 5) ─────────────────────────────────
    // Name + description for each of the 27 TierFeature ids. The block view
    // (WO-P5-02) renders these; the declaration table in aiTier.ts holds the
    // English source-of-truth strings, and these keys let translators cover them.
    'tierblock.introEngine.name': 'Character Intro Engine',
    'tierblock.introEngine.description': 'Rolls a one-line introduction tag for newly mentioned NPCs before the GM writes the reply.',
    'tierblock.planner.name': 'Archive Planner',
    'tierblock.planner.description': 'Asks a utility model which past scenes to recall before the main turn runs.',
    'tierblock.expandQuery.name': 'Query Expansion',
    'tierblock.expandQuery.description': 'Expands short user messages into richer retrieval queries for semantic archive search.',
    'tierblock.reranker.name': 'Semantic Reranker',
    'tierblock.reranker.description': 'Re-ranks archive search results with a utility model after the first-pass retrieval.',
    'tierblock.archiveFunnel.name': 'Chapter Recall Funnel',
    'tierblock.archiveFunnel.description': 'Uses a multi-round chapter funnel to find the most relevant sealed-chapter scenes.',
    'tierblock.deepScan.name': 'Deep Archive Search',
    'tierblock.deepScan.description': 'Runs a two-round LLM deep scan across sealed chapters when standard recall is not enough.',
    'tierblock.recommender.name': 'Context Recommender',
    'tierblock.recommender.description': 'Asks a utility model which world-state fields the GM should focus on this turn.',
    'tierblock.importanceRating.name': 'Scene Importance Rating',
    'tierblock.importanceRating.description': 'Rates each committed scene 1–5 so the archive can prioritise high-stakes events.',
    'tierblock.witnessAux.name': 'Witness Capture (Auxiliary)',
    'tierblock.witnessAux.description': 'Reserved tier slot for an auxiliary witness-capture pass. No call site exists yet — neither a pipeline step nor a button.',
    'tierblock.npcValidate.name': 'NPC Name Validation',
    'tierblock.npcValidate.description': 'Validates extracted NPC names with a fail-closed LLM check before adding them as suggestions.',
    'tierblock.npcProfileGen.name': 'NPC Profile Generation',
    'tierblock.npcProfileGen.description': 'Reserved tier slot for LLM-generated NPC profiles. No call site exists yet — neither a pipeline step nor a button.',
    'tierblock.npcUpdate.name': 'NPC Profile Update',
    'tierblock.npcUpdate.description': 'Background LLM call that refreshes known NPC profiles from the latest scene text.',
    'tierblock.drivesBackfill.name': 'NPC Drives Backfill',
    'tierblock.drivesBackfill.description': 'Backfills missing goal/want records for known NPCs so the agency engine can act on them.',
    'tierblock.profileScan.name': 'Character Profile Scan',
    'tierblock.profileScan.description': 'Periodically scans chat history to keep the player character sheet and active traits current.',
    'tierblock.inventoryScan.name': 'Inventory Scan',
    'tierblock.inventoryScan.description': 'Periodically scans chat history to keep the player inventory list current.',
    'tierblock.locationScan.name': 'Location Scan',
    'tierblock.locationScan.description': 'Periodically scans chat history to resolve the current place and merge location ledger entries.',
    'tierblock.locationEnrich.name': 'Location Enrichment',
    'tierblock.locationEnrich.description': 'Enriches location ledger entries with features and connections drawn from the scene.',
    'tierblock.sealChapter.name': 'Chapter Auto-Seal',
    'tierblock.sealChapter.description': 'Seals a chapter and writes its summary when it reaches the scene-count soft cap.',
    'tierblock.sceneStakesClassify.name': 'Scene Stakes Classifier',
    'tierblock.sceneStakesClassify.description': 'Classifies the stakes of a committed scene when the GM omitted the tag, so downstream systems can react.',
    'tierblock.heartbeatTick.name': 'NPC Agency Heartbeat',
    'tierblock.heartbeatTick.description': 'Runs the off-screen NPC agency tick that pursues goals, drifts hexes, and collides with rivals.',
    'tierblock.timeskipRun.name': 'Timeskip Narration',
    'tierblock.timeskipRun.description': 'Simulates off-screen NPC life and narrates the return when the player skips weeks at once.',
    'tierblock.arcTick.name': 'Arc Engine Tick',
    'tierblock.arcTick.description': 'Rolls tempo per active arc, advances the ladder, and folds the surface line into the next GM call.',
    'tierblock.arcSpawn.name': 'Arc Injector Spawn',
    'tierblock.arcSpawn.description': 'Fires a new systemic-conflict arc from the Arc Injector button. The press is the gate; the tier matrix value is never read.',
    'tierblock.directorBrief.name': 'Director Brief',
    'tierblock.directorBrief.description': 'Asks a utility model for scene directives that steer the next GM reply.',
    'tierblock.lodDynamicElevation.name': 'Dynamic Scene Elevation',
    'tierblock.lodDynamicElevation.description': 'Elevates synopsis-tier scenes verbatim below the cache boundary when they are highly relevant.',
    'tierblock.lodSlottedRag.name': 'Slotted RAG Snippets',
    'tierblock.lodSlottedRag.description': 'Injects one-line snippets from synopsis-tier scenes that had search hits but were not elevated.',
    'tierblock.enemyDiscovery.name': 'Enemy Discovery',
    'tierblock.enemyDiscovery.description': 'Scans committed scenes for new enemy entries and adds them to the compendium under a cooldown.',

    // ── Block view (WO-P5-02) ───────────────────────────────────────────
    // Modal chrome and section labels only. Block names and descriptions come
    // from registry metadata (the three list() methods), never from here.
    'blockview.dialog.aria': 'Block View',
    'blockview.title': 'ONE TURN, LEFT TO RIGHT',
    'blockview.standfirst': 'Every block the turn runs, in the order the registries publish them. Switch one off and the next turn skips it. Blocks stacked in the same column run concurrently.',
    'blockview.close.aria': 'Close Block View',
    'blockview.legend.engine': 'ENGINE',
    'blockview.legend.engine.help': 'Deterministic code — no model',
    'blockview.legend.model': 'MODEL',
    'blockview.legend.model.help': 'Calls a language model',
    'blockview.legend.locked': 'LOCKED',
    'blockview.legend.locked.help': 'A track whose absence would lose data, not a feature',
    'blockview.legend.manual': 'MANUAL',
    'blockview.legend.manual.help': 'Fires from a button, not the turn pipeline',
    'blockview.legend.unwired': 'UNWIRED',
    'blockview.legend.unwired.help': 'Reserved slot — no call site exists yet',
    'blockview.legend.off': 'OFF',
    'blockview.legend.off.help': 'Switched off — will not run next turn',
    'blockview.hint.scroll': 'Scroll sideways \u2192',
    'blockview.section.tier': 'Tier features',
    'blockview.section.tier.help': 'Pipeline stages gated by the active tier. A toggle writes an explicit override; the tier preset itself is shown read-only.',
    'blockview.section.contrib': 'Prompt contributions',
    'blockview.section.contrib.help': 'Blocks assembled into the final user message below the cache boundary. Built-ins and installed mods.',
    'blockview.section.tracks': 'Post-turn tracks',
    'blockview.section.tracks.help': 'Background work that runs after the scene commits. Tracks are not in the tier matrix; absent means enabled.',
    'blockview.empty': 'No blocks registered.',
    'blockview.tier.label': 'Tier',
    'blockview.tier.help': 'Read-only. Cycle it from the header.',
    'blockview.preset.label': 'Apply preset',
    'blockview.preset.help': 'Lights blocks on and off to show what a tier costs. Writes explicit switch positions into moduleEnabled — does not change the tier.',
    'blockview.preset.lite': 'Lite',
    'blockview.preset.pro': 'Pro',
    'blockview.preset.max': 'Max',
    'blockview.preset.reset': 'Clear overrides',
    'blockview.preset.reset.help': 'Removes every explicit override so the tier preset decides again.',
    'blockview.toggle.aria': 'Toggle {{name}}',
    'blockview.badge.on': 'ON',
    'blockview.badge.off': 'OFF',
    'blockview.badge.locked': 'LOCKED',
    'blockview.badge.manual': 'MANUAL',
    'blockview.badge.unwired': 'UNWIRED',
    'blockview.link.extensions': 'Open Extensions tab',
    'blockview.link.extensions.help': 'The Extensions tab toggles the same modules; this view shows them in turn order.',
} as const;

/** Every valid translation key. Locales are checked against this. */
export type TranslationKey = keyof typeof en;
