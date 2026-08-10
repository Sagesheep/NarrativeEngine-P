/**
 * Phase 7.5 — the enemy subsystem's Ask-GM sections.
 *
 * Moved verbatim out of `ooc/context.ts`, which used to render them inline
 * (`ROLES.md` §7.1). The rendering rules, the two caps and the
 * question-named-wins-over-live-snapshot precedence are unchanged; only their
 * address moved, so the brief is byte-identical.
 *
 * **Phase 8.3 deletes this file** along with the three snapshot fields it reads.
 * `ooc/context.ts` needs no edit for that: it walks the registry.
 */
import type { EnemyEntry, EnemyInstance } from '../../types';
import { oocSections, type OocSection, type OocSectionContext, type OocSectionOutput } from '../ooc/sections';
import type { OocSource } from '../ooc/types';

/** Ledger entries are cheap individually but unbounded in aggregate, so every ledger is capped. */
const MAX_ENEMIES = 4;
const MAX_ENEMY_INSTANCES = 8;

/** The registry id, and the sort key at the OOC extension point. */
export const ENEMY_OOC_SECTION_ID = 'enemy';
export const ENEMY_OOC_SECTION_ORDER = 100;

function enemyLine(enemy: EnemyEntry, excerpt: OocSectionContext['excerpt']): string {
    const bits: string[] = [];
    if (enemy.aliases?.trim()) bits.push(`aka ${excerpt(enemy.aliases, 80)}`);
    if (enemy.classification?.trim()) bits.push(`type: ${excerpt(enemy.classification, 60)}`);
    if (enemy.threatTier?.trim()) bits.push(`threat: ${excerpt(enemy.threatTier, 40)}`);
    if (enemy.faction?.trim()) bits.push(`faction: ${excerpt(enemy.faction, 60)}`);
    if (enemy.stats?.length) bits.push(`stats: ${excerpt(enemy.stats.map(stat => `${stat.name} ${stat.value}`).join(', '), 160)}`);
    if (enemy.actions?.length) bits.push(`actions: ${excerpt(enemy.actions.map(action => action.name).join(', '), 140)}`);
    if (enemy.specialBehaviors?.length) bits.push(`special: ${excerpt(enemy.specialBehaviors.join(', '), 140)}`);
    if (enemy.weaknesses?.length) bits.push(`weaknesses: ${excerpt(enemy.weaknesses.join(', '), 120)}`);
    if (enemy.resistances?.length) bits.push(`resistances: ${excerpt(enemy.resistances.join(', '), 120)}`);
    if (enemy.passiveTraits?.length) bits.push(`passives: ${excerpt(enemy.passiveTraits.join(', '), 120)}`);
    if (enemy.tactics?.trim()) bits.push(`tactics: ${excerpt(enemy.tactics, 160)}`);
    if (enemy.description?.trim()) bits.push(excerpt(enemy.description, 200));
    if (enemy.loot?.trim()) bits.push(`rewards: ${excerpt(enemy.loot, 100)}`);
    if (enemy.gmNotes?.trim()) bits.push(`notes: ${excerpt(enemy.gmNotes, 160)}`);
    return bits.join('; ');
}

/** Live per-instance state. Numbers are reported as-is; OOC never adjudicates combat. */
function enemyInstanceLine(instance: EnemyInstance, excerpt: OocSectionContext['excerpt']): string {
    const bits = [`HP ${instance.currentHp}/${instance.maxHp}`];
    if (instance.maxBarrier > 0) bits.push(`barrier ${instance.currentBarrier}/${instance.maxBarrier}`);
    bits.push(instance.defeated ? 'defeated' : 'active');
    if (instance.conditions.length) bits.push(`conditions: ${excerpt(instance.conditions.join(', '), 120)}`);
    if (instance.temporaryModifiers.length) {
        bits.push(`modifiers: ${excerpt(instance.temporaryModifiers.map(modifier => `${modifier.name} ${modifier.value}`).join(', '), 120)}`);
    }
    return bits.join('; ');
}

/**
 * The live encounter roster, then any template the question names.
 *
 * The `promptContextEnabled` / `promptEnabled` toggles gate *narrative* prompt
 * injection on incidental mention; both selections here are explicit (the player
 * asked, or the enemy is on the field), so those gates do not apply.
 */
export const enemyOocSection: OocSection = {
    id: ENEMY_OOC_SECTION_ID,
    order: ENEMY_OOC_SECTION_ORDER,
    build({ snapshot, question, excerpt, namedIn }): OocSectionOutput {
        const lines: string[] = [];
        const sources: OocSource[] = [];

        const activeEncounter = (snapshot.enemyEncounters ?? []).find(encounter => encounter.status === 'active');
        const activeWave = activeEncounter?.waves.find(wave => wave.id === activeEncounter.activeWaveId);
        const instancesById = new Map((snapshot.enemyInstances ?? []).map(instance => [instance.id, instance]));
        const liveInstances = (activeWave?.activeInstanceIds ?? [])
            .map(id => instancesById.get(id))
            .filter((instance): instance is EnemyInstance => !!instance)
            .slice(0, MAX_ENEMY_INSTANCES);
        if (activeEncounter && liveInstances.length > 0) {
            lines.push(`Active encounter: ${excerpt(activeEncounter.name, 80)}${activeWave ? ` - wave ${excerpt(activeWave.name, 60)}` : ''}`);
            for (const instance of liveInstances) {
                const line = `${instance.displayName} (${instance.templateSnapshot.name}): ${enemyInstanceLine(instance, excerpt)}`;
                lines.push(`- ${line}`);
                sources.push({ kind: 'enemy', id: instance.id, label: `On the field: ${instance.displayName}`, excerpt: excerpt(line, 500) });
            }
        }

        // Question-named templates win over the frozen snapshots behind live instances,
        // so an explicit lookup always reads the compendium's current version.
        const askedEnemies = (snapshot.enemyCompendium ?? []).filter(enemy => namedIn(question, enemy.name, enemy.aliases));
        const seenTemplateIds = new Set(askedEnemies.map(enemy => enemy.id));
        const liveTemplates: EnemyEntry[] = [];
        for (const { templateSnapshot } of liveInstances) {
            if (seenTemplateIds.has(templateSnapshot.id)) continue;
            seenTemplateIds.add(templateSnapshot.id);
            liveTemplates.push(templateSnapshot);
        }
        const enemies = [...askedEnemies, ...liveTemplates].slice(0, MAX_ENEMIES);
        if (enemies.length > 0) {
            lines.push('Enemy records (compendium):');
            for (const enemy of enemies) {
                const details = enemyLine(enemy, excerpt);
                const line = `${enemy.name}${details ? ` - ${details}` : ''}`;
                lines.push(`- ${line}`);
                sources.push({ kind: 'enemy', id: enemy.id, label: `Enemy: ${enemy.name}`, excerpt: excerpt(line, 500) });
            }
        }

        return { lines, sources };
    },
};

let registered = false;

/**
 * Register the section exactly once. Idempotent, and self-healing after a test
 * called `oocSections.clear()` — the same discipline the budget claim uses.
 * Called from the subsystem's module load below so importing anything in
 * `src/services/enemy/` that reaches here is enough; `oocService` imports it
 * explicitly so the production path never depends on import luck.
 */
export function ensureEnemyOocSection(): void {
    if (registered && oocSections.get(ENEMY_OOC_SECTION_ID) !== undefined) return;
    registered = true;
    if (oocSections.get(ENEMY_OOC_SECTION_ID) !== undefined) oocSections.unregister(ENEMY_OOC_SECTION_ID);
    oocSections.register(enemyOocSection);
}

ensureEnemyOocSection();
