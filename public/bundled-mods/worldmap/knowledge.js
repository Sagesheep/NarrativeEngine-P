export function hasKnownPosition(place) {
    return place?.knowledge !== 'rumoured' && place?.knowledge !== 'secret';
}
export function rumourArea(place) {
    if (place.knowledge !== 'rumoured' || !place.coordinates) return null;
    const x = Math.min(984, Math.floor(place.coordinates.x / 32) * 32 + 16);
    const y = Math.min(984, Math.floor(place.coordinates.y / 32) * 32 + 16);
    return { locationId: place.id, name: place.name, x, y, radius: 24, note: place.knowledgeNote ?? '' };
}
export function markCurrentVisited(ledger, currentId, observedCell) {
    let changed = false;
    const next = ledger.map(place => {
        let knowledge = place.knowledge;
        if (place.id === currentId && knowledge) knowledge = 'visited';
        else if (knowledge === 'rumoured' && observedCell && place.coordinates?.x === observedCell.x && place.coordinates?.y === observedCell.y) knowledge = 'known';
        if (knowledge === place.knowledge) return place;
        changed = true;
        return { ...place, knowledge };
    });
    return changed ? next : ledger;
}
