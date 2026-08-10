/**
 * Phase 7.5 — the OOC section registry.
 *
 * ## Why this exists (`ROLES.md` §7.1, "thread that tears #1")
 *
 * The Ask-GM brief is a **second prompt-assembly path**. It never went through
 * the contribution registry: `buildOocContext` walks a fixed list of sections —
 * context facts, the PC sheet, inventory, notebook, places, characters,
 * **enemies**, verified facts, recent transcript — with its own mention matcher,
 * its own caps and its own excerpting. `OocSourceKind` even carried `'enemy'` as
 * a member of a string union.
 *
 * That made the enemy extraction quietly wrong in a way no gate would catch:
 * when the subsystem leaves, the OOC brief silently loses its enemy sections
 * and a union member becomes dead. `ROLES.md` flagged it loudly because Phase
 * 7.9.4's grep gate cannot see it — that gate walks the *payload* path, and this
 * is not the payload path.
 *
 * ## What this is, and what it is not
 *
 * **Not a role.** N sections can each contribute; nothing is arbitrated; core
 * consumes a list, not an answer. `ROLES.md` §1's test says that is additive,
 * and additive things get a registry, not a role.
 *
 * It is the contribution pattern applied to the second assembly path: a section
 * renders its own lines and its own `OocSource` rows, and `buildOocContext`
 * splices them in without knowing what they describe.
 *
 * ## Where registered sections land
 *
 * At one **extension point**, after the NPC ledger and before verified campaign
 * facts — exactly where the enemy sections sit today, which is what keeps the
 * brief byte-identical through this refactor. Core's own sections keep their
 * fixed order; registered sections order among *themselves* by `order`, ties
 * broken by registration index.
 *
 * One extension point rather than an anchor per core section is deliberate:
 * every section that has ever wanted to exist here describes campaign entities
 * the player can ask about, and they all belong in the same neighbourhood as the
 * ledgers. A second point can be added when something needs one; inventing five
 * now would be guessing.
 *
 * ## Absence
 *
 * No registered sections means no lines and no sources — the brief is shorter,
 * not broken (Phase 7.5 §3). A section that throws is skipped with a warning and
 * the rest of the brief still renders: an Ask-GM answer degraded by one missing
 * section beats an Ask-GM that fails.
 */
import type { OocCampaignSnapshot, OocSource } from './types';

/** Everything a section is given. Read-only; a section must not mutate the snapshot. */
export interface OocSectionContext {
    /** The read-only campaign snapshot the chat shell supplied. */
    readonly snapshot: OocCampaignSnapshot;
    /** The player's out-of-character question, verbatim. */
    readonly question: string;
    /**
     * The recent transcript window core already assembled, joined with newlines.
     * Shared so a section matching "who is on stage" uses the same text core's
     * NPC selection used, rather than re-deriving a slightly different one.
     */
    readonly recentText: string;
    /** Core's excerpting helper — whitespace-collapsed and length-capped. */
    readonly excerpt: (value: string, max?: number) => string;
    /**
     * Core's whole-word, alias-aware mention test. Shared for the same reason
     * `recentText` is: two matchers with different word-boundary rules would
     * make the brief's selections inconsistent between sections.
     */
    readonly namedIn: (haystack: string, name: string, aliases?: string) => boolean;
}

/** What a section produces. Both fields may be empty; an empty section renders nothing. */
export interface OocSectionOutput {
    /** Lines to splice into the brief, in order, already formatted. */
    readonly lines: readonly string[];
    /** Citation rows for the Ask-GM sources list. */
    readonly sources: readonly OocSource[];
}

/** A registered OOC section. */
export interface OocSection {
    /** Stable id, dot-namespaced. Core-adjacent subsystems use a bare name; mods use `mod.<id>.<name>`. */
    readonly id: string;
    /** Sort key among other registered sections at the extension point; ascending. */
    readonly order: number;
    /** Render this section, or return nothing when it has nothing to say. */
    build(context: OocSectionContext): OocSectionOutput | null | undefined;
}

export interface OocSectionRegistry {
    /** Register a section. Throws on a duplicate id — always a packaging bug. */
    register(section: OocSection): void;
    /** Remove a section by id. Returns whether it was present. */
    unregister(id: string): boolean;
    /** All registered sections, in registration order. */
    list(): readonly OocSection[];
    get(id: string): OocSection | undefined;
    /** Run every section and return the outputs that produced content, in `order`. */
    collect(context: OocSectionContext): OocSectionOutput[];
    /** Drop all sections. Test/teardown only. */
    clear(): void;
}

export function createOocSectionRegistry(): OocSectionRegistry {
    const sections = new Map<string, OocSection>();
    const order: string[] = [];

    return {
        register(section) {
            if (sections.has(section.id)) {
                throw new Error(`[ooc] duplicate section id: ${section.id}`);
            }
            sections.set(section.id, section);
            order.push(section.id);
        },

        unregister(id) {
            const removed = sections.delete(id);
            if (removed) {
                const index = order.indexOf(id);
                if (index >= 0) order.splice(index, 1);
            }
            return removed;
        },

        list() {
            return order.map((id) => sections.get(id)!);
        },

        get(id) {
            return sections.get(id);
        },

        collect(context) {
            const outputs: OocSectionOutput[] = [];
            const ordered = order
                .map((id, index) => ({ section: sections.get(id)!, index }))
                .sort((a, b) => (a.section.order - b.section.order) || (a.index - b.index));

            for (const { section } of ordered) {
                let output: OocSectionOutput | null | undefined;
                try {
                    output = section.build(context);
                } catch (error) {
                    // Fail safe: one bad section must never fail an Ask-GM.
                    console.warn(`[ooc] section "${section.id}" threw (skipped):`, error);
                    continue;
                }
                if (!output) continue;
                if (output.lines.length === 0 && output.sources.length === 0) continue;
                outputs.push(output);
            }
            return outputs;
        },

        clear() {
            sections.clear();
            order.length = 0;
        },
    };
}

/**
 * The production registry. A subsystem registers its section from its own
 * module (`enemy/enemyOocSection.ts`); when the subsystem leaves, its
 * registration leaves with it and `buildOocContext` needs no edit.
 */
export const oocSections = createOocSectionRegistry();
