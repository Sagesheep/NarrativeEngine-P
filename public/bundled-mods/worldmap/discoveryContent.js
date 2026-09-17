// Content variants keep the existing placement families and their spacing rules.
// Descriptions establish physical details, not mandatory events or rewards.
const grounded = {
    settlement: [
        ['Market', 'Covered stalls surround a public noticeboard; storage sheds face the trading square.'],
        ['Workshop', 'Small workshops share a yard lined with repaired tools and stacked materials.'],
        ['Waystation', 'A sheltered unloading yard and communal rooms serve people passing through.']],
    ruin: [
        ['Watchtower', 'A broken stair climbs an empty lookout. Weathered marks remain on the entrance wall.'],
        ['Quarry', 'Cut stone lies beside an abandoned working face; shallow tracks lead between the spoil heaps.'],
        ['Storehouse', 'Collapsed shelving fills an old storage building. Faded inventory marks survive beneath the eaves.'],
        ['Courtyard', 'Low walls outline a deserted courtyard with a blocked doorway at the far end.']],
    shrine: [
        ['Memorial', 'Names have been cut into a sheltered stone face. A ledge below holds small personal tokens.'],
        ['Wayside Bell', 'A weathered bell hangs beneath a narrow roof. Its rope has been replaced more recently than the frame.'],
        ['Pilgrim Rest', 'Stone benches face a carved niche; generations of travellers have left different marks on its rim.'],
        ['Standing Stones', 'Upright stones surround a level patch of earth. Their worn carvings are difficult to read from a distance.']],
    camp: [
        ['Windbreak', 'A low wall shelters a level sleeping area. Old hearth stones sit clear of the bedding space.'],
        ['Travellers Rest', 'Several flattened pitches surround a shared fire ring. Peg holes and wheel marks overlap in the dirt.'],
        ['Supply Shelter', 'A simple roof covers raised storage racks. A board asks visitors to leave the space clean.'],
        ['Lookout Camp', 'A sheltered pitch overlooks the approach. A small stack of stones marks the safest footing.']],
    crossing: [
        ['Raised Walk', 'A raised walkway crosses soft ground. Replacement sections differ in colour from the older surface.'],
        ['Causeway', 'A narrow built-up crossing carries foot traffic above the wet ground. Markers indicate the edges.'],
        ['Stepping Stones', 'Broad stones cross a shallow wet channel. Several have tilted and need careful footing.']],
    landmark: [
        ['Split Boulder', 'A deep cleft divides a large exposed boulder. Small stones collect in its sheltered base.'],
        ['Survey Cairn', 'A carefully stacked cairn stands on open ground. Direction marks are scratched into the top stone.'],
        ['Stone Arch', 'An exposed arch of rock frames the ground beyond. Fallen fragments lie beneath its narrower side.'],
        ['Echo Hollow', 'A shallow rocky hollow carries sounds unusually clearly. Several narrow ledges offer a place to sit.']]
};
const technical = {
    settlement: [['Service Hub', 'Repair bays and supply counters face a shared loading area. A directory lists the local services.'], ['Survey Outpost', 'Work cabins surround an instrument yard. Labelled sample lockers line a covered passage.']],
    shrine: [['Memorial Station', 'An engraved dedication panel stands beside a sheltered seating area. Some entries have been added by hand.'], ['Relay Mast', 'A fenced communications mast rises above equipment cabinets. External labels identify maintenance access.'], ['Survey Beacon', 'A fixed positioning beacon stands on a marked foundation. Its service panel carries inspection dates.']],
    ruin: [['Relay Ruins', 'A collapsed antenna lies beside an empty equipment building. Cable channels remain visible in the floor.'], ['Abandoned Depot', 'Disused loading bays surround a stripped storage yard. Faded bay numbers remain legible.']],
    camp: [['Field Shelter', 'Modular sleeping shelters stand beside a sheltered work surface. Anchor points mark older pitches.'], ['Maintenance Stop', 'A covered rest area stands beside sealed service cabinets. A posted diagram shows the site layout.']]
};
const terrainVariants = {
    landmark: {
        forest: ['Hollow Grove', 'Old hollow trunks surround a small clearing. Fallen branches form natural seats around its edge.'],
        jungle: ['Root Vault', 'Intertwined roots form a low sheltered chamber beneath a broad tree. Moist earth records recent tracks.'],
        swamp: ['Sunken Grove', 'Dark trunks rise from still pools. A raised root shelf offers a dry place to inspect the water.'],
        sand: ['Wind-carved Spire', 'A narrow rock spire rises between dunes. Wind has polished one face smooth.'],
        desert: ['Dry Basin', 'A pale mineral rim outlines an empty basin. Cracks deepen toward its centre.'],
        snow: ['Icefall Overlook', 'A rocky ledge overlooks layered ice. Wind-packed snow collects behind the sheltering ridge.'],
        volcanic: ['Ash Vent', 'A dark fissure cuts through old ash beds. Mineral stains trace its edges; its activity is not yet known.'],
        deadzone: ['Eroded Pillars', 'Isolated pillars rise from barren ground. Loose fragments form fans around their bases.']
    }
};
function hash(value) { let n = 2166136261; for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0; }
export function discoveryContent(seed, site, profile = 'fantasy') {
    const advanced = ['modern', 'cyberpunk', 'scifi'].includes(profile);
    let pool = advanced && technical[site.type] || grounded[site.type];
    if (!pool) return {};
    const regional = terrainVariants[site.type]?.[site.biome];
    if (regional) pool = [...pool, regional, regional];
    if (profile === 'postapoc' && site.type === 'shrine') pool = [grounded.shrine[0], ['Supply Marker', 'Painted symbols identify a sheltered rendezvous point. Older directions have been crossed out and replaced.']];
    const key = `${seed}:${site.x}:${site.y}:${profile}`;
    const [variant, detail] = pool[hash(key + ':variant') % pool.length];
    const prefix = ['Amber', 'Grey', 'Quiet', 'Long', 'Broken', 'Three', 'Old', 'Hollow', 'Red', 'Still', 'Far', 'Hidden'][hash(key + ':name') % 12];
    const category = site.type === 'settlement' ? ` ${site.settlementKind || 'village'}` : '';
    return { name: `${prefix} ${variant}${category}`, description: detail, contentVariant: variant, contentProfile: profile };
}
