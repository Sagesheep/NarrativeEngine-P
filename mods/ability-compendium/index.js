import mountCompendiumWindow from './legacy-screen.js';

let windowHandle = null;
let headerHandle = null;
let promptRows = [];
let assignmentCount = 0;
let proposalCount = 0;
let activeRuntimeCount = 0;
let cleanupCallbacks = [];
let currentCampaignId = null;
let latestPlayerInput = '';
let latestMessages = [];

/**
 * Converts arbitrary text into the same accent-preserving, punctuation-neutral
 * form used by the compendium index. This directly affects prompt matching only;
 * it never changes stored ability names or campaign prose.
 */
export function canonical(value) {
    return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Selects prompt-index records whose names or aliases occur in recent play.
 * The result feeds the registered `matchedAbilities` macro, so only mentioned
 * powers are injected instead of adding the entire library to every model call.
 */
export function matchPromptRows(rows, sourceText) {
    const haystack = ` ${canonical(sourceText)} `;
    if (!haystack.trim()) return [];
    return (Array.isArray(rows) ? rows : []).filter((row) => {
        return (Array.isArray(row?.terms) ? row.terms : []).some((term) => {
            const needle = canonical(term);
            return needle.length > 1 && haystack.includes(` ${needle} `);
        });
    });
}

/**
 * Joins matched prompt records while respecting the module's declared budget.
 * Trimming here protects the core prompt allocator and affects only optional
 * ability context; canonical library data remains untouched.
 */
export function buildMatchedAbilityPrompt(rows, sourceText, tokens, budget = 1600) {
    const blocks = matchPromptRows(rows, sourceText).map((row) => String(row.text || '').trim()).filter(Boolean);
    const accepted = [];
    for (const block of blocks) {
        const candidate = [...accepted, block].join('\n\n');
        const count = typeof tokens?.count === 'function' ? tokens.count(candidate) : Math.ceil(candidate.length / 4);
        if (count > budget) break;
        accepted.push(block);
    }
    return accepted.join('\n\n');
}

/**
 * Builds the character list expected by the original manager UI from public
 * ModData. This adapter is read-only and is the sole place where host character
 * shapes are translated into compendium owner keys.
 */
function buildCharacters(data) {
    const characters = [];
    if (data.playerCharacter) {
        characters.push({ type: 'pc', id: data.playerCharacter.id || 'player-character', name: data.playerCharacter.name || 'Player Character', archived: false });
    }
    for (const npc of data.npcLedger || []) {
        characters.push({ type: 'npc', id: npc.id, name: npc.name || 'Unnamed NPC', archived: false });
    }
    return characters;
}

/**
 * Returns stable visual tokens for the legacy renderer. These values style only
 * the window interior; host chrome, accessibility behaviour, and theme ownership
 * remain controlled by Narrative Engine.
 */
function getWindowTheme() {
    return {
        colors: {
            background: '#0b0e14', surface: '#151a24', border: '#303849', text: '#e7ebf3',
            muted: '#929bad', accent: '#c8a96a', danger: '#dc6b78',
        },
        fontSizes: { small: '11px', body: '13px', heading: '16px' },
        radii: { small: '5px', medium: '9px' },
    };
}

/**
 * Downloads an exported compendium using browser-native primitives. It is used
 * only by the adapter's file capability and therefore cannot access arbitrary
 * host paths or mutate campaign state.
 */
function downloadJson(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType || 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename || 'ability-compendium.json';
    anchor.click();
    URL.revokeObjectURL(url);
}

/**
 * Adapts the old screen request protocol to the current native ModContext.
 * Every read and write stays inside declared module tables or documented public
 * campaign data, which is what makes the reused editor modular rather than core-bound.
 */
export function createNativeApi(ctx) {
    return {
        async request(request) {
            if (request === 'theme') return getWindowTheme();
            if (!request || typeof request !== 'object') throw new Error('Unsupported compendium request.');
            if (request.capability === 'table.read') return ctx.table.read(request.table);
            if (request.capability === 'table.write') return ctx.table.write(request.table, request.value);
            if (request.capability === 'resize') return undefined;
            if (request.capability === 'file.download') {
                downloadJson(request.filename, request.content, request.mimeType);
                return undefined;
            }
            if (request.capability === 'campaign.read') {
                if (request.resource === 'characters') return buildCharacters(ctx.data);
                if (request.resource === 'character-sheet') return ctx.data.characterSheet;
                if (request.resource === 'inventory') return ctx.data.inventory;
                if (request.resource === 'recent-play') return (ctx.data.messages || []).slice(-20);
            }
            throw new Error(`Unsupported compendium capability: ${request.capability || 'unknown'}`);
        },
    };
}

/**
 * Creates a minimal document facade scoped to the host-owned window node. This
 * prevents selectors and event listeners in the reused UI from escaping into the
 * rest of Narrative Engine while preserving normal browser element creation.
 */
export function createScopedDocument(root) {
    return {
        body: root,
        getElementById(id) {
            return [...root.querySelectorAll('[id]')].find((element) => element.id === id) || null;
        },
        querySelector(selector) {
            return root.querySelector(selector);
        },
        addEventListener(type, listener, options) {
            root.addEventListener(type, listener, options);
        },
        createElement(tagName) {
            return document.createElement(tagName);
        },
    };
}

/**
 * Refreshes header counts and the prompt cache from module tables. It is called
 * at activation and campaign changes; live table subscriptions keep the same
 * values current after edits made by either the UI or compute worker.
 */
async function refreshModuleState(ctx) {
    const [assignments, proposals, runtime, index] = await Promise.all([
        ctx.table.read('assignments'), ctx.table.read('proposals'), ctx.table.read('runtime'), ctx.table.read('prompt-index'),
    ]);
    assignmentCount = Array.isArray(assignments) ? assignments.length : 0;
    proposalCount = Array.isArray(proposals) ? proposals.length : 0;
    activeRuntimeCount = Array.isArray(runtime) ? runtime.filter((row) => Array.isArray(row?.activeEffects) && row.activeEffects.length > 0).length : 0;
    promptRows = Array.isArray(index) ? index : [];
    headerHandle?.update();
}

/**
 * Mounts the manager into the host-owned floating window and bridges its async
 * initialization into the synchronous mount contract. The returned cleanup is
 * safe whether initialization has finished or is still pending.
 */
function mountWindow(node, ctx) {
    const root = document.createElement('div');
    root.className = 'ability-compendium-native-root';
    node.append(root);
    let disposed = false;
    let cleanupView = null;
    void ctx.refresh().then((freshCtx) => mountCompendiumWindow(createNativeApi(freshCtx), createScopedDocument(root))).then((cleanup) => {
        if (disposed) cleanup?.();
        else cleanupView = cleanup;
    }).catch((error) => {
        root.textContent = `Ability Compendium could not open: ${error.message}`;
        ctx.log('window mount failed', error);
    });
    return () => {
        disposed = true;
        cleanupView?.();
        root.remove();
    };
}

/**
 * Registers the Ability Compendium's native integrations. The header button is
 * intentionally stateful so it remains in the main header, while disabling the
 * extension lets the host remove both the button and window automatically.
 */
export async function onActivate(ctx) {
    if (!ctx?.mounts || !ctx?.table) return;
    onDisable();
    await refreshModuleState(ctx);

    windowHandle = ctx.mounts.window({
        id: 'manager', title: 'Ability & Power Compendium',
        defaultSize: { width: 1040, height: 760 }, minSize: { width: 640, height: 440 }, resizable: true,
        mount: mountWindow,
    });
    headerHandle = ctx.mounts.header({
        id: 'openCompendium', icon: 'Sparkles', label: 'ABILITIES',
        tooltip: 'Open the Ability & Power Compendium',
        onSelect: () => windowHandle?.open(),
        state: () => ({
            label: `ABILITIES ${assignmentCount}`,
            badge: proposalCount || undefined,
            tone: proposalCount ? 'warn' : 'default',
            active: activeRuntimeCount > 0,
            hidden: !currentCampaignId,
        }),
    });

    ctx.macros.register('matchedAbilities', () => {
        const recentMessages = latestMessages.slice(-8).map((message) => message.content || '').join('\n');
        return buildMatchedAbilityPrompt(promptRows, `${latestPlayerInput}\n${recentMessages}`, ctx.tokens, 1600);
    });

    currentCampaignId = ctx.data.campaignId;
    latestPlayerInput = ctx.data.playerInput || '';
    latestMessages = Array.isArray(ctx.data.messages) ? ctx.data.messages : [];
    cleanupCallbacks = [
        ctx.table.subscribe('assignments', (rows) => { assignmentCount = Array.isArray(rows) ? rows.length : 0; headerHandle?.update(); }),
        ctx.table.subscribe('proposals', (rows) => { proposalCount = Array.isArray(rows) ? rows.length : 0; headerHandle?.update(); }),
        ctx.table.subscribe('runtime', (rows) => { activeRuntimeCount = Array.isArray(rows) ? rows.filter((row) => Array.isArray(row?.activeEffects) && row.activeEffects.length > 0).length : 0; headerHandle?.update(); }),
        ctx.table.subscribe('prompt-index', (rows) => { promptRows = Array.isArray(rows) ? rows : []; }),
        ctx.subscribe('campaignId', (value) => { currentCampaignId = value; void refreshModuleState(ctx); headerHandle?.update(); }),
        ctx.subscribe('playerInput', (value) => { latestPlayerInput = value || ''; }),
        ctx.subscribe('messages', (value) => { latestMessages = Array.isArray(value) ? value : []; }),
    ];
}

/**
 * Releases subscriptions and local references on disable or reactivation. Host
 * lifecycle teardown removes the registered mounts and macro, while this function
 * prevents stale table listeners from retaining state between campaigns.
 */
export function onDisable() {
    for (const cleanup of cleanupCallbacks) cleanup?.();
    cleanupCallbacks = [];
    windowHandle = null;
    headerHandle = null;
    promptRows = [];
    assignmentCount = 0;
    proposalCount = 0;
    activeRuntimeCount = 0;
    currentCampaignId = null;
    latestPlayerInput = '';
    latestMessages = [];
}
