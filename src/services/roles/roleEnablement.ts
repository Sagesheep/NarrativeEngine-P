import type { AppSettings } from '../../types';

let moduleEnabled: Pick<AppSettings, 'moduleEnabled'>['moduleEnabled'];

export function setRoleModuleEnabled(value: Pick<AppSettings, 'moduleEnabled'>['moduleEnabled']): void {
    moduleEnabled = value ? { ...value } : undefined;
}

export function getRoleModuleEnabled(): Pick<AppSettings, 'moduleEnabled'>['moduleEnabled'] {
    return moduleEnabled;
}

