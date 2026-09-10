// Engine-owned scene seeds. The normal GM turn elaborates these saved facts.
const SCENERY = {
    plains: ['Low grass bends in the wind.', 'Seed heads brush against the travel gear.'],
    farmland: ['Field boundaries break up the cultivated ground.', 'Crop rows stretch across the surrounding fields.'],
    savanna: ['Dry grass rustles around scattered trees.', 'Open grassland leaves long sight lines between the trees.'],
    forest: ['Leaf litter muffles footsteps beneath the canopy.', 'Exposed roots divide patches of shade beneath the trees.'],
    taiga: ['Fallen needles soften the ground beneath the conifers.', 'Resin scents the cool air between the evergreens.'],
    tundra: ['Low vegetation clings to the exposed ground.', 'The open ground offers little shelter from the wind.'],
    desert: ['Loose sand collects in the hollows.', 'Bare sandy ground stretches beyond the stopping place.'],
    marsh: ['Reeds fringe patches of soft, wet ground.', 'Standing water reflects the reeds around the stopping place.'],
    jungle: ['Dense foliage crowds the available ground.', 'Layers of broad leaves limit the view through the undergrowth.'],
    mountain: ['Loose scree lies between exposed rocks.', 'Rocky slopes limit the available footing.'],
    glacier: ['Pale ice reflects the light around the stopping place.', 'Wind brushes loose snow across the ice.'],
    ocean: ['Water stretches around the party.', 'Small waves break across the surrounding surface.'],
};
const PEOPLE = ['Tamsin', 'Orin', 'Sella', 'Venn', 'Iria', 'Corin', 'Neris', 'Daro'];
const SURNAMES = ['Reed', 'Vale', 'Moss', 'Ash', 'Brook', 'Finch', 'Stone', 'Rowan'];
// Eligibility is geography, not an instruction for the GM to force a result.
export const LOCAL_EVENTS = [
    { id: 'road-merchant', road: true, weight: 4, title: 'A roadside merchant', role: 'travelling merchant', motive: 'trade ordinary supplies and learn whether the route ahead is clear', text: '{name} rests beside a pack of small wares at the edge of the worn path.', action: 'I greet the merchant and ask what they have for sale.' },
    { id: 'road-courier', road: true, weight: 2, title: 'A courier taking a breather', role: 'courier', motive: 'find reliable directions before continuing a delivery', text: '{name} checks a folded route sketch beside the path, watching for someone to ask.', action: 'I ask the courier where they are heading.' },
    { id: 'road-repair', road: true, weight: 2, title: 'A broken pack strap', role: 'traveller', motive: 'repair a split strap without losing the daylight', text: '{name} has spread a small load beside the path and is trying to mend a broken strap.', action: 'I approach the traveller and offer to take a look.' },
    { id: 'forest-bear', biomes: ['forest', 'taiga'], weight: 3, title: 'A bear foraging', text: 'A bear noses through the ground cover ahead. It has not approached the party; there is space to watch or give it a wide berth.', action: 'I keep my distance and watch the bear before deciding how to pass.' },
    { id: 'forest-forager', biomes: ['forest', 'jungle'], weight: 2, title: 'A careful forager', role: 'forager', motive: 'finish gathering useful plants before the weather changes', text: '{name} examines leaves beside a partly filled gathering basket.', action: 'I greet the forager and ask about this part of the forest.' },
    { id: 'grazing-animals', biomes: ['plains', 'savanna', 'tundra'], weight: 3, title: 'Grazing animals', text: 'A small group of grazing animals lifts its heads at the party’s approach. The animals remain at a distance.', action: 'I pause to observe the animals without startling them.' },
    { id: 'field-worker', biomes: ['farmland'], weight: 3, title: 'A worker by the fields', role: 'field worker', motive: 'finish the day’s work and hear news from passing travellers', text: '{name} pauses beside the crops and looks toward the party.', action: 'I greet the field worker and ask about the nearby area.' },
    { id: 'sand-tracks', biomes: ['desert'], weight: 3, title: 'Tracks across the sand', text: 'Fresh small-animal tracks cross the sand and disappear behind a low drift. Their maker is out of sight.', action: 'I examine the tracks from where I am standing.' },
    { id: 'marsh-birds', biomes: ['marsh'], weight: 3, title: 'Movement in the reeds', text: 'Water birds lift out of a patch of reeds. Something is moving through the shallow water beneath them.', action: 'I watch the reeds carefully from firm ground.' },
    { id: 'mountain-goats', biomes: ['mountain'], weight: 3, title: 'Goats above the path', text: 'Wild goats pick their way across nearby rocks, dislodging a little scree as they climb.', action: 'I watch their route and check the rocks above us.' },
    { id: 'ice-traces', biomes: ['glacier'], weight: 3, title: 'Old travel marks', text: 'Faint parallel marks interrupt the wind-scoured surface. Their age and direction may be worth examining.', action: 'I examine the marks without leaving our secure footing.' },
    { id: 'passing-boat', biomes: ['ocean'], weight: 3, title: 'Another vessel', text: 'A small vessel is visible at a distance. Nobody aboard has signalled yet.', action: 'I watch the vessel and consider signalling.' },
];
const SITE_PEOPLE = {
    settlement: ['A local with news', 'resident', 'exchange news about the surrounding area', '{name} pauses near the settlement’s activity and acknowledges the party.'],
    ruin: ['Someone studying the ruins', 'explorer', 'understand the visible remains before venturing farther', '{name} studies marks on the ruins from the ground nearby.'],
    shrine: ['A pilgrim at rest', 'pilgrim', 'complete a personal observance in peace', '{name} rests near the shrine with a small wrapped offering.'],
    camp: ['A shared stopping place', 'traveller', 'find out whether the party is willing to share the stopping place', '{name} sorts travelling gear beside another bedroll at the camp.'],
    crossing: ['A traveller at the crossing', 'traveller', 'assess the crossing before carrying equipment over', '{name} studies the crossing while keeping a small load close.'],
    landmark: ['A surveyor comparing notes', 'surveyor', 'reconcile a sketch with the landmark in front of them', '{name} compares the landmark with a page of careful notes.'],
};
function hash(text) { let n = 2166136261; for (const c of text) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0; }
function choose(rows, random) {
    let n = random() * rows.reduce((sum, row) => sum + row.weight, 0);
    return rows.find(row => (n -= row.weight) < 0) ?? rows.at(-1);
}
export function eligibleLocalEvents(input) {
    if (input.feature?.distance === 0 && input.feature.type === 'settlement') return [];
    return LOCAL_EVENTS.filter(row => row.road ? input.onRoad && input.biome !== 'ocean' && input.biome !== 'glacier' : row.biomes.includes(input.biome));
}
function instantiate(row, input, source) {
    const identity = `${input.seed}:${input.worldDay}:${input.x}:${input.y}:${row.id}`;
    const name = row.role ? `${PEOPLE[hash(identity) % PEOPLE.length]} ${SURNAMES[hash(identity + ':surname') % SURNAMES.length]}` : null;
    return { id: row.id, source, title: row.title, text: row.text.replaceAll('{name}', name ?? ''),
        action: row.action ?? `I greet ${name} and ask what brings them here.`,
        ...(name ? { actor: { id: `map-person-${hash(identity).toString(16)}`, name, role: row.role, motive: row.motive } } : {}) };
}
export function localEvent(input, random) {
    const rows = eligibleLocalEvents(input);
    if (!rows.length) return null;
    const row = choose(rows, random);
    return instantiate(row, input, row.road ? 'road' : 'biome');
}
export function siteEvent(input) {
    if (input.feature?.distance !== 0) return null;
    const row = SITE_PEOPLE[input.feature.type];
    if (!row) return null;
    return instantiate({ id: `feature-${input.feature.type}`, title: row[0], role: row[1], motive: row[2], text: row[3] }, input, 'feature');
}
export function localScene(input) {
    const rows = SCENERY[input.biome] ?? ['The party pauses at its current position.'];
    return rows[hash(`${input.seed}:${input.x}:${input.y}:scene`) % rows.length]
        + (input.onRoad ? ' A worn trail passes through this spot.' : '');
}
