import { JsonRpcHTTPTransport, type JsonRpcTransport } from '@mysten/sui/jsonRpc';

/** HTTP statuses that signal a transient upstream problem worth retrying. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4000;

/** Tunable retry timing. Defaults suit fast RPC polls; callers facing slower
 * eventual-consistency windows (e.g. waiting for an on-chain index to catch up)
 * pass a longer profile. */
export interface RetryOptions {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** Called before each backoff sleep — handy for visibility into retry storms. */
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff capped at maxDelayMs, with jitter to avoid a thundering herd. */
function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
    const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
    return exp + Math.random() * exp * 0.25;
}

/**
 * A `fetch` drop-in that transparently retries transient upstream failures — HTTP
 * 429/502/503/504 and network-level errors (`fetch failed`, resets, timeouts) — with
 * exponential backoff + jitter. Non-retryable responses and the final attempt are returned
 * or thrown unchanged, so genuine errors still surface to the caller.
 */
export function makeRetryingFetch(maxAttempts: number = DEFAULT_MAX_ATTEMPTS): typeof fetch {
    return async function retryingFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const res = await fetch(input, init);
                if (!RETRYABLE_STATUS.has(res.status) || attempt === maxAttempts) return res;
                // Drain the body so the underlying connection can be reused on retry.
                await res.arrayBuffer().catch(() => undefined);
            } catch (error) {
                lastError = error;
                if (attempt === maxAttempts) throw error;
            }
            await sleep(backoffDelay(attempt, BASE_DELAY_MS, MAX_DELAY_MS));
        }
        throw lastError;
    } as typeof fetch;
}

/** Build a JSON-RPC transport whose fetch retries transient upstream failures. */
export function retryingRpcTransport(url: string, maxAttempts?: number): JsonRpcTransport {
    return new JsonRpcHTTPTransport({ url, fetch: makeRetryingFetch(maxAttempts) });
}

/** Resolve the Sui RPC URL, honoring the shared `DATA_BASE_URL` override. */
export function resolveRpcUrl(fallback: string): string {
    return process.env.DATA_BASE_URL ?? fallback;
}

/** Whether an error looks transient (worth retrying): a retryable HTTP status carried on the
 * error, or a recognisable transport/upstream message (incl. `validator responded 5xx`). */
export function isTransient(error: unknown): boolean {
    const status = (error as { status?: number } | null)?.status;
    if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
    const message = error instanceof Error ? error.message : String(error);
    return /(Unexpected status code|validator responded):? (429|502|503|504)|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated|network error/i.test(
        message,
    );
}

/**
 * Retry an arbitrary async operation on transient errors. Used where we don't construct the
 * RPC client ourselves (e.g. the scheduler's shared walrus-json pointer read, or intake's
 * validator call which can 502 while an on-chain index catches up). Accepts either a plain
 * attempt count or a full timing profile.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: number | RetryOptions = DEFAULT_MAX_ATTEMPTS,
): Promise<T> {
    const {
        maxAttempts = DEFAULT_MAX_ATTEMPTS,
        baseDelayMs = BASE_DELAY_MS,
        maxDelayMs = MAX_DELAY_MS,
        onRetry,
    } = typeof opts === 'number' ? { maxAttempts: opts } : opts;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt === maxAttempts || !isTransient(error)) throw error;
            const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
            onRetry?.(attempt, error, delay);
            await sleep(delay);
        }
    }
    throw lastError;
}
