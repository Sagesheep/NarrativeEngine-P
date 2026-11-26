/**
 * Per-campaign write serializer. Serializes all read-modify-write sequences
 * for a campaign's files so concurrent appends (and deferred LLM extraction
 * writes) don't clobber each other via lost updates.
 *
 * The lock is in-memory and per-process. Server restart drops it — acceptable
 * since each `writeJson` is atomic (tmp+rename), so a crash mid-write doesn't
 * corrupt files, it just means a deferred LLM write doesn't happen (same risk
 * profile as the existing fire-and-forget embedding pattern).
 *
 * Usage:
 *   await withCampaignLock(campaignId, () => {
 *       const data = readJson(path, []);
 *       data.push(newEntry);
 *       writeJson(path, data);
 *   });
 */

/** @type {Map<string, Promise<unknown>>} */
const locks = new Map();

/**
 * Run `fn` while holding the per-campaign lock. Serializes with any prior
 * `withCampaignLock` call for the same campaignId. The lock auto-cleans once
 * the chain settles so there's no memory leak.
 *
 * @param {string} campaignId
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 * @template T
 */
export function withCampaignLock(campaignId, fn) {
    const prev = locks.get(campaignId) || Promise.resolve();

    // The caller gets the real outcome and is responsible for handling it.
    const result = prev.then(() => fn());

    // The promise stored as the lock must NEVER reject. Two separate failures
    // follow if it does:
    //   1. Nothing handles the rejection of the tail promise created here, so
    //      Node raises unhandledRejection and terminates the process — even
    //      when the route itself caught the error correctly.
    //   2. A rejected lock short-circuits the `prev.then(() => fn())` above on
    //      the next call, so every operation queued behind one failed write is
    //      skipped instead of run. For appendScene that leaves prose on disk
    //      with no index entry.
    const tail = result.catch(err => {
        console.error(`[WriteLock] Error for campaign ${campaignId}:`, err);
    });
    locks.set(campaignId, tail);
    tail.then(() => {
        if (locks.get(campaignId) === tail) locks.delete(campaignId);
    });

    return result;
}