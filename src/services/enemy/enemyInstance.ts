import type { EnemyEntry, EnemyInstance } from '../../types';

/** Reads the first non-negative number from a named template stat. */
function numericStat(template: EnemyEntry, names: string[]): number {
    const stat = template.stats.find(candidate =>
        names.some(name => candidate.name.trim().toLowerCase() === name)
    );
    const match = stat?.value.match(/-?\d+(?:\.\d+)?/);
    return match ? Math.max(0, Number(match[0])) : 0;
}

/** Chooses the next stable copy number without reusing labels after deletions. */
function nextCopyNumber(template: EnemyEntry, instances: EnemyInstance[]): number {
    const prefix = `${template.name} #`;
    return instances.reduce((highest, instance) => {
        if (instance.templateId !== template.id || !instance.displayName.startsWith(prefix)) return highest;
        const suffix = Number(instance.displayName.slice(prefix.length));
        return Number.isFinite(suffix) ? Math.max(highest, suffix) : highest;
    }, 0) + 1;
}

/**
 * Spawns an independent encounter record. Only explicit HP and Barrier stats
 * seed tracks; system-specific actions and prose are never guessed as values.
 */
export function createEnemyInstance(
    template: EnemyEntry,
    existing: EnemyInstance[],
    now = Date.now(),
    id = crypto.randomUUID(),
): EnemyInstance {
    const maxHp = numericStat(template, ['hp', 'hit points', 'health']);
    const maxBarrier = numericStat(template, ['barrier', 'barrier hp']);
    return {
        id,
        templateId: template.id,
        templateSnapshot: structuredClone(template),
        displayName: `${template.name} #${nextCopyNumber(template, existing)}`,
        currentHp: maxHp,
        maxHp,
        currentBarrier: maxBarrier,
        maxBarrier,
        conditions: [],
        temporaryModifiers: [],
        defeated: false,
        createdAt: now,
        updatedAt: now,
    };
}
