/* Phase 8.4: imperative Enemy UI owned by the enemies native mod. */
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const makeId = () => globalThis.crypto?.randomUUID?.() ?? 'enemy-' + Date.now() + '-' + Math.random().toString(16).slice(2);
const splitLines = value => String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const joinLines = value => Array.isArray(value) ? value.join('\n') : String(value || '');
const pairLines = (value, key) => Array.isArray(value) ? value.map(item => item.name + (item[key] ? ': ' + item[key] : '')).join('\n') : '';
const parsePairs = (value, key) => String(value || '').split(/\r?\n/).map(item => {
    const index = item.indexOf(':');
    const name = (index < 0 ? item : item.slice(0, index)).trim();
    const detail = (index < 0 ? '' : item.slice(index + 1)).trim();
    return name ? { name, [key]: detail } : null;
}).filter(Boolean);

function node(tag, props, ...children) {
    const result = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value == null || value === false) continue;
        if (key === 'className') result.className = value;
        else if (key === 'onClick' || key === 'onInput' || key === 'onChange') result.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'checked' || key === 'value' || key === 'disabled' || key === 'placeholder' || key === 'type') result[key] = value;
        else result.setAttribute(key === 'ariaLabel' ? 'aria-label' : key, String(value));
    }
    for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        result.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return result;
}

const action = (label, callback, className = 'enemy-btn') => node('button', { type: 'button', className, onClick: callback }, label);
const field = (label, value, callback, multiline = false) => node('label', { className: 'enemy-field' },
    node('span', { className: 'enemy-label' }, label),
    node(multiline ? 'textarea' : 'input', { className: 'enemy-input', value: value ?? '', onInput: event => callback(event.target.value) }),
);
const toggle = (label, checked, callback) => node('label', { className: 'enemy-check' },
    node('input', { type: 'checkbox', checked, onChange: event => callback(event.target.checked) }), label,
);
const choose = (label, value, options, callback) => node('label', { className: 'enemy-field' },
    node('span', { className: 'enemy-label' }, label),
    node('select', { className: 'enemy-input', value, onChange: event => callback(event.target.value) },
        options.map(option => node('option', { value: option[0] }, option[1]))),
);
const blankEnemy = (name = '') => {
    const now = Date.now();
    return { id: makeId(), name, aliases: '', classification: '', description: '', threatTier: '', tags: [], faction: '', stats: [], actions: [], passiveTraits: [], specialBehaviors: [], weaknesses: [], resistances: [], tactics: '', loot: '', gmNotes: '', promptEnabled: true, createdAt: now, updatedAt: now };
};

// Phase 9.9.2 — every live window's repaint, so the mod can redraw one when its
// data arrives from somewhere the window cannot see.
//
// The window's own `sync()` subscriptions cover writes, and they are not enough
// on their own: `createReactiveReadHub` REVOKES every one of a mod's leases the
// moment the campaign id changes (`reactiveReads.ts` flush — "campaign data is
// not portable between campaigns"), and a fresh lease only delivers on the NEXT
// store change. A campaign open is therefore invisible to them: `state` is
// filled by `enemyData.hydrate` on `campaign.opened`, which used to update the
// header and nothing else. The window had already painted — from an empty
// `state` on a cold start, or from the PREVIOUS campaign's records after a
// switch — and stayed that way until the user happened to click a tab.
//
// What that looked like: open a campaign whose compendium has just been
// adopted, open the compendium, and the roster is EMPTY. The monsters are on
// disk and in memory; only the DOM is stale. Which is indistinguishable, to the
// person looking at it, from the migration having eaten their compendium.
const painters = new Set();

/** Redraw every mounted compendium window. Called after `hydrate` (index.js). */
export function repaintEnemyWindows() {
    for (const paint of [...painters]) {
        try { paint(); } catch { /* one window's paint must not stop the others */ }
    }
}

export function mountEnemyCompendium(root, ctx, api) {
    let tab = 'templates';
    let templateId = null;
    let instanceId = null;
    let encounterId = null;
    let draft = null;
    let resolution = null;
    let query = '';
    let alive = true;
    const state = api.state;
    const data = api.data;
    // Phase 8.5 — corrected. The host's `__narrativeTranslate` is `translateIn`,
    // whose signature is `(locale, key, vars)`. This called it as `(key, vars)`,
    // so every lookup passed the key as the LOCALE, got an empty object back,
    // and rendered `[object Object]` into every tab, button and field label in
    // the window. The mod's own i18n files were fine; nothing ever read them.
    //
    // The locale comes from `data-lang` on `<html>`, which `applyLocale` stamps
    // and which is already the documented per-language styling hook — the mod
    // API has no `ctx.t`, so this global is the only route available.
    //
    // The `typeof === 'string'` guard is the part worth keeping regardless of
    // the signature: `node()` stringifies whatever it is handed, so a non-string
    // slipping through is a label that reads `[object Object]` rather than an
    // error anybody would notice.
    const t = (key, vars) => {
        const translate = globalThis.__narrativeTranslate;
        if (typeof translate !== 'function') return key;
        const locale = document.documentElement.getAttribute('data-lang') || 'en';
        const translated = translate(locale, 'mod.enemies.' + key, vars || {});
        return typeof translated === 'string' ? translated : key;
    };
    const run = task => Promise.resolve().then(task).catch(error => ctx.log?.('[enemies] UI action failed:', error));
    const sync = (name, repair, assign) => {
        try {
            const stop = ctx.table.subscribe(name, raw => {
                if (!alive) return;
                assign(repair(raw));
                paint();
            });
            if (typeof stop === 'function') stops.push(stop);
        } catch (error) {
            ctx.log?.('[enemies] table subscription unavailable:', name, error);
        }
    };
    const stops = [];
    const newSuggestion = suggestion => api.setSuggestions([...api.getSuggestions(), { id: makeId(), ...suggestion }]);

    function editTemplate(template) {
        templateId = template?.id || null;
        draft = copy(template);
    }

    function saveTemplate() {
        if (!draft || !String(draft.name || '').trim()) return;
        const task = state.compendium.some(item => item.id === draft.id)
            ? data.updateEnemy(ctx, draft.id, draft)
            : data.addEnemy(ctx, draft);
        run(() => task.then(paint));
    }

    function renderTemplateEditor(template) {
        if (!template) return node('div', { className: 'enemy-editor enemy-empty' }, t('templates.empty'));
        const patch = (key, value) => { draft = { ...draft, [key]: value }; };
        const specs = [
            ['name', 'templates.name'], ['aliases', 'templates.aliases'], ['classification', 'templates.classification'],
            ['threatTier', 'templates.threatTier'], ['faction', 'templates.faction'],
            ['description', 'templates.description', true], ['tactics', 'templates.tactics', true],
            ['loot', 'templates.loot', true], ['gmNotes', 'templates.gmNotes', true],
            ['stats', 'templates.stats', true, 'value'], ['actions', 'templates.actions', true, 'description'],
            ['passiveTraits', 'templates.passiveTraits', true], ['specialBehaviors', 'templates.specialBehaviors', true],
            ['weaknesses', 'templates.weaknesses', true], ['resistances', 'templates.resistances', true],
        ];
        const controls = specs.map(([key, labelKey, multiline, pairKey]) => {
            const value = pairKey ? pairLines(template[key], pairKey) : Array.isArray(template[key]) ? joinLines(template[key]) : template[key];
            return field(t(labelKey), value, next => patch(key, pairKey ? parsePairs(next, pairKey) : (Array.isArray(template[key]) ? splitLines(next) : next)), multiline);
        });
        return node('div', { className: 'enemy-editor' },
            node('div', { className: 'enemy-editor-header' },
                node('div', {}, node('h2', {}, template.name || t('templates.unclassified')), node('span', { className: 'enemy-muted' }, template.classification || '')),
                node('div', { className: 'enemy-actions' },
                    action(t('templates.save'), saveTemplate),
                    action(t('templates.duplicate'), () => {
                        const copyOfTemplate = { ...copy(template), id: makeId(), name: (template.name || 'Enemy') + ' copy' };
                        run(() => data.addEnemy(ctx, copyOfTemplate).then(() => { editTemplate(copyOfTemplate); paint(); }));
                    }),
                    action(t('templates.delete'), () => run(() => data.removeEnemy(ctx, template.id).then(() => { draft = null; templateId = null; paint(); })), 'enemy-btn enemy-btn-danger'),
                ),
            ),
            node('div', { className: 'enemy-form-grid' }, controls),
            toggle(t('templates.promptEnabled'), template.promptEnabled !== false, value => patch('promptEnabled', value)),
        );
    }

    function renderSuggestions() {
        const suggestions = api.getSuggestions();
        const cards = suggestions.map(suggestion => node('div', { className: 'enemy-card' },
            node('strong', {}, suggestion.name),
            suggestion.classification ? node('span', { className: 'enemy-muted' }, suggestion.classification) : null,
            suggestion.reason ? node('p', {}, suggestion.reason) : null,
            node('div', { className: 'enemy-actions' },
                action(t('suggestions.accept'), () => run(async () => {
                    if (suggestion.targetEnemyId) await data.updateEnemy(ctx, suggestion.targetEnemyId, { aliases: suggestion.name });
                    else await data.addEnemy(ctx, blankEnemy(suggestion.name));
                    api.setSuggestions(api.getSuggestions().filter(item => item.id !== suggestion.id));
                    paint();
                })),
                action(t('suggestions.dismiss'), () => { api.setSuggestions(api.getSuggestions().filter(item => item.id !== suggestion.id)); paint(); }, 'enemy-btn enemy-btn-muted'),
            ),
        ));
        return node('section', { className: 'enemy-suggestions' }, node('h3', {}, t('suggestions.title')),
            cards.length ? node('div', { className: 'enemy-stack' }, cards) : node('p', { className: 'enemy-empty' }, t('suggestions.empty')));
    }

    function templatesView() {
        const visible = state.compendium.filter(item => !query || [item.name, item.aliases, item.classification, item.faction].join(' ').toLowerCase().includes(query.toLowerCase()));
        if (!templateId && visible[0]) editTemplate(visible[0]);
        const rows = visible.map(item => node('button', { type: 'button', className: 'enemy-list-row' + (item.id === templateId ? ' selected' : ''), onClick: () => { editTemplate(item); paint(); } },
            node('strong', {}, item.name || t('templates.unclassified')), node('span', {}, item.classification || '')));
        const importInput = node('input', { type: 'file', accept: 'application/json,.json', className: 'enemy-hidden', onChange: event => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    run(async () => { await data.setEnemyCompendium(ctx, api.repairCompendium(JSON.parse(await file.text()))); paint(); });
                    event.target.value = '';
                } });
        return node('div', { className: 'enemy-split' },
            node('aside', { className: 'enemy-sidebar' },
                node('input', { className: 'enemy-input', placeholder: t('templates.search'), value: query, onInput: event => { query = event.target.value; paint(); } }),
                action(t('templates.new'), () => run(async () => { const item = blankEnemy(); await data.addEnemy(ctx, item); editTemplate(item); paint(); })),
                node('div', { className: 'enemy-actions' },
                    action(t('templates.export'), () => {
                        const blob = new Blob([JSON.stringify(state.compendium, null, 2)], { type: 'application/json' });
                        const anchor = node('a', { href: URL.createObjectURL(blob), download: 'enemy-compendium.json' });
                        anchor.click();
                        URL.revokeObjectURL(anchor.href);
                    }),
                    action(t('templates.import'), () => importInput.click()),
                ),
                importInput,
                rows.length ? node('div', { className: 'enemy-list' }, rows) : node('p', { className: 'enemy-empty' }, t('templates.empty')),
                renderSuggestions(),
            ),
            renderTemplateEditor(visible.find(item => item.id === templateId) || draft),
        );
    }


    function instancesView() {
        const sorted = [...state.instances].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (!instanceId && sorted[0]) instanceId = sorted[0].id;
        const instance = sorted.find(item => item.id === instanceId);
        const templates = [['', t('instances.selectTemplate')], ...state.compendium.map(item => [item.id, item.name])];
        const editor = instance ? node('div', { className: 'enemy-editor' },
            node('div', { className: 'enemy-editor-header' }, node('h2', {}, instance.displayName),
                action(t('instances.delete'), () => run(() => data.removeEnemyInstance(ctx, instance.id).then(() => { instanceId = null; paint(); })), 'enemy-btn enemy-btn-danger')),
            node('div', { className: 'enemy-form-grid' },
                field(t('instances.displayName'), instance.displayName, value => run(() => data.updateEnemyInstance(ctx, instance.id, { displayName: value }).then(paint))),
                field(t('instances.currentHp'), instance.currentHp, value => run(() => data.updateEnemyInstance(ctx, instance.id, { currentHp: Number(value) || 0 }).then(paint))),
                field(t('instances.maxHp'), instance.maxHp, value => run(() => data.updateEnemyInstance(ctx, instance.id, { maxHp: Number(value) || 0 }).then(paint))),
                field(t('instances.currentBarrier'), instance.currentBarrier, value => run(() => data.updateEnemyInstance(ctx, instance.id, { currentBarrier: Number(value) || 0 }).then(paint))),
                field(t('instances.maxBarrier'), instance.maxBarrier, value => run(() => data.updateEnemyInstance(ctx, instance.id, { maxBarrier: Number(value) || 0 }).then(paint))),
                field(t('instances.conditions'), joinLines(instance.conditions), value => run(() => data.updateEnemyInstance(ctx, instance.id, { conditions: splitLines(value) }).then(paint)), true),
                field(t('instances.modifiers'), joinLines(instance.temporaryModifiers), value => run(() => data.updateEnemyInstance(ctx, instance.id, { temporaryModifiers: splitLines(value) }).then(paint)), true),
            ),
            toggle(t('instances.defeated'), instance.defeated, value => run(() => data.updateEnemyInstance(ctx, instance.id, { defeated: value }).then(paint))),
        ) : node('div', { className: 'enemy-editor enemy-empty' }, t('instances.none'));
        const rows = sorted.map(item => node('button', { type: 'button', className: 'enemy-list-row' + (item.id === instanceId ? ' selected' : ''), onClick: () => { instanceId = item.id; paint(); } }, node('strong', {}, item.displayName), node('span', {}, item.currentHp + '/' + item.maxHp)));
        return node('div', { className: 'enemy-split' },
            node('aside', { className: 'enemy-sidebar' }, choose(t('instances.selectTemplate'), '', templates, value => value && run(async () => { const item = await data.spawnEnemyInstance(ctx, value); instanceId = item?.id; paint(); })), rows.length ? node('div', { className: 'enemy-list' }, rows) : node('p', { className: 'enemy-empty' }, t('instances.none'))),
            editor,
        );
    }

    function encountersView() {
        if (!encounterId && state.encounters[0]) encounterId = state.encounters[0].id;
        const encounter = state.encounters.find(item => item.id === encounterId);
        const rows = state.encounters.map(item => node('button', { type: 'button', className: 'enemy-list-row' + (item.id === encounterId ? ' selected' : ''), onClick: () => { encounterId = item.id; paint(); } }, node('strong', {}, item.name), node('span', {}, item.status)));
        const sidebar = node('aside', { className: 'enemy-sidebar' }, action(t('encounters.new'), () => run(async () => { const item = await data.createEnemyEncounter(ctx, t('encounters.new')); encounterId = item?.id; paint(); })), rows.length ? node('div', { className: 'enemy-list' }, rows) : node('p', { className: 'enemy-empty' }, t('encounters.empty')));
        if (!encounter) return node('div', { className: 'enemy-split' }, sidebar, node('div', { className: 'enemy-empty' }, t('encounters.empty')));
        const wave = encounter.waves.find(item => item.id === encounter.activeWaveId) || encounter.waves[0];
        const assigned = new Set(wave?.instanceIds || []);
        const roster = state.instances.map(instance => node('div', { className: 'enemy-roster-row' },
            toggle(instance.displayName, assigned.has(instance.id), value => run(() => data.setEnemyEncounterInstanceAssigned(ctx, encounter.id, wave.id, instance.id, value).then(paint))),
            assigned.has(instance.id) ? toggle(t('encounters.onField'), (wave.activeInstanceIds || []).includes(instance.id), value => run(() => data.setEnemyEncounterInstanceActive(ctx, encounter.id, wave.id, instance.id, value).then(paint))) : null));
        return node('div', { className: 'enemy-split' }, sidebar, node('div', { className: 'enemy-editor' },
            node('div', { className: 'enemy-editor-header' }, node('h2', {}, encounter.name), node('div', { className: 'enemy-actions' },
                action(encounter.status === 'active' ? t('encounters.pause') : t('encounters.resume'), () => run(() => data.setEnemyEncounterStatus(ctx, encounter.id, encounter.status === 'active' ? 'paused' : 'active').then(paint))),
                action(t('encounters.addWave'), () => run(() => data.addEnemyEncounterWave(ctx, encounter.id).then(paint))),
                action(t('encounters.resolve'), () => { resolution = { outcome: 'victory', summary: '', xpAwarded: 0, lootAwarded: [], otherRewards: [], instanceDisposition: 'archive' }; paint(); }),
            )),
            choose('Wave', wave?.id, encounter.waves.map(item => [item.id, item.name]), value => run(() => data.updateEnemyEncounter(ctx, encounter.id, { activeWaveId: value }).then(paint))),
            roster.length ? node('div', { className: 'enemy-stack' }, roster) : node('p', { className: 'enemy-empty' }, t('instances.none')),
            renderResolution(encounter),
        ));
    }

    function renderResolution(encounter) {
        if (!resolution) return null;
        const patch = (key, value) => { resolution = { ...resolution, [key]: value }; paint(); };
        return node('div', { className: 'enemy-overlay' }, node('div', { className: 'enemy-dialog' }, node('h2', {}, t('resolution.title')),
            choose(t('resolution.outcome'), resolution.outcome, [['victory', 'Victory'], ['defeat', 'Defeat'], ['fled', 'Fled'], ['mixed', 'Mixed']], value => patch('outcome', value)),
            field(t('resolution.summary'), resolution.summary, value => patch('summary', value), true),
            field(t('resolution.xp'), resolution.xpAwarded, value => patch('xpAwarded', Number(value) || 0)),
            field(t('resolution.loot'), joinLines(resolution.lootAwarded), value => patch('lootAwarded', splitLines(value)), true),
            choose(t('resolution.disposition'), resolution.instanceDisposition, [['archive', t('resolution.archive')], ['discard', t('resolution.discard')]], value => patch('instanceDisposition', value)),
            node('div', { className: 'enemy-actions' }, action(t('resolution.cancel'), () => { resolution = null; paint(); }, 'enemy-btn enemy-btn-muted'), action(t('resolution.confirm'), () => run(() => data.resolveEnemyEncounter(ctx, encounter.id, resolution).then(() => { resolution = null; paint(); })))),
        ));
    }

    function combatView() {
        const encounter = state.encounters.find(item => item.status === 'active');
        const wave = encounter?.waves.find(item => item.id === encounter.activeWaveId);
        const ids = new Set(wave?.activeInstanceIds || []);
        const combatants = state.instances.filter(item => ids.has(item.id) && !item.defeated);
        const cards = combatants.map(instance => node('div', { className: 'enemy-card' },
            node('div', { className: 'enemy-editor-header' }, node('h3', {}, instance.displayName), node('strong', {}, instance.currentHp + '/' + instance.maxHp + ' HP')),
            node('div', { className: 'enemy-meter' }, node('span', { style: { width: Math.max(0, Math.min(100, instance.currentHp / Math.max(1, instance.maxHp) * 100)) + '%' } })),
            node('div', { className: 'enemy-actions' },
                field(t('combat.damage'), 0, value => instance.__damage = Number(value) || 0),
                field(t('combat.damageType'), '', value => instance.__damageType = value),
                action(t('combat.apply'), () => run(() => data.applyEnemyDamage(ctx, instance.id, instance.__damage || 0, instance.__damageType || '').then(paint))),
                action(t('combat.roll'), () => run(() => data.rollEnemyInitiatives(ctx, [instance.id]).then(paint))),
                action(t('combat.beginTurn'), () => run(() => data.beginEnemyTurn(ctx, instance.id).then(paint))),
                action(t('combat.spendAction'), () => run(() => data.spendEnemyAction(ctx, instance.id, 'action').then(paint))),
            )));
        const config = state.config;
        return node('div', { className: 'enemy-combat' },
            node('div', { className: 'enemy-card enemy-config' }, node('h3', {}, t('combat.config')),
                toggle(t('combat.enabled'), config.enabled, value => run(() => data.setEnemyCombatConfig(ctx, { enabled: value }).then(paint))),
                toggle(t('combat.promptContext'), config.promptContextEnabled, value => run(() => data.setEnemyCombatConfig(ctx, { promptContextEnabled: value }).then(paint))),
                toggle(t('combat.discovery'), config.enemyDiscoveryEnabled, value => run(() => data.setEnemyCombatConfig(ctx, { enemyDiscoveryEnabled: value }).then(paint)))),
            cards.length ? node('div', { className: 'enemy-stack' }, cards) : node('p', { className: 'enemy-empty' }, t('combat.empty')));
    }

    function paint() {
        if (!alive) return;
        const tabs = [['templates', 'modal.tab.templates', state.compendium.length], ['instances', 'modal.tab.instances', state.instances.length], ['encounters', 'modal.tab.encounters', state.encounters.length], ['combat', 'modal.tab.combat', '']];
        const body = tab === 'templates' ? templatesView() : tab === 'instances' ? instancesView() : tab === 'encounters' ? encountersView() : combatView();
        root.replaceChildren(node('div', { className: 'enemy-mod-app' },
            node('div', { className: 'enemy-mod-tabs' }, tabs.map(item => node('button', { type: 'button', className: 'enemy-tab' + (tab === item[0] ? ' active' : ''), onClick: () => { tab = item[0]; paint(); } }, t(item[1]), item[2] ? node('span', { className: 'enemy-count' }, item[2]) : null))),
            node('div', { className: 'enemy-mod-body' }, body)));
    }

    sync('compendium', api.repairCompendium, value => { state.compendium = value; });
    sync('instances', api.repairInstances, value => { state.instances = value; });
    sync('encounters', api.repairEncounters, value => { state.encounters = value; });
    sync('resolutions', api.repairResolutions, value => { state.resolutions = value; });
    sync('config', api.repairConfig, value => { state.config = value; });
    const locale = () => paint();
    globalThis.addEventListener?.('narrative:locale-changed', locale);
    painters.add(paint);
    paint();
    return () => {
        alive = false;
        painters.delete(paint);
        stops.splice(0).forEach(stop => { try { stop(); } catch {} });
        globalThis.removeEventListener?.('narrative:locale-changed', locale);
        root.replaceChildren();
    };
}

export const __enemyUiTest = { blankEnemy, parsePairs, joinLines };