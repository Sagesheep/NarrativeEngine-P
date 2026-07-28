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
} as const;

/** Every valid translation key. Locales are checked against this. */
export type TranslationKey = keyof typeof en;
