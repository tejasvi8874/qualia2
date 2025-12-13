export async function withRetry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (i < retries - 1) {
                console.log(`Attempt ${i + 1} failed. Retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

export class RateLimiter {
    private lastRequestTime: number = 0;
    private minInterval: number; // in milliseconds

    private name: string;

    constructor(rpm: number, name: string = "RateLimiter") {
        this.minInterval = 10 * 1000 / rpm;
        this.name = name;
    }

    async acquire(): Promise<void> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minInterval) {
            const timeToWait = this.minInterval - timeSinceLastRequest;
            console.log(`[${this.name}] Rate limit hit. Waiting ${timeToWait}ms...`);
            await new Promise(resolve => setTimeout(resolve, timeToWait));
        }

        this.lastRequestTime = Date.now();
    }
}

export class BatchProcessor<T> {
    private queue: T[] = [];
    private isProcessing = false;
    private rateLimiter: RateLimiter;
    private processFn: (items: T[]) => Promise<void>;
    private name: string;

    constructor(rateLimiter: RateLimiter, processFn: (items: T[]) => Promise<void>, name: string = "BatchProcessor") {
        this.rateLimiter = rateLimiter;
        this.processFn = processFn;
        this.name = name;
    }

    add(item: T) {
        this.queue.push(item);
        this.process();
    }

    private async process() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            console.log(`[${this.name}] Waiting for rate limiter... Queue size: ${this.queue.length}`);
            await this.rateLimiter.acquire();

            // Take all items currently in the queue
            const batch = [...this.queue];
            this.queue = [];

            console.log(`[${this.name}] Processing batch of ${batch.length} items`);
            try {
                await this.processFn(batch);
            } catch (e) {
                console.error(`[${this.name}] Error processing batch:`, e);
            }
        }

        this.isProcessing = false;
    }
}

