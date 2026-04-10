/**
 * Entity resolution utilities extracted from server.js.
 * Pure functions — no filesystem access, no external dependencies.
 */

export function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            const cost = a[j - 1] === b[i - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }
    return matrix[b.length][a.length];
}

export function normalizeEntityName(name, knownEntities) {
    const lower = name.toLowerCase().trim();

    const exactMatch = knownEntities.find(
        e => e.name.toLowerCase() === lower ||
             e.aliases.some(a => a.toLowerCase() === lower)
    );
    if (exactMatch) return exactMatch.name;

    const substringMatch = knownEntities.find(
        e => lower.includes(e.name.toLowerCase()) ||
             e.name.toLowerCase().includes(lower)
    );
    if (substringMatch) return substringMatch.name;

    if (lower.length >= 3) {
        const threshold = lower.length <= 6 ? 2 : 3;
        for (const entity of knownEntities) {
            const el = entity.name.toLowerCase();
            if (Math.abs(el.length - lower.length) > threshold) continue;
            if (levenshtein(el, lower) <= threshold) return entity.name;
        }
    }

    return name;
}
