/**
 * The host-owned service-role contract. A role is a single answer-bearing seam
 * in core; the generic registry deliberately knows nothing about its meaning.
 */
export interface ServiceRole<In, Out> {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly deadlineMs: number;
    validate(answer: unknown): Out | undefined;
    readonly defaultProvider: RoleProvider<In, Out>;
}

export interface RoleProvider<In, Out> {
    readonly providerId: string;
    readonly source: 'builtin' | 'mod';
    readonly modId?: string;
    readonly loadIndex: number;
    ask(input: In, signal: AbortSignal): Promise<Out> | Out;
}

/** Fault kinds emitted by the claim and ask paths. */
export type RoleFaultKind =
    | 'unknown-role'
    | 'undeclared'
    | 'unprovided'
    | 'conflict'
    | 'duplicate'
    | 'revoked'
    | 'sandbox'
    | 'threw'
    | 'timeout'
    | 'invalid'
    | 'partial';

export interface ModRolesApi {
    provide(roleId: string, ask: (input: never, signal: AbortSignal) => unknown): () => void;
}

export interface ServiceRoleRegistry {
    register<In, Out>(role: ServiceRole<In, Out>): void;
    provide(roleId: string, provider: RoleProvider<never, never>): () => void;
    revoke(modId: string): void;
    activeProviderFor(roleId: string): RoleProvider<never, never> | undefined;
    list(): readonly ServiceRole<never, never>[];
    ask<In, Out>(roleId: string, input: In): Promise<Out | undefined>;
}
