import { useAppStore } from '../../../store/useAppStore';

/** Cheap fast-fail for multi-step background closures after a campaign switch. */
export function assertStillActive(activeCampaignId: string, label: string): boolean {
    const currentId = useAppStore.getState().activeCampaignId;
    if (currentId !== activeCampaignId) {
        console.warn(`[PostTurn] Aborting ${label} \u2014 campaign switched (${activeCampaignId} \u2192 ${currentId})`);
        return false;
    }
    return true;
}

/** Campaign-id guard factory for background-task callbacks. */
export function makeGuarded<T extends (...args: never[]) => void>(
    fn: T,
    activeCampaignId: string,
    label: string,
): T {
    return ((...args: Parameters<T>) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[PostTurn] Dropping ${label} — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        return fn(...args as never[]);
    }) as T;
}
