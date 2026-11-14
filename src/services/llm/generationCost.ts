export type CostProvider = 'openrouter' | 'nanogpt';

export type GenerationCost = {
    amount: number;
    currency: string;
};

function validAmount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function readGenerationCost(provider: CostProvider, data: unknown): GenerationCost | undefined {
    const payload = data as {
        usage?: { cost?: unknown };
        x_nanogpt_pricing?: { cost?: unknown; amount?: unknown; currency?: unknown; paymentSource?: unknown; error?: unknown };
    } | null;
    if (provider === 'openrouter') {
        const amount = payload?.usage?.cost;
        return validAmount(amount) ? { amount, currency: 'USD' } : undefined;
    }

    const pricing = payload?.x_nanogpt_pricing;
    if (!pricing || pricing.error) return undefined;
    const amount = validAmount(pricing.cost) ? pricing.cost : pricing.amount;
    if (!validAmount(amount)) return undefined;
    const currency = pricing.currency ?? pricing.paymentSource ?? 'USD';
    if (typeof currency !== 'string' || !/^[a-z]{3,5}$/i.test(currency)) return undefined;
    return { amount, currency: currency.toUpperCase() };
}
