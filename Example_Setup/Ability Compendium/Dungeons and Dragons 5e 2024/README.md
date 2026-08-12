# SRD 5.2.1 Ability Compendium Reference

`srd_5_2_1_5e_compatible_ability_compendium.json` is an importable Narrative
Engine Ability Compendium built from material available under SRD 5.2.1.

It is included primarily as a reference implementation so campaign authors can
see how a complete version 2 Ability Compendium JSON file is structured,
including:

- the top-level `schemaVersion`, `terminology`, and `abilities` blocks;
- campaign-specific display labels mapped to stable cross-system keys;
- canonical spell, skill, feat/perk, and species-trait definitions;
- costs, activation, range, duration, prerequisites, tags, and source fields;
- mastery, upgrade, interaction, counter, lore-check, and inventory-link fields.

The file contains:

- 339 SRD spells;
- all 18 skills;
- all 17 feats included in SRD 5.2.1, classified as perks;
- traits and trait options for the nine SRD species;
- only SRD-safe spell names where SRD 5.2.1 renamed a core-book spell.

It does not contain Aasimar or other material excluded from SRD 5.2.1.

## Terminology

The top-level `terminology` block supplies D&D-oriented display labels. For
example, the Engine displays `innate` as **Species Trait**, `item-granted` as
**Magic Item Feature**, and `enemy-action` as **Monster Action**.

These labels are presentation only. They do not impose D&D eligibility rules,
restrict assignments, or replace the stable Engine keys. Authors can edit the
labels directly or use the Compendium's **Terminology** tab.

## Import notes

Importing a compendium replaces the campaign's current canonical ability
library. Export the existing library before importing this reference.

The file contains definitions only. It does not automatically assign every
spell, perk, skill, or trait to a character. Character ownership remains
player-controlled through assignment and discovery review.

## Creative Commons attribution

This work includes material from the System Reference Document 5.2.1
("SRD 5.2.1") by Wizards of the Coast LLC, available at
https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative
Commons Attribution 4.0 International License, available at
https://creativecommons.org/licenses/by/4.0/legalcode.
