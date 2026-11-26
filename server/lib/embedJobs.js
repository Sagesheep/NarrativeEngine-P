// Live, in-memory tracker for in-flight embedding jobs (lore/archive/rules bulk
// embeds). Purely ephemeral — it answers two questions the persisted vector store
// can't: "is a bulk embed running right now?" (so the hot turn-1 retrieval path can
// skip semantic and fall back to lexical instead of contending) and "how far along
// is it?" (so the UI can show an indexing snackbar). Cleared on process restart.

/** key `${campaignId}:${kind}` -> { campaignId, kind, done, total, startedAt } */
const jobs = new Map();

const keyOf = (campaignId, kind) => `${campaignId}:${kind}`;

/** Begin (or reset) a job. kind: 'lore' | 'archive' | 'rules'. */
export function startJob(campaignId, kind, total) {
    jobs.set(keyOf(campaignId, kind), {
        campaignId,
        kind,
        done: 0,
        total: Math.max(0, total | 0),
        startedAt: Date.now(),
    });
}

/** Advance progress by n items. No-op if the job isn't tracked. */
export function tickJob(campaignId, kind, n = 1) {
    const job = jobs.get(keyOf(campaignId, kind));
    if (job) job.done = Math.min(job.total, job.done + n);
}

/** Mark a job finished (success or failure) and drop it from the tracker. */
export function endJob(campaignId, kind) {
    jobs.delete(keyOf(campaignId, kind));
}

/** Is a bulk embed of this kind currently running for this campaign? */
export function isJobRunning(campaignId, kind) {
    return jobs.has(keyOf(campaignId, kind));
}

/** Snapshot of active jobs, optionally filtered to one campaign. */
export function getActiveJobs(campaignId) {
    const out = [];
    for (const job of jobs.values()) {
        if (!campaignId || job.campaignId === campaignId) out.push({ ...job });
    }
    return out;
}
