import { formatRoleFaultReason, roleFaultStore } from './roleFaults';
import { LIFECYCLE_FAULT_STRIKES } from '../mods/lifecycle/lifecycleFaults';
import type { RoleProvider, ServiceRole, ServiceRoleRegistry, RoleFaultKind } from './roleTypes';

export interface RoleRegistryOptions {
    /** The caller supplies the live settings map; the registry stays storage-agnostic. */
    readonly isEnabled?: (providerId: string) => boolean;
}

interface RegisteredProvider {
    readonly provider: RoleProvider<never, never>;
    readonly modId: string;
}

class RoleTimeoutError extends Error {}
class RoleInvalidAnswerError extends Error {}

function providerKey(provider: RoleProvider<never, never>): string {
    return provider.modId ?? provider.providerId;
}

function isProvider(value: unknown): value is RoleProvider<never, never> {
    const candidate = value as Partial<RoleProvider<never, never>> | null;
    if (!candidate) return false;
    return typeof candidate.providerId === 'string'
        && typeof candidate.source === 'string'
        && typeof candidate.ask === 'function';
}

/**
 * Generic name-blind role store. Per-role behaviour belongs on the descriptor;
 * this file arbitrates providers, contains asks and owns leases only.
 */
export function createServiceRoleRegistry(options: RoleRegistryOptions = {}): ServiceRoleRegistry & {
    enable(modId: string): void;
    clear(): void;
} {
    const roles = new Map<string, ServiceRole<never, never>>();
    const providers = new Map<string, Map<string, RegisteredProvider>>();
    const revoked = new Set<string>();
    const strikes = new Map<string, number>();
    const latched = new Set<string>();
    const surfacedConflicts = new Set<string>();
    const isEnabled = options.isEnabled ?? (() => true);

    const addFault = (input: {
        readonly modId: string;
        readonly modName?: string;
        readonly roleId?: string;
        readonly kind: RoleFaultKind;
        readonly message?: string;
        readonly winner?: string;
        readonly loser?: string;
        readonly strikes?: number;
        readonly latched?: boolean;
    }): void => {
        const modName = input.modName ?? input.modId;
        roleFaultStore.add({
            modId: input.modId,
            file: `mod:${input.modId}`,
            kind: input.kind,
            roleId: input.roleId,
            winner: input.winner,
            loser: input.loser,
            strikes: input.strikes,
            latched: input.latched,
            reason: formatRoleFaultReason({
                modName,
                kind: input.kind,
                roleId: input.roleId,
                message: input.message,
                knownRoles: [...roles.keys()],
                winner: input.winner,
                loser: input.loser,
                strikes: input.strikes,
                latched: input.latched,
            }),
        });
    };

    const eligibleFor = (roleId: string): RegisteredProvider[] => {
        const role = roles.get(roleId);
        if (!role) return [];
        const registered = providers.get(roleId) ?? new Map<string, RegisteredProvider>();
        const defaultProvider = role.defaultProvider as unknown as RoleProvider<never, never>;
        const all: RegisteredProvider[] = [
            { provider: defaultProvider, modId: defaultProvider.providerId },
            ...registered.values(),
        ];
        const seen = new Set<string>();
        return all
            .filter((entry) => {
                if (seen.has(entry.provider.providerId)) return false;
                seen.add(entry.provider.providerId);
                if (entry.provider.source === 'mod' && entry.provider.modId && revoked.has(entry.provider.modId)) return false;
                if (entry.provider.source === 'mod' && latched.has(entry.provider.providerId)) return false;
                try {
                    return isEnabled(entry.provider.providerId);
                } catch {
                    return false;
                }
            })
            .sort((a, b) => {
                const load = (Number.isFinite(a.provider.loadIndex) ? a.provider.loadIndex : Number.POSITIVE_INFINITY)
                    - (Number.isFinite(b.provider.loadIndex) ? b.provider.loadIndex : Number.POSITIVE_INFINITY);
                if (load !== 0) return load;
                return providerKey(a.provider).localeCompare(providerKey(b.provider));
            });
    };

    const activeEntryFor = (roleId: string): RegisteredProvider | undefined => {
        const entries = eligibleFor(roleId);
        const winner = entries[0];
        if (!winner) return undefined;
        for (const loser of entries.slice(1)) {
            if (loser.provider.source !== 'mod' || !loser.provider.modId) continue;
            const winnerName = winner.provider.modId ?? winner.provider.providerId;
            const conflictKey = `${roleId}:${winnerName}:${loser.provider.modId}`;
            if (surfacedConflicts.has(conflictKey)) continue;
            surfacedConflicts.add(conflictKey);
            addFault({
                modId: loser.provider.modId,
                roleId,
                kind: 'conflict',
                winner: winnerName,
                loser: loser.provider.modId,
            });
        }
        return winner;
    };

    const recordAskFault = (provider: RoleProvider<never, never>, roleId: string, kind: RoleFaultKind, message: string): void => {
        const key = provider.providerId;
        const nextStrikes = (strikes.get(key) ?? 0) + 1;
        strikes.set(key, nextStrikes);
        const isLatched = provider.source === 'mod' && nextStrikes >= LIFECYCLE_FAULT_STRIKES;
        if (isLatched) latched.add(key);
        addFault({
            modId: provider.modId ?? provider.providerId,
            roleId,
            kind,
            message,
            strikes: nextStrikes,
            latched: isLatched,
        });
    };

    const ask = async <In, Out>(roleId: string, input: In): Promise<Out | undefined> => {
        const role = roles.get(roleId);
        if (!role) {
            addFault({ modId: 'role-registry', roleId, kind: 'unknown-role' });
            return undefined;
        }
        const entry = activeEntryFor(roleId);
        if (!entry) return undefined;
        const provider = entry.provider;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            if (provider.source === 'mod' && provider.modId && revoked.has(provider.modId)) return undefined;
            let answerPromise: Promise<unknown>;
            try {
                // Invoke synchronously so a default provider can capture the
                // host context for this ask before another turn starts.
                answerPromise = Promise.resolve(provider.ask(input as never, controller.signal));
            } catch (error) {
                answerPromise = Promise.reject(error);
            }
            const timeoutPromise = provider.source === 'builtin'
                ? undefined
                : new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(new RoleTimeoutError(`deadline exceeded (${role.deadlineMs} ms)`));
                    }, role.deadlineMs);
                });
            const answer = provider.source === 'builtin'
                ? await answerPromise
                : await Promise.race([answerPromise, timeoutPromise!]);
            const validated = role.validate(answer);
            if (validated === undefined) throw new RoleInvalidAnswerError('shape rejected');
            strikes.delete(provider.providerId);
            return validated as Out;
        } catch (error) {
            const kind: RoleFaultKind = error instanceof RoleTimeoutError
                ? 'timeout'
                : error instanceof RoleInvalidAnswerError
                    ? 'invalid'
                    : 'threw';
            recordAskFault(provider, roleId, kind, error instanceof Error ? error.message : String(error));
            return undefined;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    };

    return {
        register(role) {
            if (!role || typeof role.id !== 'string' || roles.has(role.id)) return;
            roles.set(role.id, role as unknown as ServiceRole<never, never>);
            providers.set(role.id, new Map());
        },
        provide(roleId, provider) {
            const modId = isProvider(provider) ? (provider.modId ?? provider.providerId) : 'unknown-provider';
            if (!roles.has(roleId)) {
                addFault({ modId, roleId, kind: 'unknown-role' });
                return () => {};
            }
            if (!isProvider(provider)) {
                addFault({ modId, roleId, kind: 'invalid', message: 'provider must expose ask()' });
                return () => {};
            }
            if (provider.source === 'mod' && provider.modId && revoked.has(provider.modId)) {
                addFault({ modId: provider.modId, roleId, kind: 'revoked' });
                return () => {};
            }
            const roleProviders = providers.get(roleId)!;
            const prior = [...roleProviders.values()].find((entry) => entry.provider.modId === provider.modId);
            if (prior) {
                addFault({ modId, roleId, kind: 'duplicate', message: `${prior.provider.providerId} and ${provider.providerId}` });
            }
            roleProviders.set(provider.providerId, { provider, modId });
            return () => {
                const current = roleProviders.get(provider.providerId);
                if (current?.provider === provider) roleProviders.delete(provider.providerId);
            };
        },
        revoke(modId) {
            revoked.add(modId);
            strikes.delete(`mod.${modId}`);
            latched.delete(`mod.${modId}`);
            for (const roleProviders of providers.values()) {
                for (const [id, entry] of roleProviders) {
                    if (entry.provider.modId === modId) roleProviders.delete(id);
                }
            }
        },
        activeProviderFor(roleId) {
            return activeEntryFor(roleId)?.provider;
        },
        list() {
            return [...roles.values()];
        },
        ask,
        enable(modId) {
            revoked.delete(modId);
            strikes.delete(`mod.${modId}`);
            latched.delete(`mod.${modId}`);
            for (const roleProviders of providers.values()) {
                for (const [id, entry] of roleProviders) {
                    if (entry.provider.modId === modId) roleProviders.delete(id);
                }
            }
            for (const key of surfacedConflicts) {
                if (key.includes(`:${modId}`)) surfacedConflicts.delete(key);
            }
            roleFaultStore.clearMod(modId);
        },
        clear() {
            for (const roleProviders of providers.values()) roleProviders.clear();
            revoked.clear();
            strikes.clear();
            latched.clear();
            surfacedConflicts.clear();
            roleFaultStore.clear();
        },
    };
}
