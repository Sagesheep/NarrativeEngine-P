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
    const context = data?.context || {};
    const inventory = Array.isArray(context?.inventoryItems) ? context.inventoryItems : [];
    const inventoryIds = new Set(inventory.map((item) => String(item?.id || '')).filter(Boolean));
    const ownerNames = new Map();
    if (context.playerCharacter?.id) ownerNames.set('pc:' + context.playerCharacter.id, text(context.playerCharacter.name));
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
            ability.loreCheckRequired ? 'Lore check: ' + (text(ability.loreStatus) || 'unverified') + (text(ability.loreCheckNotes) ? ' — ' + text(ability.loreCheckNotes) : '') : '',
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

function parseSheetAbility(source) {
    const raw = text(source);
    if (!raw) return null;
    const cantrip = raw.match(/^cantrip\s*:\s*(.+)$/i);
    if (cantrip) return { name: cantrip[1].replace(/\s*\([^)]*\)\s*$/, '').trim(), category: 'active', origin: 'spell', effect: raw, activation: 'Cast as a cantrip' };
    const spell = raw.match(/^((?:\d+(?:st|nd|rd|th)|[a-z]+)-level)\s+spell\s*:\s*(.+)$/i);
    if (spell) return { name: spell[2].replace(/\s*\([^)]*\)\s*$/, '').trim(), category: 'active', origin: 'spell', effect: raw, activation: 'Cast as a ' + spell[1].toLocaleLowerCase() + ' spell' };
    const labelled = raw.match(/^(weapon mastery|origin feat)\s*:\s*(.+)$/i);
    if (labelled) return {
        name: labelled[1].replace(/\b\w/g, (character) => character.toLocaleUpperCase()) + ': ' + labelled[2].replace(/\s*\([^)]*\)\s*$/, '').trim(),
        category: labelled[1].toLocaleLowerCase() === 'origin feat' ? 'passive' : 'active',
        origin: 'trained', effect: raw, activation: '',
    };
    const colon = raw.indexOf(':');
    if (colon > 0) return { name: raw.slice(0, colon).trim(), category: 'active', origin: 'trained', effect: raw.slice(colon + 1).trim() || raw, activation: '' };
    const passive = /\b(darkvision|resistance|immunity|presence|feat|proficiency)\b/i.test(raw);
    return { name: raw.replace(/\s*\([^)]*\)\s*$/, '').trim(), category: passive ? 'passive' : 'active', origin: passive ? 'innate' : 'trained', effect: raw, activation: '' };
}

function sheetProposals(profile, pcId, abilities, assignments, pending, consumed) {
    const sources = Array.isArray(profile?.abilities) ? profile.abilities : [];
    const knownByName = new Map();
    for (const ability of abilities) {
        for (const candidate of [text(ability?.name), ...text(ability?.aliases).split(',')]) {
            const key = canonical(candidate);
            if (key && !knownByName.has(key)) knownByName.set(key, ability);
        }
    }
    const owned = new Set(assignments.filter((entry) => entry?.ownerType === 'pc' && entry?.ownerId === pcId).map((entry) => entry.abilityId));
    const pendingKeys = new Set(pending.filter((entry) => entry?.ownerType === 'pc' && entry?.ownerId === pcId).map((entry) => entry.abilityId || canonical(entry.abilityName)));
    const consumedKeys = new Set(list(consumed).map(canonical));
    const out = [];
    for (const source of sources) {
        if (consumedKeys.has(canonical(source))) continue;
        const parsed = parseSheetAbility(source);
        if (!parsed) continue;
        const known = knownByName.get(canonical(parsed.name));
        if (known && owned.has(known.id)) continue;
        const key = known?.id || canonical(parsed.name);
        if (pendingKeys.has(key)) continue;
        pendingKeys.add(key);
        const now = Date.now();
        out.push({
            id: uid(), kind: known ? 'assign' : 'new', abilityId: known?.id || '', abilityName: parsed.name,
            ownerType: 'pc', ownerId: pcId, category: parsed.category, origin: parsed.origin,
            effect: parsed.effect, activation: parsed.activation, mastery: '', masteryTierId: '',
            modification: '', upgradeId: '', trainingDelta: 0,
            reason: 'Imported from the player character sheet for review.', evidence: text(source),
            sourceSceneId: '', sourceProfileAbility: text(source), createdAt: now, updatedAt: now,
        });
    }
    return out;
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
    const pc = ctx.data.context?.playerCharacter;
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

    const pc = ctx.data.context?.playerCharacter;
    const profile = ctx.data.context?.characterProfileData;
    if (pc && profile) {
        const imported = sheetProposals(profile, pc.id, abilities, assignments, proposals, config.consumedProfileAbilities);
        if (imported.length) proposals = proposals.concat(imported);
    }

    const shouldScan = config.scanRequested === true || config.autoScan === true;
    if (shouldScan) {
        try {
            proposals = proposals.concat(await discover(ctx, abilities, assignments, proposals));
        } finally {
            config.scanRequested = false;
            config.lastScanAt = Date.now();
        }
    }

    const consumed = new Set(list(config.consumedProfileAbilities).map(canonical));
    if (profile && consumed.size) {
        const nextAbilities = (Array.isArray(profile.abilities) ? profile.abilities : []).filter((source) => !consumed.has(canonical(source)));
        if (nextAbilities.length !== (profile.abilities || []).length) {
            ctx.write.setCharacterProfileData({ ...profile, abilities: nextAbilities });
        }
        config.consumedProfileAbilities = [];
    }

    ctx.table.write(TABLE.proposals, proposals);
    ctx.table.write(TABLE.config, config);
    ctx.table.write(TABLE.promptIndex, buildPromptIndex(abilities, assignments, runtime, ctx.data));
}
