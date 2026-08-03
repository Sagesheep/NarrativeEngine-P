# Ability & Power Compendium module

This packages the Ability & Power Compendium as an optional Narrative Engine extension. It is not
compiled into the core application. Install or update these three files together in `mods/`:

- `ability-compendium.mod.json`
- `ability-compendium.compute.js`
- `ability-compendium.screen.js`

Open **Settings > Extensions**, rescan, enable **Ability & Power Compendium**, then select
**Open Ability & Power Compendium**.

While the module is enabled, the campaign header also shows an **Abilities** shortcut. Disabling the
module in Extensions removes that shortcut immediately; no Ability Compendium navigation is built
into the core engine.

## What it retains

- Canonical abilities with CRUD, search, filters, aliases, tags, JSON import/export, and configurable
  campaign terminology.
- PC and NPC ownership, personal variants, mastery, upgrades, training progress, and prompt controls.
- Charges, cooldowns, uses, active effects, sustained powers, stances, and manual runtime controls.
- Pending discovery review with evidence, character-sheet import, **Add all**, **Dismiss all**, and an
  optional AI-assisted recent-play scan.
- Inventory-granted powers, enemy-action origins, lore-check status, interaction tags, and counter tags.
- Exact name/alias prompt injection from a compact generated index.

Prerequisites and class lists are guidance only. The module never forbids an assignment or attempts
to enforce a campaign ruleset.

## Module data and security

All data is campaign-persistent and namespaced under `mod.ability-compendium.*`. The six tables are
`abilities`, `assignments`, `runtime`, `proposals`, `config`, and `prompt-index`. Disabling the prompt
contribution leaves the data intact; uninstalling the module removes its owned tables through the
normal extension lifecycle.

The isolated manager screen is the only UI. Its declared read capabilities receive limited host
projections for character names/IDs, the player sheet's ability strings, inventory entries, and the
last 12 play messages. The iframe has no network access. Export downloads are performed by the host.

## Discovery timing

Character-sheet import creates review proposals immediately. **Queue AI scan** marks the next
committed post-turn pass; it does not make an unreviewed change. Automatic scans are optional.
Accepted character-sheet entries are removed from the sheet during the next committed post-turn
pass, after their compendium data has been saved.

## Compendium examples

The portable authoring template and guide live in:

`Example_Setup/Ability Compendium/original_magic_system_ability_compendium_template.json`

`Example_Setup/Ability Compendium/ORIGINAL_MAGIC_SYSTEM_TEMPLATE_GUIDE.md`

The SRD-compatible D&D structure reference lives in:

`Example_Setup/Ability Compendium/Dungeons and Dragons 5e 2024/srd_5_2_1_5e_compatible_ability_compendium.json`

The separate full-reference D&D compendium is not a distributable project asset and must not be
published.
