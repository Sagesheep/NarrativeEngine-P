// e:/Games/AI DM Project/Automated_system/App/src/services/worldEngine.ts

const whoTable = [
    "a major faction/organization",
    "a rogue splinter group",
    "a powerful leader/executive",
    "a dangerous anomaly",
    "a fanatic cult/extremist group",
    "a prominent conglomerate/merchant guild",
    "a desperate individual",
    "a completely random nobody",
    "an ancient/forgotten entity",
    "a chaotic force of nature"
];

const whereTable = [
    "in a neighboring city/sector",
    "across the nearest border",
    "deep underground/in the lower levels",
    "in a remote outpost/village",
    "in the capital/central hub",
    "in a forgotten ruin/abandoned zone",
    "along a main trade/travel route",
    "in an uncharted area",
    "in a highly secure/restricted area",
    "in the wilderness/wasteland"
];

const whyTable = [
    "to seize power/control",
    "for brutal vengeance",
    "to protect a dangerous secret",
    "driven by a radical ideology/prophecy",
    "for untold wealth/resources",
    "due to an escalating misunderstanding",
    "out of pure desperation",
    "because someone dumb got lucky and found a legendary asset",
    "acting on an old grudge",
    "to reclaim lost glory/territory"
];

const whatTable = [
    "declared open hostilities/war",
    "formed an unexpected alliance",
    "destroyed an important landmark/facility",
    "discovered a game-changing asset/relic",
    "assassinated/eliminated a key figure",
    "triggered a massive disaster",
    "monopolized a critical resource",
    "initiated a complete blockade/lockdown",
    "caused a mass exodus/evacuation",
    "staged a violent coup/takeover"
];

function getRandomItem(arr: string[]): string {
    return arr[Math.floor(Math.random() * arr.length)];
}

export function generateWorldEventTag(): string {
    const who = getRandomItem(whoTable);
    const where = getRandomItem(whereTable);
    const why = getRandomItem(whyTable);
    const what = getRandomItem(whatTable);
    return `[WORLD_EVENT: ${who} ${where} ${why} ${what}]`;
}

export function checkWorldEvent(currentDC: number, initialDC: number = 198, dcReduction: number = 3): { hit: boolean, newDC: number, roll: number } {
    const roll = Math.floor(Math.random() * 200) + 1; // 1 to 200
    if (roll >= currentDC) {
        return { hit: true, newDC: initialDC, roll };
    }
    // Decrease DC for next time (minimum 0)
    return { hit: false, newDC: Math.max(0, currentDC - dcReduction), roll };
}
