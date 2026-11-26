type QueueTask<T = unknown> = {
    label: string;
    execute: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
};

class BackgroundQueue {
    private queue: QueueTask[] = [];
    private running = 0;
    private maxConcurrent: number;

    constructor(maxConcurrent = 2) {
        this.maxConcurrent = maxConcurrent;
    }

    setMaxConcurrent(n: number) {
        this.maxConcurrent = Math.max(1, n);
        this.drain();
    }

    push<T>(label: string, execute: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ label, execute, resolve, reject } as QueueTask);
            console.log(`[BG Queue] Enqueued "${label}" (${this.queue.length} pending, ${this.running} running, max ${this.maxConcurrent})`);
            this.drain();
        });
    }

    private drain() {
        while (this.running < this.maxConcurrent && this.queue.length > 0) {
            const task = this.queue.shift()!;
            this.running++;
            console.log(`[BG Queue] Starting "${task.label}" (${this.running}/${this.maxConcurrent} running, ${this.queue.length} pending)`);

            task.execute()
                .then((result) => {
                    task.resolve(result);
                })
                .catch((err) => {
                    console.warn(`[BG Queue] "${task.label}" failed:`, err);
                    task.reject(err);
                })
                .finally(() => {
                    this.running--;
                    this.drain();
                });
        }
    }

    clear(reason = 'Campaign switched') {
        const dropped = this.queue.splice(0, this.queue.length);
        if (dropped.length > 0) {
            console.log(`[BG Queue] Cleared ${dropped.length} pending task(s): ${reason}`);
            for (const task of dropped) {
                task.reject(new Error(`[BG Queue] Task "${task.label}" cancelled: ${reason}`));
            }
        }
    }

    get pending() { return this.queue.length; }
    get active() { return this.running; }
}

export const backgroundQueue = new BackgroundQueue(2);
