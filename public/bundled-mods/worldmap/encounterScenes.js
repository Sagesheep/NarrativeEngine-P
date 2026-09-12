import { worldProfile, PROFILE_EVENTS } from './worldProfiles.js';
// Engine-owned scene seeds. The normal GM turn elaborates these saved facts.
const SCENERY = {
    snow: ['Wind combs ridges into deep snow.', 'Snow fills the spaces between exposed rocks.'],
    volcanic: ['Dark fractured rock rises through beds of ash.', 'Ash gathers in hollows between volcanic rocks.'],
    deadzone: ['Bare eroded ground supports almost no vegetation.', 'Dry cracks divide a barren expanse. The cause is not established.'],
    sand: ['Wind-shaped dunes shelter pockets of loose sand.', 'Fine sand slips down the lee of a dune.'],
    swamp: ['Tangled roots overhang dark pools.', 'Waterlogged woodland leaves few patches of firm footing.'],
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
    { id: 'snow-drift', biomes: ['snow'], weight: 3, title: 'A covered trail marker', text: 'A trail marker barely protrudes from a snowdrift. Its markings are partly obscured.', action: 'I inspect the marker from secure footing.' },
    { id: 'volcanic-vent', biomes: ['volcanic'], weight: 3, title: 'A steaming fissure', text: 'Vapour rises intermittently from a crack among the rocks. Loose ash outlines the opening.', action: 'I observe the fissure from a distance and look for a route around it.' },
    { id: 'deadzone-marker', biomes: ['deadzone'], weight: 3, title: 'An eroded marker', text: 'A weathered marker stands alone in barren ground. Its remaining markings may explain who passed here.', action: 'I examine the remaining markings.' },
    { id: 'sand-object', biomes: ['sand'], weight: 3, title: 'An object under the dune', text: 'Wind has exposed a corner of a buried object. Its nature is not yet clear.', action: 'I examine the exposed corner before disturbing the sand.' },
    { id: 'swamp-log', biomes: ['swamp'], weight: 3, title: 'A drifting obstruction', text: 'A partly submerged log shifts across a narrow channel between the roots.', action: 'I watch the current and look for firm ground.' },
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
    const profile = worldProfile(input.worldProfile).id;
    const traditional = ['fantasy', 'historical'].includes(profile);
    const base = profile === 'scifi' ? LOCAL_EVENTS.filter(row => ['snow-drift', 'volcanic-vent', 'deadzone-marker', 'sand-object', 'swamp-log'].includes(row.id)) : LOCAL_EVENTS.filter(row => traditional || (!row.road && !row.role));
    const rows = [...base, ...PROFILE_EVENTS.filter(row => row.profiles.includes(profile))];
    return rows.filter(row => row.road ? input.onRoad && input.biome !== 'ocean' && input.biome !== 'glacier' : row.biomes.includes(input.biome));
}
function instantiate(row, input, source) {
    const identity = `${input.seed}:${input.worldDay}:${input.x}:${input.y}:${row.id}`;
    const names = ['fantasy', 'historical'].includes(worldProfile(input.worldProfile).id) ? PEOPLE : ['Alex', 'Sam', 'Morgan', 'Jordan', 'Ari', 'Robin', 'Kai', 'Ren'];
    const name = row.role ? `${names[hash(identity) % names.length]} ${SURNAMES[hash(identity + ':surname') % SURNAMES.length]}` : null;
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
    const profile = worldProfile(input.worldProfile).id;
    const modern = !['fantasy', 'historical'].includes(profile);
    const alternatives = {
        settlement: ['Someone checking supplies', profile === 'cyberpunk' ? 'local technician' : 'resident', 'check which supplies are needed locally', '{name} checks a supply list near the settlement’s activity.'],
        ruin: ['A survey of the remains', 'site surveyor', 'document the remains without disturbing them', '{name} records the condition of the visible remains.'],
        shrine: ['A caretaker at the shrine', 'caretaker', 'maintain the site and hear news from visitors', '{name} tidies the area around the shrine.'],
        camp: ['A traveller checking equipment', 'traveller', 'check equipment before the next leg', '{name} tests a piece of travelling equipment beside a packed bag.'],
        crossing: ['A crossing inspection', 'route inspector', 'check whether the crossing is usable', '{name} notes the condition of the crossing from the near side.'],
        landmark: ['A survey in progress', 'field surveyor', 'compare the landmark with a recorded survey', '{name} takes observations beside the landmark.'],
    };
    const row = (modern ? alternatives : SITE_PEOPLE)[input.feature.type];
    if (!row) return null;
    return instantiate({ id: `feature-${input.feature.type}`, title: row[0], role: row[1], motive: row[2], text: row[3] }, input, 'feature');
}
export function localScene(input) {
    const rows = SCENERY[input.biome] ?? ['The party pauses at its current position.'];
    return rows[hash(`${input.seed}:${input.x}:${input.y}:scene`) % rows.length]
        + (input.onRoad ? ' A worn trail passes through this spot.' : '');
}
