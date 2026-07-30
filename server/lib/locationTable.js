export const locationTableDescriptor = {
    name: 'locations',
    fileSuffix: '.locations.json',
    recordShape: 'array',
    serverRoutes: { present: true, value: { get: true, put: true } },
    transfer: { present: true, value: { bundleKey: 'locations' } },
};

export function registerLocationTable(registry) {
    if (!registry.get(locationTableDescriptor.name)) {
        registry.register(locationTableDescriptor);
    }
}
