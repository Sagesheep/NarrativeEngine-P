# Phase 9.3 recovery inventory

Source boundary: `02230ee..narrative-p/main`.

This inventory records the disposition of every contributor-relevant file and the non-contributor
hunks present in the recovery range. The current branch already contains the Phase 8 enemy extraction;
PR #40 is therefore a data/template recovery, not a second enemy runtime.

## Disposition summary

| Contribution | Current destination | Disposition |
|---|---|---|
| Ability & Power Compendium | `mods/ability-compendium/` | Recovered as an optional Generation 1 mod. Tables and editor workflows are retained; old flat manifest, header launch, declarative lookup, raw context, and host capability calls are adapted to current tables, nested screens, and a native interceptor. |
| Ability Compendium examples/guides | `Example_Setup/Ability Compendium/` | Recovered unchanged as Tier 0 authoring/reference data, with the non-SRD full reference excluded by `.gitignore`. |
| Monster compendium template | `Example_Setup/World_compendium/monster_compendium_template.json` | Recovered as a Tier 0 data-only preset. No enemy-specific executable code is added. |
| Enemy runtime from PR #40 ancestry | `public/bundled-mods/enemies/` | Already accounted for by the authoritative Phase 8 bundled enemy mod. No duplicate runtime, store slice, payload block, or core UI was restored. |
| Generic host support | Existing Generation 1 tables, isolated screens, native interceptor, lifecycle and mod context | Existing public API is sufficient. No feature-specific core capability was added. |

## Ability Compendium path-level inventory

| Upstream path | Classification | Disposition |
|---|---|---|
| `mods/ability-compendium.mod.json` | feature manifest | Re-homed to `mods/ability-compendium/manifest.json`; added `apiVersion: 1` and native interceptor; removed pre-freeze lookup/header-launch/screen capability fields. |
| `mods/ability-compendium.compute.js` | feature runtime | Re-homed unchanged in role, then adapted to `ctx.data.playerCharacter`, `ctx.data.inventory`, `ctx.data.npcLedger`, and awaited own-table writes. Removed raw `ctx.data.context` and `setCharacterProfileData` access. |
| `mods/ability-compendium.screen.js` | feature UI | Re-homed and retained as an isolated table editor. Removed unsupported campaign/file capabilities; retained JSON import/export using browser APIs. The old automatic character-sheet import is explicitly superseded because Gen 1 does not expose arbitrary ability strings. |
| `mods/ability-compendium.native.js` | feature runtime | New Gen 1 bridge. Replaces the old declarative `lookup` integration with a native interceptor over the module-owned `prompt-index` table. |
| `mods/ABILITY_COMPENDIUM_MODULE.md` | documentation | Rewritten for folder-per-mod, nested screens, table persistence, Gen 1 limitations, and portability. Eric's workflow/data provenance is retained. |
| `Example_Setup/Ability Compendium/Dungeons and Dragons 5e 2024/README.md` | documentation | Recovered. |
| `Example_Setup/Ability Compendium/Dungeons and Dragons 5e 2024/srd_5_2_1_5e_compatible_ability_compendium.json` | Tier 0 reference data | Recovered; SRD-compatible reference only. |
| `Example_Setup/Ability Compendium/ORIGINAL_MAGIC_SYSTEM_TEMPLATE_GUIDE.md` | Tier 0 documentation | Recovered. |
| `Example_Setup/Ability Compendium/SIMULATION_ROOM_CROSS_SYSTEM_COMPENDIUM_NOTES.md` | Tier 0 documentation | Recovered. |
| `Example_Setup/Ability Compendium/original_magic_system_ability_compendium_template.json` | Tier 0 preset | Recovered as portable authoring template. |
| `Example_Setup/Ability Compendium/simulation_room_ability_compendium.json` | Tier 0 preset | Recovered. |
| `Example_Setup/Ability Compendium/simulation_room_cross_system_ability_compendium.json` | Tier 0 preset | Recovered. |
| `src/services/mods/__tests__/abilityCompendiumModule.test.js` | feature contract test | Rewritten for promoted Gen 1 context, native interceptor behavior, and disable teardown. |
| `server/__tests__/abilityCompendiumContract.test.js` | feature contract test | Added. Covers real loader install/reload shape and clean absence after uninstall. |
| `.gitignore` D&D full-reference hunk | provenance/security | Retained as a current `.gitignore` rule; the non-SRD full reference is not distributable. |

## Enemy / monster disposition

`4ba0c7a` / PR #40 adds only `Example_Setup/World_compendium/monster_compendium_template.json`.
The template is data-only and uses the Phase 8 enemy schema fields. It is available without enabling
an executable enemy feature.

The Phase 8 runtime remains authoritative in `public/bundled-mods/enemies/` with its five owned
mod tables, validator, UI, migration, interceptor, OOC sections, and fact publication. No PR #40
ancestor was allowed to reintroduce an enemy core route, store slice, turn track, payload contribution,
or application component.

## Non-contributor and superseded files in the recovery range

The range also contains later upstream work and PR #43's pre-freeze host integration. These hunks were
inventoried and deliberately not restored:

- `docs/MODDING.md`: the current branch's Phase 9.1/9.2 documentation is newer and remains authoritative;
  the module-specific guide records the recovery substitutions.
- Old PR #43 lookup/header/screen host wiring in `server/lib/modLoader.js`,
  `server/__tests__/modLoader.test.js`, `server/__tests__/modLoaderScreens.test.js`,
  `src/services/mods/modAdapter.ts`, `src/services/mods/modBootstrap.ts`,
  `src/services/mods/modTypes.ts`, `src/services/mods/screenApiTypes.ts`,
  `src/services/mods/__tests__/modAdapter.test.ts`,
  `src/services/mods/__tests__/modApi.d.ts.test.ts`,
  `src/components/Header.tsx`, `src/components/ModHeaderLaunchers.tsx`,
  `src/components/__tests__/ModHeaderLaunchers.test.ts`,
  `src/components/settings-modal/ModScreenHost.tsx`,
  `src/components/settings-modal/ModScreens.tsx`,
  `src/components/settings-modal/ScreenFrame.tsx`,
  `src/components/settings-modal/__tests__/ScreenFrame.r1.test.tsx`,
  `src/hooks/useChatOperations.ts`, `src/services/payload/contributions/builtins.ts`,
  `src/services/payload/payloadBuilder.ts`, `src/services/turn/turnOrchestrator.ts`,
  `src/services/turn/turnStages.ts`, and `src/components/hooks/useSceneContinue.ts`.
  These were either superseded by the current Generation 1 surfaces or were not feature-specific
  support required by the recovered module. The current branch's core contains no Ability Compendium
  name or route.
- Unrelated upstream work in the range was excluded from this Eric recovery: vault recovery and
  OpenRouter image support (`server/vault.js`, `server/routes/vault.js`, `server/__tests__/vault.test.js`,
  `src/components/VaultUnlockModal.tsx`, `server/services/imageProvider.js`,
  `server/services/openRouterImage.js`, `src/utils/openRouterImage.ts`, and their unrelated tests).
- Other unrelated changed tests/assets in the merge range (`server/__tests__/sceneImages.test.js`,
  `src/components/block-view/__tests__/renderArtifact.test.ts`,
  `src/components/hooks/useSceneContinue.ts`, `src/services/npc-generation/__tests__/portrait.test.ts`,
  `src/services/npc-generation/portrait.ts`, `src/store/slices/settingsSlice.ts`,
  `src/types/llm.ts`) remain governed by the current branch, not by this recovery.

## Verification mapping

- Loader install/reload/uninstall: `server/__tests__/abilityCompendiumContract.test.js`.
- Compute, public-field projection, prompt-index generation, interceptor, and disable teardown:
  `src/services/mods/__tests__/abilityCompendiumModule.test.js`.
- All shipped manifests: `server/__tests__/shippedModsLoad.test.ts`.
- Base application subtraction: existing Phase 8.6 gate and current core source scans; no new
  feature-specific core imports were added by this phase.
- Tier 0 portability: all recovered JSON assets are standalone JSON and do not require the executable
  Ability or Enemy modules to parse as files.
