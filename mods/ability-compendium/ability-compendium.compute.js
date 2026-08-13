// Ability & Power Compendium post-turn module.
// Runs in the Narrative Engine Worker sandbox. It owns no host state: durable
// data lives only in this mod's namespaced tables and every host write is
// capability-gated by the manifest.

const TABLE = {
    abilities: 'mod.ability-compendium.abilities',
    assignments: 'mod.ability-compendium.assignments',
    runtime: 'mod.ability-compendium.runtime',
    proposals: 'mod.ability-compendium.proposals',
    config: 'mod.ability-compendium.config',
    promptIndex: 'mod.ability-compendium.prompt-index',
};

const CATEGORIES = new Set([
    'active', 'passive', 'reaction', 'sustained', 'transformation', 'summon',
    'stance', 'ritual', 'crafting', 'narrative-permission', 'other',
]);
const ORIGINS = new Set([
    'innate', 'trained', 'spell', 'item-granted', 'enemy-action', 'lore-granted', 'other',
]);

function uid() {
    return 'ability-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
}

function canonical(value) {
    return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function lines(label, value) {
    const items = list(value);
    return items.length ? label + ': ' + items.join('; ') : '';
}

function termsFor(ability, assignment) {
    const terms = [text(ability.name), ...text(ability.aliases).split(',').map((item) => item.trim())];
    if (assignment && text(assignment.variantName)) terms.push(text(assignment.variantName));
    return Array.from(new Set(terms.filter(Boolean)));
}

function formatCost(cost) {
    if (typeof cost === 'string') return text(cost);
    if (!cost || typeof cost !== 'object') return '';
    return [text(cost.resource), text(cost.amount), text(cost.timing), text(cost.condition)].filter(Boolean).join(' / ');
}

function buildPromptIndex(abilities, assignments, runtime, data) {
    // Generation 1 exposes promoted projections instead of the raw GameContext blob.
    const inventory = Array.isArray(data?.inventory) ? data.inventory : [];
    const inventoryIds = new Set(inventory.map((item) => String(item?.id || '')).filter(Boolean));
    const ownerNames = new Map();
    if (data?.playerCharacter?.id) ownerNames.set('pc:' + data.playerCharacter.id, text(data.playerCharacter.name));
    for (const npc of Array.isArray(data?.npcLedger) ? data.npcLedger : []) {
        if (npc?.id) ownerNames.set('npc:' + npc.id, text(npc.name));
    }
    const byAssignment = new Map(runtime.map((state) => [state?.characterAbilityId, state]));
    const rows = [];

    for (const ability of abilities) {
        if (!ability || typeof ability !== 'object' || ability.promptEnabled === false || !text(ability.name)) continue;
        const owned = assignments.filter((assignment) => assignment?.abilityId === ability.id && assignment.promptEnabled !== false);
        const representative = owned[0];
        const owners = owned.map((assignment) => {
            const state = byAssignment.get(assignment.id);
            const ownerKey = assignment.ownerType + ':' + assignment.ownerId;
            const bits = [ownerNames.get(ownerKey) || ownerKey];
            if (text(assignment.mastery)) bits.push('mastery ' + text(assignment.mastery));
            if (text(assignment.variantName)) bits.push('variant ' + text(assignment.variantName));
            if (list(assignment.modifications).length) bits.push('modifications ' + list(assignment.modifications).join('; '));
            if (list(assignment.unlockedUpgradeIds).length) bits.push('upgrades ' + list(assignment.unlockedUpgradeIds).join(', '));
            if ((Number(assignment.trainingGoal) || 0) > 0) {
                bits.push('training ' + Math.max(0, Number(assignment.trainingProgress) || 0) + '/' + Math.max(0, Number(assignment.trainingGoal) || 0));
            }
            if (state) {
                bits.push('cooldown ' + Math.max(0, Number(state.cooldownRemaining) || 0));
                if (state.chargesRemaining !== null && state.chargesRemaining !== undefined) {
                    bits.push('charges ' + state.chargesRemaining + '/' + (state.chargesMax ?? state.chargesRemaining));
                }
                if (Array.isArray(state.activeEffects) && state.activeEffects.length) {
                    bits.push('effects ' + state.activeEffects.map((effect) => typeof effect === 'string' ? text(effect) : text(effect?.name)).filter(Boolean).join(', '));
                }
            }
            return bits.join(', ');
        });
        const costs = Array.isArray(ability.costs) ? ability.costs.map(formatCost).filter(Boolean) : [];
        const blocks = [
            '[ABILITY: ' + text(ability.name) + ']',
            'Classification: ' + (text(ability.origin) || 'other') + ' / ' + (text(ability.category) || 'other'),
            text(ability.description) ? 'Definition: ' + text(ability.description) : '',
            text(ability.effect) ? 'Effect: ' + text(ability.effect) : '',
            text(ability.activation) ? 'Activation: ' + text(ability.activation) : '',
            costs.length ? 'Costs: ' + costs.join('; ') : '',
            text(ability.range) ? 'Range: ' + text(ability.range) : '',
            text(ability.targets) ? 'Targets: ' + text(ability.targets) : '',
            text(ability.duration) ? 'Duration: ' + text(ability.duration) : '',
            text(ability.area) ? 'Area: ' + text(ability.area) : '',
            lines('Limitations', ability.limitations),
            lines('Counters', ability.counters),
            lines('Prerequisites (guidance, not enforcement)', ability.prerequisites),
            lines('Interactions', ability.interactionTags),
            lines('Counter tags', ability.counterTags),
            text(ability.outcomeGuidance) ? 'Outcome guidance: ' + text(ability.outcomeGuidance) : '',
            ability.loreCheckRequired ? 'Lore check: ' + (text(ability.loreStatus) || 'unverified') + (text(ability.loreCheckNotes) ? ' Ã¢â‚¬â€ ' + text(ability.loreCheckNotes) : '') : '',
            ability.origin === 'item-granted' && text(ability.sourceInventoryItemId)
                ? 'Inventory source: ' + text(ability.sourceInventoryItemId) + (inventoryIds.has(text(ability.sourceInventoryItemId)) ? ' (present)' : ' (not currently present)')
                : '',
            owners.length ? 'Known owners: ' + owners.join(' | ') : '',
            'Treat prerequisites and eligibility as guidance. The player remains authoritative.',
        ].filter(Boolean);
        rows.push({
            id: String(ability.id || uid()),
            terms: termsFor(ability, representative),
            text: blocks.join('\n'),
            updatedAt: Date.now(),
        });
    }
    return rows;
}

function normalizeAiProposal(value, owners, abilities) {
    if (!value || typeof value !== 'object') return null;
    const kind = value.kind === 'assign' || value.kind === 'progression' ? value.kind : 'new';
    const abilityName = text(value.abilityName);
    const abilityId = text(value.abilityId);
    if (!abilityName && !abilityId) return null;
    const owner = owners.find((candidate) => candidate.id === value.ownerId && candidate.type === value.ownerType);
    const ability = abilities.find((candidate) => candidate.id === abilityId);
    const now = Date.now();
    return {
        id: uid(), kind, abilityId: ability?.id || abilityId, abilityName: ability?.name || abilityName,
        ownerType: owner?.type || null, ownerId: owner?.id || '',
        category: CATEGORIES.has(value.category) ? value.category : 'active',
        origin: ORIGINS.has(value.origin) ? value.origin : 'trained',
        effect: text(value.effect), activation: text(value.activation), mastery: text(value.mastery),
        masteryTierId: text(value.masteryTierId), modification: text(value.modification),
        upgradeId: text(value.upgradeId), trainingDelta: Math.max(0, Number(value.trainingDelta) || 0),
        reason: text(value.reason), evidence: text(value.evidence), sourceSceneId: text(value.sourceSceneId),
        createdAt: now, updatedAt: now,
    };
}

async function discover(ctx, abilities, assignments, pending) {
    if (!ctx.model.available('utility')) return [];
    const messages = Array.isArray(ctx.data.messages) ? ctx.data.messages.slice(-12) : [];
    const narrative = messages.map((message) => String(message.role || '').toUpperCase() + ': ' + text(message.content)).join('\n\n');
    if (!narrative.trim()) return [];
    const pc = ctx.data.playerCharacter;
    const owners = [
        ...(pc ? [{ type: 'pc', id: pc.id, name: pc.name }] : []),
        ...(ctx.data.npcLedger || []).filter((npc) => !npc.archived).map((npc) => ({ type: 'npc', id: npc.id, name: npc.name })),
    ];
    const compactAbilities = abilities.map((ability) => ({ id: ability.id, name: ability.name, aliases: ability.aliases, masteryLadder: ability.masteryLadder, upgradeNodes: ability.upgradeNodes }));
    const result = await ctx.model.callJson('utility', {
        prompt: [
            'Review recent tabletop play for durable ability changes. Return JSON only: {"proposals":[]}.',
            'Allowed kinds: new, assign, progression. Propose rather than enforce. Do not infer ordinary actions, knowledge, mood, equipment, or temporary effects as abilities.',
            'Each proposal may contain kind, abilityId, abilityName, ownerType, ownerId, category, origin, effect, activation, mastery, masteryTierId, modification, upgradeId, trainingDelta, reason, evidence, sourceSceneId.',
            'Known owners: ' + JSON.stringify(owners),
            'Known abilities: ' + JSON.stringify(compactAbilities),
            'Known assignments: ' + JSON.stringify(assignments),
            'Recent play:\n' + narrative,
        ].join('\n\n'),
        maxTokens: 1800,
        temperature: 0.1,
        trackingLabel: 'Ability Compendium discovery',
    }, { retries: 1 });
    const values = Array.isArray(result?.proposals) ? result.proposals : [];
    const existing = new Set(pending.map((proposal) => [proposal.kind, proposal.abilityId || canonical(proposal.abilityName), proposal.ownerType, proposal.ownerId].join('|')));
    return values.slice(0, 20).map((value) => normalizeAiProposal(value, owners, abilities)).filter(Boolean).filter((proposal) => {
        const key = [proposal.kind, proposal.abilityId || canonical(proposal.abilityName), proposal.ownerType, proposal.ownerId].join('|');
        if (existing.has(key)) return false;
        existing.add(key);
        return true;
    });
}

export default async function abilityCompendiumCompute(ctx) {
    const [abilitiesRaw, assignmentsRaw, runtimeRaw, proposalsRaw, configRaw] = await Promise.all([
        ctx.table.read(TABLE.abilities),
        ctx.table.read(TABLE.assignments),
        ctx.table.read(TABLE.runtime),
        ctx.table.read(TABLE.proposals),
        ctx.table.read(TABLE.config),
    ]);
    const abilities = Array.isArray(abilitiesRaw) ? abilitiesRaw : [];
    const assignments = Array.isArray(assignmentsRaw) ? assignmentsRaw : [];
    const runtime = Array.isArray(runtimeRaw) ? runtimeRaw : [];
    let proposals = Array.isArray(proposalsRaw) ? proposalsRaw : [];
    const config = configRaw && typeof configRaw === 'object' && !Array.isArray(configRaw) ? { ...configRaw } : {};

    const shouldScan = config.scanRequested === true || config.autoScan === true;
    if (shouldScan) {
        try {
            proposals = proposals.concat(await discover(ctx, abilities, assignments, proposals));
        } finally {
            config.scanRequested = false;
            config.lastScanAt = Date.now();
        }
    }

    await Promise.all([
        ctx.table.write(TABLE.proposals, proposals),
        ctx.table.write(TABLE.config, config),
        ctx.table.write(TABLE.promptIndex, buildPromptIndex(abilities, assignments, runtime, ctx.data)),
    ]);
}
