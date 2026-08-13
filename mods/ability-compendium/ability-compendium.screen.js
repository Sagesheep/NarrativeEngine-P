// Ability & Power Compendium module screen.
// Vanilla JavaScript by design: this file runs inside Narrative Engine's opaque,
// networkless iframe and communicates only through the declared screen API.

export default async function abilityCompendiumScreen() {
    const api = globalThis.__screenApi;
    const theme = await api.request('theme');
    const C = theme.colors;
    const FS = theme.fontSizes;
    const R = theme.radii;
    const TABLES = ['abilities', 'assignments', 'runtime', 'proposals', 'config', 'prompt-index'];
    const CATEGORIES = ['active', 'passive', 'reaction', 'sustained', 'transformation', 'summon', 'stance', 'ritual', 'crafting', 'narrative-permission', 'other'];
    const ORIGINS = ['innate', 'trained', 'spell', 'item-granted', 'enemy-action', 'lore-granted', 'other'];
    const DEFAULT_ORIGIN_LABELS = { innate: 'Innate', trained: 'Trained', spell: 'Spell', 'item-granted': 'Inventory Power', 'enemy-action': 'Enemy Action', 'lore-granted': 'Lore-Granted', other: 'Other' };
    const DEFAULT_CATEGORY_LABELS = { active: 'Active', passive: 'Passive', reaction: 'Reaction', sustained: 'Sustained', transformation: 'Transformation', summon: 'Summon', stance: 'Stance', ritual: 'Ritual', crafting: 'Crafting', 'narrative-permission': 'Narrative Permission', other: 'Other' };

    const loaded = await Promise.all(TABLES.map((table) => api.request({ capability: 'table.read', table })));
    const state = {
        abilities: Array.isArray(loaded[0]) ? loaded[0] : [],
        assignments: Array.isArray(loaded[1]) ? loaded[1] : [],
        runtime: Array.isArray(loaded[2]) ? loaded[2] : [],
        proposals: Array.isArray(loaded[3]) ? loaded[3] : [],
        config: loaded[4] && typeof loaded[4] === 'object' && !Array.isArray(loaded[4]) ? loaded[4] : {},
        promptIndex: Array.isArray(loaded[5]) ? loaded[5] : [],
        // Gen 1 screens receive only theme, resize, and this module's tables.
        // The public native context remains the source for discovery and prompt assembly.
        characters: [{ type: 'pc', id: 'pc', name: 'Player Character' }],
        profile: null,
        inventory: [],
        recentPlay: [],
    };
    state.config = {
        schemaVersion: 2,
        terminology: { originLabels: {}, categoryLabels: {} },
        autoScan: false,
        consumedProfileAbilities: [],
        ...state.config,
    };
    state.config.terminology = {
        originLabels: {}, categoryLabels: {}, ...(state.config.terminology || {}),
    };

    let tab = 'library';
    let query = '';
    let originFilter = 'all';
    let selectedAbilityId = state.abilities[0]?.id || '';
    let selectedOwnerKey = state.characters.find((character) => !character.archived)?.type + ':' + state.characters.find((character) => !character.archived)?.id;
    if (selectedOwnerKey === 'undefined:undefined') selectedOwnerKey = '';
    let selectedAssignmentId = '';
    let noticeTimer = null;

    function uid(prefix) {
        if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
        return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }
    function text(value) { return typeof value === 'string' ? value.trim() : ''; }
    function list(value) {
        if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
        if (typeof value === 'string') return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
        return [];
    }
    function number(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : (fallback || 0);
    }
    function canonical(value) { return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    }
    function parseJson(value, fallback) {
        try { return JSON.parse(value); } catch { return fallback; }
    }
    function originLabel(origin) { return text(state.config.terminology?.originLabels?.[origin]) || DEFAULT_ORIGIN_LABELS[origin] || origin; }
    function categoryLabel(category) { return text(state.config.terminology?.categoryLabels?.[category]) || DEFAULT_CATEGORY_LABELS[category] || category; }
    function ownerFromKey(key) {
        const split = String(key || '').indexOf(':');
        return split > 0 ? { type: key.slice(0, split), id: key.slice(split + 1) } : null;
    }
    function ownerName(type, id) {
        return state.characters.find((owner) => owner.type === type && owner.id === id)?.name || type + ':' + id;
    }

    function emptyAbility() {
        const now = Date.now();
        return {
            id: uid('ability'), name: '', aliases: '', category: 'active', origin: 'trained',
            description: '', appearance: '', activation: '', costs: [], range: '', targets: '', duration: '', area: '',
            effect: '', outcomeGuidance: '', limitations: [], counters: [], prerequisites: [], interactionTags: [], counterTags: [],
            sourceInventoryItemId: '', inventoryRequiresEquipped: true, loreCheckRequired: false, loreStatus: 'unverified',
            loreCheckNotes: '', loreCheckedAt: null, masteryLadder: [], upgradeNodes: [], tags: [], source: '', gmNotes: '',
            promptEnabled: true, createdAt: now, updatedAt: now,
        };
    }
    function normalizeAbility(raw) {
        if (!raw || typeof raw !== 'object' || !text(raw.name)) return null;
        const base = emptyAbility();
        const category = CATEGORIES.includes(raw.category) ? raw.category : 'active';
        const origin = ORIGINS.includes(raw.origin) ? raw.origin : (/spell|cantrip/i.test([raw.name, ...(raw.tags || [])].join(' ')) ? 'spell' : 'trained');
        return {
            ...base, ...raw, id: text(raw.id) || base.id, name: text(raw.name), aliases: text(raw.aliases), category, origin,
            costs: Array.isArray(raw.costs) ? raw.costs.filter((cost) => cost && typeof cost === 'object').map((cost) => ({ resource: text(cost.resource), amount: text(cost.amount), timing: text(cost.timing), condition: text(cost.condition) })).filter((cost) => cost.resource) : [],
            limitations: list(raw.limitations), counters: list(raw.counters), prerequisites: list(raw.prerequisites),
            interactionTags: list(raw.interactionTags), counterTags: list(raw.counterTags), tags: list(raw.tags),
            masteryLadder: Array.isArray(raw.masteryLadder) ? raw.masteryLadder : [], upgradeNodes: Array.isArray(raw.upgradeNodes) ? raw.upgradeNodes : [],
            promptEnabled: raw.promptEnabled !== false, createdAt: number(raw.createdAt, Date.now()), updatedAt: Date.now(),
        };
    }
    function emptyAssignment(owner, abilityId) {
        const now = Date.now();
        return { id: uid('assignment'), abilityId: abilityId || '', ownerType: owner?.type || 'pc', ownerId: owner?.id || '', mastery: '', masteryTierId: '', unlockedUpgradeIds: [], trainingProgress: 0, trainingGoal: 0, trainingMilestones: [], variantName: '', modifications: [], learnedSceneId: '', notes: '', promptEnabled: true, createdAt: now, updatedAt: now };
    }
    function runtimeFor(assignmentId) {
        let runtime = state.runtime.find((entry) => entry.characterAbilityId === assignmentId);
        if (!runtime) {
            runtime = { id: uid('runtime'), characterAbilityId: assignmentId, cooldownRemaining: 0, cooldownMax: 0, chargesRemaining: null, chargesMax: null, activeEffects: [], uses: 0, lastUsedSceneId: '', notes: '', updatedAt: Date.now() };
            state.runtime.push(runtime);
        }
        return runtime;
    }

    async function saveTable(table, value) {
        state[table === 'prompt-index' ? 'promptIndex' : table] = value;
        await api.request({ capability: 'table.write', table, value });
    }
    function notify(message, error) {
        const notice = document.getElementById('notice');
        if (!notice) return;
        notice.textContent = message;
        notice.className = 'notice show' + (error ? ' error' : '');
        if (noticeTimer) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => { notice.className = 'notice'; }, 2800);
    }

    function formatPrompt(ability) {
        const assignments = state.assignments.filter((entry) => entry.abilityId === ability.id && entry.promptEnabled !== false);
        const costs = (ability.costs || []).map((cost) => [cost.resource, cost.amount, cost.timing, cost.condition].filter(Boolean).join(' / ')).filter(Boolean);
        const blocks = [
            '[ABILITY: ' + ability.name + ']',
            'Classification: ' + ability.origin + ' / ' + ability.category,
            text(ability.description) ? 'Definition: ' + text(ability.description) : '',
            text(ability.effect) ? 'Effect: ' + text(ability.effect) : '',
            text(ability.activation) ? 'Activation: ' + text(ability.activation) : '',
            costs.length ? 'Costs: ' + costs.join('; ') : '',
            text(ability.range) ? 'Range: ' + text(ability.range) : '', text(ability.targets) ? 'Targets: ' + text(ability.targets) : '',
            text(ability.duration) ? 'Duration: ' + text(ability.duration) : '', text(ability.area) ? 'Area: ' + text(ability.area) : '',
            list(ability.limitations).length ? 'Limitations: ' + list(ability.limitations).join('; ') : '',
            list(ability.counters).length ? 'Counters: ' + list(ability.counters).join('; ') : '',
            list(ability.prerequisites).length ? 'Prerequisites (guidance, not enforcement): ' + list(ability.prerequisites).join('; ') : '',
            list(ability.interactionTags).length ? 'Interactions: ' + list(ability.interactionTags).join('; ') : '',
            list(ability.counterTags).length ? 'Counter tags: ' + list(ability.counterTags).join('; ') : '',
            text(ability.outcomeGuidance) ? 'Outcome guidance: ' + text(ability.outcomeGuidance) : '',
            assignments.length ? 'Known owners: ' + assignments.map((entry) => ownerName(entry.ownerType, entry.ownerId) + (text(entry.mastery) ? ' (' + text(entry.mastery) + ')' : '')).join('; ') : '',
            'Treat prerequisites and eligibility as guidance. The player remains authoritative.',
        ].filter(Boolean);
        return blocks.join('\n');
    }
    async function rebuildPromptIndex() {
        const rows = state.abilities.filter((ability) => ability.promptEnabled !== false).map((ability) => ({
            id: ability.id,
            terms: Array.from(new Set([ability.name, ...text(ability.aliases).split(',').map((item) => item.trim()), ...state.assignments.filter((entry) => entry.abilityId === ability.id).map((entry) => text(entry.variantName))].filter(Boolean))),
            text: formatPrompt(ability), updatedAt: Date.now(),
        }));
        await saveTable('prompt-index', rows);
    }

    document.body.innerHTML = ''
        + '<style>'
        + '*{box-sizing:border-box}body{margin:0;background:' + C.background + ';color:' + C.text + ';font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:' + FS.body + ';overflow:hidden}'
        + 'button,input,textarea,select{font:inherit}button{cursor:pointer}.shell{height:100vh;display:flex;flex-direction:column}.top{display:flex;align-items:center;gap:8px;padding:10px 12px;background:' + C.surface + ';border-bottom:1px solid ' + C.border + '}.title{font-size:' + FS.heading + ';font-weight:700}.spacer{flex:1}.tabs{display:flex;gap:4px;flex-wrap:wrap}.tab,.btn{border:1px solid ' + C.border + ';background:transparent;color:' + C.text + ';border-radius:' + R.small + ';padding:7px 10px}.tab.active,.btn.primary{border-color:' + C.accent + ';color:' + C.accent + ';background:color-mix(in srgb,' + C.accent + ' 12%,transparent)}.btn.danger{border-color:' + C.danger + ';color:' + C.danger + '}.btn:disabled{opacity:.35;cursor:not-allowed}.body{flex:1;min-height:0;overflow:auto;padding:12px}.grid{display:grid;gap:12px}.two{grid-template-columns:repeat(2,minmax(0,1fr))}.three{grid-template-columns:repeat(3,minmax(0,1fr))}.library{display:grid;grid-template-columns:270px 1fr;gap:12px;height:100%}.sidebar,.card{background:' + C.surface + ';border:1px solid ' + C.border + ';border-radius:' + R.medium + '}.sidebar{display:flex;flex-direction:column;min-height:0}.pad{padding:12px}.list{overflow:auto;flex:1}.row{display:block;width:100%;text-align:left;padding:10px 12px;border:0;border-top:1px solid ' + C.border + ';background:transparent;color:' + C.text + '}.row.active{background:color-mix(in srgb,' + C.accent + ' 12%,transparent);color:' + C.accent + '}.muted{color:' + C.muted + ';font-size:' + FS.small + '}.field{display:flex;flex-direction:column;gap:5px;color:' + C.muted + ';font-size:' + FS.small + ';text-transform:uppercase;letter-spacing:.04em}.field input,.field textarea,.field select{width:100%;background:' + C.background + ';color:' + C.text + ';border:1px solid ' + C.border + ';border-radius:' + R.small + ';padding:8px;text-transform:none}.field textarea{min-height:70px;resize:vertical}.full{grid-column:1/-1}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.section{margin-bottom:14px}.section h3{margin:0 0 8px;font-size:' + FS.body + ';text-transform:uppercase;letter-spacing:.07em}.proposal{padding:12px;margin-bottom:10px;background:' + C.surface + ';border:1px solid ' + C.border + ';border-radius:' + R.medium + '}.badge{display:inline-block;padding:2px 6px;border:1px solid ' + C.border + ';border-radius:999px;color:' + C.accent + ';font-size:' + FS.small + ';text-transform:uppercase}.notice{position:fixed;left:50%;bottom:16px;transform:translate(-50%,8px);opacity:0;pointer-events:none;padding:9px 14px;background:' + C.surface + ';border:1px solid ' + C.border + ';border-radius:' + R.medium + ';transition:.15s}.notice.show{opacity:1;transform:translate(-50%,0)}.notice.error{border-color:' + C.danger + ';color:' + C.danger + '}.empty{padding:28px;text-align:center;color:' + C.muted + ';border:1px dashed ' + C.border + ';border-radius:' + R.medium + '}@media(max-width:760px){.library{grid-template-columns:1fr}.sidebar{max-height:280px}.two,.three{grid-template-columns:1fr}}'
        + '</style>'
        + '<div class="shell"><div class="top"><div><div class="title">Ability &amp; Power Compendium</div><div class="muted">Installed module Â· campaign-owned data</div></div><div class="spacer"></div><div class="tabs" id="tabs"></div></div><div class="body" id="body"></div></div><div class="notice" id="notice"></div>';
    await api.request({ capability: 'resize', height: 820 });

    const tabs = [
        ['library', 'Library'], ['characters', 'Characters'], ['discoveries', 'Discoveries'], ['terminology', 'Terminology'],
    ];
    function renderTabs() {
        document.getElementById('tabs').innerHTML = tabs.map(([id, label]) => '<button class="tab ' + (tab === id ? 'active' : '') + '" data-tab="' + id + '">' + label + (id === 'discoveries' && state.proposals.length ? ' (' + state.proposals.length + ')' : '') + '</button>').join('');
    }
    function field(label, key, value, type, options) {
        const control = type === 'textarea'
            ? '<textarea data-field="' + key + '">' + esc(value) + '</textarea>'
            : type === 'select'
                ? '<select data-field="' + key + '">' + options.map((option) => '<option value="' + esc(option.value) + '" ' + (option.value === value ? 'selected' : '') + '>' + esc(option.label) + '</option>').join('') + '</select>'
                : '<input data-field="' + key + '" type="' + (type || 'text') + '" value="' + esc(value) + '">';
        return '<label class="field">' + esc(label) + control + '</label>';
    }

    function renderLibrary() {
        const needle = canonical(query);
        const shown = state.abilities.filter((ability) => originFilter === 'all' || ability.origin === originFilter).filter((ability) => !needle || canonical([ability.name, ability.aliases, ability.origin, ability.category, ...(ability.tags || []), ...(ability.interactionTags || []), ...(ability.counterTags || [])].join(' ')).includes(needle)).sort((a, b) => a.name.localeCompare(b.name));
        let selected = state.abilities.find((ability) => ability.id === selectedAbilityId);
        if (!selected) selected = emptyAbility();
        const originOptions = [{ value: 'all', label: 'All origins' }, ...ORIGINS.map((origin) => ({ value: origin, label: originLabel(origin) }))];
        const categoryOptions = CATEGORIES.map((category) => ({ value: category, label: categoryLabel(category) }));
        const abilityOriginOptions = ORIGINS.map((origin) => ({ value: origin, label: originLabel(origin) }));
        document.getElementById('body').innerHTML = '<div class="library">'
            + '<aside class="sidebar"><div class="pad grid">' + field('Search', 'search', query) + field('Origin', 'origin-filter', originFilter, 'select', originOptions)
            + '<div class="toolbar"><button class="btn primary" data-action="new-ability">New</button><button class="btn" data-action="import">Import</button><button class="btn" data-action="export">Export</button><input id="import-file" type="file" accept=".json,application/json" hidden></div></div>'
            + '<div class="list">' + (shown.length ? shown.map((ability) => '<button class="row ' + (ability.id === selectedAbilityId ? 'active' : '') + '" data-ability="' + esc(ability.id) + '"><strong>' + esc(ability.name) + '</strong><div class="muted">' + esc(originLabel(ability.origin)) + ' Â· ' + esc(categoryLabel(ability.category)) + '</div></button>').join('') : '<div class="empty">No abilities found.</div>') + '</div></aside>'
            + '<section class="card pad"><div class="toolbar section"><button class="btn primary" data-action="save-ability">Save definition</button><button class="btn" data-action="duplicate-ability" ' + (!text(selected.name) ? 'disabled' : '') + '>Duplicate</button><button class="btn danger" data-action="delete-ability" ' + (!selectedAbilityId ? 'disabled' : '') + '>Delete</button><span class="muted">' + state.abilities.length + ' canonical definitions</span></div>'
            + '<div class="grid two" id="ability-form">'
            + field('Name', 'name', selected.name) + field('Aliases (comma separated)', 'aliases', selected.aliases)
            + field('Category', 'category', selected.category, 'select', categoryOptions) + field('Origin', 'origin', selected.origin, 'select', abilityOriginOptions)
            + '<div class="full">' + field('Description', 'description', selected.description, 'textarea') + '</div>'
            + field('Core effect', 'effect', selected.effect, 'textarea') + field('Activation', 'activation', selected.activation, 'textarea')
            + field('Appearance', 'appearance', selected.appearance, 'textarea') + field('Outcome guidance', 'outcomeGuidance', selected.outcomeGuidance, 'textarea')
            + field('Range', 'range', selected.range) + field('Targets', 'targets', selected.targets) + field('Duration', 'duration', selected.duration) + field('Area', 'area', selected.area)
            + field('Costs (Resource | Amount | Timing | Condition)', 'costsText', (selected.costs || []).map((cost) => [cost.resource, cost.amount, cost.timing, cost.condition].join(' | ')).join('\n'), 'textarea')
            + field('Tags (one per line)', 'tagsText', list(selected.tags).join('\n'), 'textarea')
            + field('Limitations', 'limitationsText', list(selected.limitations).join('\n'), 'textarea') + field('Counters', 'countersText', list(selected.counters).join('\n'), 'textarea')
            + field('Prerequisites (guidance only)', 'prerequisitesText', list(selected.prerequisites).join('\n'), 'textarea') + field('Interaction tags', 'interactionTagsText', list(selected.interactionTags).join('\n'), 'textarea')
            + field('Counter tags', 'counterTagsText', list(selected.counterTags).join('\n'), 'textarea') + field('Canon / lore source', 'source', selected.source)
            + field('Inventory item ID', 'sourceInventoryItemId', selected.sourceInventoryItemId) + field('Lore status', 'loreStatus', selected.loreStatus, 'select', ['unverified', 'verified', 'flagged'].map((value) => ({ value, label: value })))
            + field('Lore check notes', 'loreCheckNotes', selected.loreCheckNotes, 'textarea') + field('GM notes', 'gmNotes', selected.gmNotes, 'textarea')
            + field('Mastery ladder (JSON array)', 'masteryLadderJson', JSON.stringify(selected.masteryLadder || [], null, 2), 'textarea') + field('Upgrade branches (JSON array)', 'upgradeNodesJson', JSON.stringify(selected.upgradeNodes || [], null, 2), 'textarea')
            + '<label class="field"><span><input data-field="promptEnabled" type="checkbox" ' + (selected.promptEnabled !== false ? 'checked' : '') + '> Inject exact-name matches into the prompt</span></label>'
            + '<label class="field"><span><input data-field="loreCheckRequired" type="checkbox" ' + (selected.loreCheckRequired ? 'checked' : '') + '> Lore check requested</span></label>'
            + '<label class="field"><span><input data-field="inventoryRequiresEquipped" type="checkbox" ' + (selected.inventoryRequiresEquipped !== false ? 'checked' : '') + '> Inventory source must be equipped</span></label>'
            + '</div></section></div>';
        document.getElementById('import-file').addEventListener('change', importFile);
    }

    function collectAbilityForm() {
        const existing = state.abilities.find((ability) => ability.id === selectedAbilityId) || emptyAbility();
        const get = (key) => document.querySelector('[data-field="' + key + '"]');
        const costs = text(get('costsText')?.value).split(/\r?\n/).map((line) => {
            const parts = line.split('|').map((part) => part.trim());
            return { resource: parts[0] || '', amount: parts[1] || '', timing: parts[2] || '', condition: parts[3] || '' };
        }).filter((cost) => cost.resource);
        return normalizeAbility({
            ...existing, name: get('name').value, aliases: get('aliases').value, category: get('category').value, origin: get('origin').value,
            description: get('description').value, effect: get('effect').value, activation: get('activation').value, appearance: get('appearance').value,
            outcomeGuidance: get('outcomeGuidance').value, range: get('range').value, targets: get('targets').value, duration: get('duration').value, area: get('area').value,
            costs, tags: list(get('tagsText').value), limitations: list(get('limitationsText').value), counters: list(get('countersText').value),
            prerequisites: list(get('prerequisitesText').value), interactionTags: list(get('interactionTagsText').value), counterTags: list(get('counterTagsText').value),
            source: get('source').value, sourceInventoryItemId: get('sourceInventoryItemId').value, loreStatus: get('loreStatus').value,
            loreCheckNotes: get('loreCheckNotes').value, gmNotes: get('gmNotes').value,
            masteryLadder: parseJson(get('masteryLadderJson').value, existing.masteryLadder || []), upgradeNodes: parseJson(get('upgradeNodesJson').value, existing.upgradeNodes || []),
            promptEnabled: get('promptEnabled').checked, loreCheckRequired: get('loreCheckRequired').checked, inventoryRequiresEquipped: get('inventoryRequiresEquipped').checked,
        });
    }

    async function importFile(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed.abilities) ? parsed.abilities : null;
            if (!source) throw new Error('Expected an ability array or versioned compendium document');
            const normalized = source.map(normalizeAbility).filter(Boolean);
            state.abilities = normalized;
            if (parsed.terminology && typeof parsed.terminology === 'object') state.config.terminology = parsed.terminology;
            selectedAbilityId = normalized[0]?.id || '';
            await Promise.all([saveTable('abilities', state.abilities), saveTable('config', state.config)]);
            await rebuildPromptIndex();
            notify('Imported ' + normalized.length + ' abilities');
            render();
        } catch (error) { notify(error.message || 'Import failed', true); }
    }
    async function exportCompendium() {
        const document = { schemaVersion: 2, terminology: state.config.terminology, abilities: state.abilities };
        const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = 'ability-compendium.json';
        anchor.click();
        URL.revokeObjectURL(anchor.href);
        notify('Compendium exported');
    }

    function renderCharacters() {
        const owners = state.characters.filter((character) => !character.archived);
        const owner = ownerFromKey(selectedOwnerKey) || (owners[0] ? { type: owners[0].type, id: owners[0].id } : null);
        if (owner && !selectedOwnerKey) selectedOwnerKey = owner.type + ':' + owner.id;
        const assignments = owner ? state.assignments.filter((entry) => entry.ownerType === owner.type && entry.ownerId === owner.id) : [];
        let selected = state.assignments.find((entry) => entry.id === selectedAssignmentId);
        if (!selected || !owner || selected.ownerType !== owner.type || selected.ownerId !== owner.id) selected = emptyAssignment(owner, selectedAbilityId || state.abilities[0]?.id || '');
        const runtime = selectedAssignmentId ? runtimeFor(selectedAssignmentId) : null;
        const ability = state.abilities.find((entry) => entry.id === selected.abilityId);
        const ownerOptions = owners.map((entry) => ({ value: entry.type + ':' + entry.id, label: entry.name + (entry.type === 'pc' ? ' (Player Character)' : '') }));
        const abilityOptions = [{ value: '', label: 'Choose an ability' }, ...state.abilities.slice().sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({ value: entry.id, label: entry.name }))];
        const inventoryPowers = state.abilities.filter((entry) => entry.origin === 'item-granted').filter((entry) => state.inventory.some((item) => item.id === entry.sourceInventoryItemId));
        document.getElementById('body').innerHTML = '<div class="grid two">'
            + '<section class="card pad"><div class="section">' + field('Character', 'owner', selectedOwnerKey, 'select', ownerOptions) + '</div><div class="toolbar section"><button class="btn primary" data-action="new-assignment" ' + (!owner || !state.abilities.length ? 'disabled' : '') + '>Assign ability</button></div>'
            + (assignments.length ? assignments.map((entry) => { const definition = state.abilities.find((candidate) => candidate.id === entry.abilityId); return '<button class="row ' + (entry.id === selectedAssignmentId ? 'active' : '') + '" data-assignment="' + esc(entry.id) + '"><strong>' + esc(entry.variantName || definition?.name || 'Missing definition') + '</strong><div class="muted">' + esc(entry.mastery || 'Unranked') + '</div></button>'; }).join('') : '<div class="empty">No assigned abilities.</div>')
            + (inventoryPowers.length ? '<div class="pad"><div class="muted">Inventory-granted powers currently available</div>' + inventoryPowers.map((entry) => '<div>' + esc(entry.name) + '</div>').join('') + '</div>' : '') + '</section>'
            + '<section class="card pad"><div class="toolbar section"><button class="btn primary" data-action="save-assignment" ' + (!owner || !state.abilities.length ? 'disabled' : '') + '>Add to character</button><button class="btn danger" data-action="delete-assignment" ' + (!selectedAssignmentId ? 'disabled' : '') + '>Remove</button></div><div class="grid two" id="assignment-form">'
            + field('Canonical ability', 'abilityId', selected.abilityId, 'select', abilityOptions) + field('Mastery / rank', 'mastery', selected.mastery)
            + field('Personal variant name', 'variantName', selected.variantName) + field('Learned scene', 'learnedSceneId', selected.learnedSceneId)
            + field('Personal modifications', 'modificationsText', list(selected.modifications).join('\n'), 'textarea') + field('Ownership notes', 'notes', selected.notes, 'textarea')
            + field('Structured mastery tier ID', 'masteryTierId', selected.masteryTierId) + field('Unlocked upgrade IDs', 'unlockedUpgradeIdsText', list(selected.unlockedUpgradeIds).join('\n'), 'textarea')
            + field('Training progress', 'trainingProgress', selected.trainingProgress, 'number') + field('Training goal', 'trainingGoal', selected.trainingGoal, 'number')
            + field('Training milestones (JSON)', 'trainingMilestonesJson', JSON.stringify(selected.trainingMilestones || [], null, 2), 'textarea')
            + '<label class="field"><span><input data-field="assignmentPromptEnabled" type="checkbox" ' + (selected.promptEnabled !== false ? 'checked' : '') + '> Include owner context in prompt</span></label></div>'
            + (runtime ? '<div class="section"><h3>Runtime state</h3><div class="grid three" id="runtime-form">'
                + field('Cooldown remaining', 'cooldownRemaining', runtime.cooldownRemaining, 'number') + field('Cooldown maximum', 'cooldownMax', runtime.cooldownMax, 'number')
                + field('Charges remaining (blank = unlimited)', 'chargesRemaining', runtime.chargesRemaining ?? '') + field('Charges maximum', 'chargesMax', runtime.chargesMax ?? '')
                + field('Uses', 'uses', runtime.uses, 'number') + field('Last used scene', 'lastUsedSceneId', runtime.lastUsedSceneId)
                + field('Active effects (JSON)', 'activeEffectsJson', JSON.stringify(runtime.activeEffects || [], null, 2), 'textarea') + field('Runtime notes', 'runtimeNotes', runtime.notes, 'textarea')
                + '</div><div class="toolbar"><button class="btn primary" data-action="activate">Activate</button><button class="btn" data-action="advance-runtime">Advance 1 turn</button><button class="btn" data-action="save-runtime">Save runtime</button><button class="btn" data-action="reset-runtime">Reset encounter</button></div></div>' : '<div class="muted">Save the assignment before editing runtime state.</div>')
            + (ability ? '<div class="muted">Definition: ' + esc(ability.effect || ability.description) + '</div>' : '') + '</section></div>';
    }

    function collectAssignmentForm(existing, owner) {
        const get = (key) => document.querySelector('[data-field="' + key + '"]');
        return {
            ...existing, ownerType: owner.type, ownerId: owner.id, abilityId: get('abilityId').value, mastery: get('mastery').value,
            variantName: get('variantName').value, learnedSceneId: get('learnedSceneId').value, modifications: list(get('modificationsText').value), notes: get('notes').value,
            masteryTierId: get('masteryTierId').value, unlockedUpgradeIds: list(get('unlockedUpgradeIdsText').value),
            trainingProgress: Math.max(0, number(get('trainingProgress').value)), trainingGoal: Math.max(0, number(get('trainingGoal').value)),
            trainingMilestones: parseJson(get('trainingMilestonesJson').value, existing.trainingMilestones || []), promptEnabled: get('assignmentPromptEnabled').checked, updatedAt: Date.now(),
        };
    }
    async function saveRuntime(action) {
        const runtime = runtimeFor(selectedAssignmentId);
        const get = (key) => document.querySelector('[data-field="' + key + '"]');
        runtime.cooldownRemaining = Math.max(0, number(get('cooldownRemaining').value));
        runtime.cooldownMax = Math.max(0, number(get('cooldownMax').value));
        runtime.chargesRemaining = get('chargesRemaining').value === '' ? null : Math.max(0, number(get('chargesRemaining').value));
        runtime.chargesMax = get('chargesMax').value === '' ? null : Math.max(0, number(get('chargesMax').value));
        runtime.uses = Math.max(0, number(get('uses').value)); runtime.lastUsedSceneId = get('lastUsedSceneId').value;
        runtime.activeEffects = parseJson(get('activeEffectsJson').value, runtime.activeEffects || []); runtime.notes = get('runtimeNotes').value;
        if (action === 'activate') {
            if (runtime.cooldownRemaining > 0 || (runtime.chargesRemaining !== null && runtime.chargesRemaining <= 0)) return notify('Ability is not ready', true);
            runtime.cooldownRemaining = runtime.cooldownMax;
            if (runtime.chargesRemaining !== null) runtime.chargesRemaining = Math.max(0, runtime.chargesRemaining - 1);
            runtime.uses += 1;
        } else if (action === 'advance') {
            runtime.cooldownRemaining = Math.max(0, runtime.cooldownRemaining - 1);
            runtime.activeEffects = runtime.activeEffects.map((effect) => ({ ...effect, remainingTurns: Math.max(0, number(effect.remainingTurns) - 1) })).filter((effect) => effect.remainingTurns > 0);
        } else if (action === 'reset') {
            runtime.cooldownRemaining = 0; runtime.chargesRemaining = runtime.chargesMax; runtime.activeEffects = [];
        }
        runtime.updatedAt = Date.now();
        await saveTable('runtime', state.runtime);
        await rebuildPromptIndex();
        notify('Runtime state saved'); render();
    }

    function parseSheetAbility(source) {
        const raw = text(source); if (!raw) return null;
        const cantrip = raw.match(/^cantrip\s*:\s*(.+)$/i); if (cantrip) return { name: cantrip[1].replace(/\s*\([^)]*\)\s*$/, '').trim(), category: 'active', origin: 'spell', effect: raw, activation: 'Cast as a cantrip' };
        const spell = raw.match(/^((?:\d+(?:st|nd|rd|th)|[a-z]+)-level)\s+spell\s*:\s*(.+)$/i); if (spell) return { name: spell[2].replace(/\s*\([^)]*\)\s*$/, '').trim(), category: 'active', origin: 'spell', effect: raw, activation: 'Cast as a ' + spell[1].toLowerCase() + ' spell' };
        const colon = raw.indexOf(':'); if (colon > 0) return { name: raw.slice(0, colon).trim(), category: 'active', origin: 'trained', effect: raw, activation: '' };
        const passive = /\b(darkvision|resistance|immunity|presence|feat|proficiency)\b/i.test(raw); return { name: raw, category: passive ? 'passive' : 'active', origin: passive ? 'innate' : 'trained', effect: raw, activation: '' };
    }
    async function importCharacterSheet() {
        notify('Automatic character-sheet import is not part of the frozen Gen 1 screen API. Queue an AI scan or import a JSON compendium instead.', true);
    }
    async function acceptProposal(proposal) {
        let ability = state.abilities.find((entry) => entry.id === proposal.abilityId);
        if (proposal.kind === 'new') {
            ability = state.abilities.find((entry) => canonical(entry.name) === canonical(proposal.abilityName));
            if (!ability) {
                ability = normalizeAbility({ ...emptyAbility(), name: proposal.abilityName, category: proposal.category, origin: proposal.origin, effect: proposal.effect, activation: proposal.activation, source: proposal.sourceProfileAbility ? 'Imported from character sheet' : 'Discovered in play', gmNotes: [proposal.reason, proposal.evidence].filter(Boolean).join('\n') });
                if (!ability) return false; state.abilities.push(ability);
            }
        }
        if (!ability) return false;
        if ((proposal.kind === 'assign' || proposal.kind === 'new') && proposal.ownerType && proposal.ownerId) {
            if (!state.assignments.some((entry) => entry.abilityId === ability.id && entry.ownerType === proposal.ownerType && entry.ownerId === proposal.ownerId)) {
                state.assignments.push({ ...emptyAssignment({ type: proposal.ownerType, id: proposal.ownerId }, ability.id), mastery: proposal.mastery || '', masteryTierId: proposal.masteryTierId || '', modifications: proposal.modification ? [proposal.modification] : [], learnedSceneId: proposal.sourceSceneId || '', notes: proposal.reason || '' });
            }
        }
        if (proposal.kind === 'progression') {
            const assignment = state.assignments.find((entry) => entry.abilityId === ability.id && entry.ownerType === proposal.ownerType && entry.ownerId === proposal.ownerId);
            if (!assignment) return false;
            if (proposal.mastery) assignment.mastery = proposal.mastery; if (proposal.masteryTierId) assignment.masteryTierId = proposal.masteryTierId;
            if (proposal.upgradeId && !assignment.unlockedUpgradeIds.includes(proposal.upgradeId)) assignment.unlockedUpgradeIds.push(proposal.upgradeId);
            assignment.trainingProgress = Math.max(0, number(assignment.trainingProgress) + Math.max(0, number(proposal.trainingDelta)));
            if (proposal.modification && !assignment.modifications.includes(proposal.modification)) assignment.modifications.push(proposal.modification);
        }
        if (proposal.sourceProfileAbility) state.config.consumedProfileAbilities = Array.from(new Set([...(state.config.consumedProfileAbilities || []), proposal.sourceProfileAbility]));
        state.proposals = state.proposals.filter((entry) => entry.id !== proposal.id);
        await Promise.all([saveTable('abilities', state.abilities), saveTable('assignments', state.assignments), saveTable('proposals', state.proposals), saveTable('config', state.config)]); await rebuildPromptIndex(); return true;
    }

    function renderDiscoveries() {
        document.getElementById('body').innerHTML = '<section class="card pad"><div class="toolbar section"><button class="btn primary" data-action="queue-scan">Queue AI scan</button><span class="muted">Character-sheet import is unavailable on the isolated Gen 1 screen; use AI scan or JSON import.</span><button class="btn" data-action="accept-all" ' + (!state.proposals.length ? 'disabled' : '') + '>Add all</button><button class="btn danger" data-action="dismiss-all" ' + (!state.proposals.length ? 'disabled' : '') + '>Dismiss all</button><span class="muted">AI scans run safely during the next committed post-turn pass.</span></div>'
            + (state.config.scanRequested ? '<div class="proposal">AI scan queued for the next committed turn.</div>' : '')
            + (state.proposals.length ? state.proposals.map((proposal) => '<article class="proposal"><div class="toolbar"><span class="badge">' + esc(proposal.kind) + '</span><strong>' + esc(proposal.abilityName || state.abilities.find((ability) => ability.id === proposal.abilityId)?.name || 'Ability proposal') + '</strong><span class="spacer"></span><button class="btn primary" data-accept="' + esc(proposal.id) + '">Accept</button><button class="btn danger" data-dismiss="' + esc(proposal.id) + '">Dismiss</button></div><p>' + esc(proposal.reason || '') + '</p><div class="muted">Owner: ' + esc(proposal.ownerType && proposal.ownerId ? ownerName(proposal.ownerType, proposal.ownerId) : 'Library only') + '</div><div class="muted">Evidence: ' + esc(proposal.evidence || 'None supplied') + '</div></article>').join('') : '<div class="empty">No ability changes are awaiting review.</div>') + '</section>';
    }

    function renderTerminology() {
        const originFields = ORIGINS.map((origin) => field('Origin Â· ' + DEFAULT_ORIGIN_LABELS[origin], 'term-origin-' + origin, state.config.terminology.originLabels?.[origin] || '')).join('');
        const categoryFields = CATEGORIES.map((category) => field('Category Â· ' + DEFAULT_CATEGORY_LABELS[category], 'term-category-' + category, state.config.terminology.categoryLabels?.[category] || '')).join('');
        document.getElementById('body').innerHTML = '<section class="card pad"><div class="toolbar section"><button class="btn primary" data-action="save-terminology">Save terminology</button><label><input id="auto-scan" type="checkbox" ' + (state.config.autoScan ? 'checked' : '') + '> Automatically scan committed turns</label></div><p class="muted">Stable internal keys remain portable. These labels change only how this campaign presents them.</p><div class="grid two section">' + originFields + categoryFields + '</div></section>';
    }

    function render() {
        renderTabs();
        if (tab === 'library') renderLibrary();
        else if (tab === 'characters') renderCharacters();
        else if (tab === 'discoveries') renderDiscoveries();
        else renderTerminology();
    }

    document.addEventListener('click', async (event) => {
        const target = event.target.closest('button'); if (!target) return;
        if (target.dataset.tab) { tab = target.dataset.tab; render(); return; }
        if (target.dataset.ability) { selectedAbilityId = target.dataset.ability; render(); return; }
        if (target.dataset.assignment) { selectedAssignmentId = target.dataset.assignment; render(); return; }
        if (target.dataset.accept) { const proposal = state.proposals.find((entry) => entry.id === target.dataset.accept); if (proposal && await acceptProposal(proposal)) { notify('Proposal accepted'); render(); } return; }
        if (target.dataset.dismiss) { state.proposals = state.proposals.filter((entry) => entry.id !== target.dataset.dismiss); await saveTable('proposals', state.proposals); render(); return; }
        const action = target.dataset.action;
        if (action === 'new-ability') { selectedAbilityId = ''; render(); }
        else if (action === 'import') document.getElementById('import-file').click();
        else if (action === 'export') await exportCompendium();
        else if (action === 'save-ability') {
            const ability = collectAbilityForm(); if (!ability) return notify('Ability name is required', true);
            const index = state.abilities.findIndex((entry) => entry.id === selectedAbilityId); if (index >= 0) state.abilities[index] = ability; else state.abilities.push(ability);
            selectedAbilityId = ability.id; await saveTable('abilities', state.abilities); await rebuildPromptIndex(); notify('Ability saved'); render();
        } else if (action === 'duplicate-ability') {
            const ability = collectAbilityForm(); if (!ability) return; const now = Date.now(); ability.id = uid('ability'); ability.name += ' Copy'; ability.createdAt = now; ability.updatedAt = now; state.abilities.push(ability); selectedAbilityId = ability.id; await saveTable('abilities', state.abilities); await rebuildPromptIndex(); render();
        } else if (action === 'delete-ability') {
            const id = selectedAbilityId; state.abilities = state.abilities.filter((entry) => entry.id !== id); const removed = new Set(state.assignments.filter((entry) => entry.abilityId === id).map((entry) => entry.id)); state.assignments = state.assignments.filter((entry) => entry.abilityId !== id); state.runtime = state.runtime.filter((entry) => !removed.has(entry.characterAbilityId)); selectedAbilityId = state.abilities[0]?.id || ''; await Promise.all([saveTable('abilities', state.abilities), saveTable('assignments', state.assignments), saveTable('runtime', state.runtime)]); await rebuildPromptIndex(); render();
        } else if (action === 'new-assignment') { selectedAssignmentId = ''; render(); }
        else if (action === 'save-assignment') {
            const owner = ownerFromKey(selectedOwnerKey); if (!owner) return notify('Choose a character', true); const existing = state.assignments.find((entry) => entry.id === selectedAssignmentId) || emptyAssignment(owner, ''); const assignment = collectAssignmentForm(existing, owner); if (!assignment.abilityId) return notify('Choose an ability', true); const index = state.assignments.findIndex((entry) => entry.id === selectedAssignmentId); if (index >= 0) state.assignments[index] = assignment; else state.assignments.push(assignment); selectedAssignmentId = assignment.id; await saveTable('assignments', state.assignments); await rebuildPromptIndex(); notify('Character ability saved'); render();
        } else if (action === 'delete-assignment') { state.assignments = state.assignments.filter((entry) => entry.id !== selectedAssignmentId); state.runtime = state.runtime.filter((entry) => entry.characterAbilityId !== selectedAssignmentId); selectedAssignmentId = ''; await Promise.all([saveTable('assignments', state.assignments), saveTable('runtime', state.runtime)]); await rebuildPromptIndex(); render(); }
        else if (['activate', 'advance-runtime', 'save-runtime', 'reset-runtime'].includes(action)) await saveRuntime(action === 'advance-runtime' ? 'advance' : action === 'reset-runtime' ? 'reset' : action === 'activate' ? 'activate' : 'save');
        else if (action === 'queue-scan') { state.config.scanRequested = true; await saveTable('config', state.config); notify('AI scan queued'); render(); }
        else if (action === 'import-sheet') await importCharacterSheet();
        else if (action === 'accept-all') { let accepted = 0; for (const proposal of [...state.proposals]) if (await acceptProposal(proposal)) accepted += 1; notify('Accepted ' + accepted + ' proposals'); render(); }
        else if (action === 'dismiss-all') { state.proposals = []; await saveTable('proposals', []); render(); }
        else if (action === 'save-terminology') {
            const originLabels = {}; const categoryLabels = {};
            for (const origin of ORIGINS) { const value = text(document.querySelector('[data-field="term-origin-' + origin + '"]')?.value); if (value) originLabels[origin] = value; }
            for (const category of CATEGORIES) { const value = text(document.querySelector('[data-field="term-category-' + category + '"]')?.value); if (value) categoryLabels[category] = value; }
            state.config.terminology = { originLabels, categoryLabels }; state.config.autoScan = document.getElementById('auto-scan').checked; await saveTable('config', state.config); notify('Terminology saved'); render();
        }
    });
    document.addEventListener('change', (event) => {
        if (event.target.dataset.field === 'origin-filter') { originFilter = event.target.value; render(); }
        if (event.target.dataset.field === 'owner') { selectedOwnerKey = event.target.value; selectedAssignmentId = ''; render(); }
    });
    document.addEventListener('input', (event) => {
        if (event.target.dataset.field === 'search') { query = event.target.value; renderLibrary(); }
    });

    render();
}
