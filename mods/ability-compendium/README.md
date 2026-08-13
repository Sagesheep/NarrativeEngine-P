# Ability & Power Compendium module

This folder is a complete Narrative Engine 2.x module. Copy the whole
`ability-compendium` directory into the engine's `mods` directory, restart the
engine, and enable **Ability & Power Compendium** in **Extensions**.

The enabled module adds an **ABILITIES** button to the main header. Disabling the
module removes that button and its floating manager window. Campaign records live
in six module-owned tables, so existing data remains portable and separate from
the engine core.

The module includes:

- canonical definitions, search, terminology overrides, JSON import/export;
- PC/NPC assignments, variants, mastery, progression, runtime state;
- reviewed character-sheet and post-turn discovery proposals;
- inventory, enemy, lore, interaction, and counter classifications;
- prompt injection only when an ability name or alias appears in recent play.

Prerequisites are descriptive guidance. The module does not forbid assignments or
enforce class, species, or ruleset eligibility.

Example compendiums and the original-magic-system template are in
`Example_Setup/Ability Compendium` at the repository root. The D&D example is the
SRD-compatible reference only; the non-SRD full rules compendium is not published.
