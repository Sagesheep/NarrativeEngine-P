export const combatTableDescriptor = {
    name: 'combat',
    fileSuffix: '.combat.json',
    recordShape: 'single-object',
    serverRoutes: { present: true, value: { get: true, put: true } },
    transfer: { present: true, value: { bundleKey: 'combat' } },
};

export function registerCombatTable(registry) {
    if (!registry.get(combatTableDescriptor.name)) {
        registry.register(combatTableDescriptor);
    }
}
