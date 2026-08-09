/** Service roles declared by the host. Keep this list frozen and shared. */
export const SERVICE_ROLE_IDS = Object.freeze([
    'memory.recall',
] as const);

/** Short alias for callers that use the generic role vocabulary. */
export const ROLE_IDS = SERVICE_ROLE_IDS;

export type ServiceRoleId = typeof SERVICE_ROLE_IDS[number];
