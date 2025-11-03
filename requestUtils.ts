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

    constructor(rpm: number) {
        this.minInterval = 10 * 1000 / rpm;
    }

    async acquire(): Promise<void> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;

        if (timeSinceLastRequest < this.minInterval) {
            const timeToWait = this.minInterval - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, timeToWait));
        }

        this.lastRequestTime = Date.now();
    }
}

