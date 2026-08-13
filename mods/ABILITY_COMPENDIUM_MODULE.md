# Ability & Power Compendium module

This packages Eric Song's Ability & Power Compendium as an optional, removable Narrative Engine
module. It is not compiled into core. Install or update these four files together in
`mods/ability-compendium/`:

- `manifest.json`
- `ability-compendium.compute.js`
- `ability-compendium.native.js`
- `ability-compendium.screen.js`

Open **Settings > Extensions**, rescan, enable **Ability & Power Compendium**, then expand the
module-owned **Open Ability & Power Compendium** screen. Disabling the module removes its prompt
interceptor and screen while preserving its namespaced campaign tables.

## Preserved workflows

- Canonical abilities with CRUD, search, filters, aliases, tags, JSON import/export, and configurable terminology.
- PC/NPC ownership, personal variants, mastery, upgrades, training progress, and prompt controls.
- Charges, cooldowns, uses, active effects, sustained powers, stances, and manual runtime controls.
- Pending discovery review with evidence, **Add all**, **Dismiss all**, and optional AI-assisted recent-play scanning.
- Inventory-granted powers, enemy-action origins, lore-check status, interaction tags, and counter tags.
- Exact-name and alias prompt injection from the generated `prompt-index` table.

Prerequisites and class lists are guidance only. The module never forbids an assignment or attempts
to enforce a campaign ruleset.

## Module data and security

All data is campaign-persistent and namespaced under `mod.ability-compendium.*`. The six tables are
`abilities`, `assignments`, `runtime`, `proposals`, `config`, and `prompt-index`. Disabling the
module freezes its data; explicit uninstall/delete-data policy controls removal. The isolated
manager screen has no network, DOM, raw-store, or credential access.

Gen 1 screens receive theme, resize, and the declaring module's tables only. The old PR's raw
character-sheet capability and host download capability are not part of the frozen screen API.
JSON import/export remains available through the browser file picker/download. Character-sheet import
is intentionally unavailable because Gen 1 does not expose arbitrary ability strings in the public
character-sheet projection; users can use JSON import, manual assignments, or AI discovery instead.

## Discovery timing

**Queue AI scan** marks the next committed post-turn pass; it does not make an unreviewed change.
Automatic scans are optional. Accepted proposals update the module's own abilities and assignments
only after explicit review.

## Generation 1 recovery note

The old flat manifest, header launch, declarative `lookup` field, raw context access, and feature-
specific core wiring were superseded by the frozen Generation 1 contract. Prompt lookup is now a
native interceptor over the module's own `prompt-index` table; the editor lives in the supported
nested screen surface; and no core route, store slice, payload block, or UI component names this
compendium.

## Compendium examples

The portable authoring template and guide live in:

`Example_Setup/Ability Compendium/original_magic_system_ability_compendium_template.json`
`Example_Setup/Ability Compendium/ORIGINAL_MAGIC_SYSTEM_TEMPLATE_GUIDE.md`

The SRD-compatible D&D structure reference lives in:

`Example_Setup/Ability Compendium/Dungeons and Dragons 5e 2024/srd_5_2_1_5e_compatible_ability_compendium.json`

The separate full-reference D&D compendium is not a distributable project asset and must not be
published.
