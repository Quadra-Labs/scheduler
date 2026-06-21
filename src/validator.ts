import type { Signer } from '@mysten/sui/cryptography';
import type { DataLayer } from 'quadra-data';

import type { EvalEngineLookup } from 'quadra-data';

import { buildPayload, callEvalValidate, callEvalStartData } from './evaluation.js';

export interface ValidatorOptions {
    /** Dedicated Seal-reader key (the `set_scheduler` address), not the data
     * layer's master write key. */
    schedulerKey: Signer;
    /** evaluator_id -> evaluation engine (shared with the scheduler engine). */
    evalEngines: EvalEngineLookup;
}

export interface ValidatorStatus {
    validated: number;
    rejected: number;
}

/** The validator's answer for one delivery. */
export interface Verdict {
    valid: boolean;
    reason?: string;
    /** Start data captured at delivery (e.g. `{ start_price }`); present when valid. */
    start_data?: Record<string, unknown>;
}

/**
 * Validator engine — the scheduler's second job, distinct from scheduling. The
 * intake engine asks it whether an agent's delivered result is valid; it
 * decrypts the sealed result with the scheduler's Seal key, sends it to the
 * job's evaluation engine for input validation (`POST /validate` — no scoring),
 * and answers `{ valid }`. Intake releases payment on `true` and never sees the
 * result itself. Reads + HTTP only, so the scheduler's gRPC stream stays healthy.
 *
 * The scheduler key must be the address registered via `job_access::set_scheduler`
 * (so Seal approves its decryption).
 */
export class ValidatorEngine {
    #dl: DataLayer;
    #opts: ValidatorOptions;
    #counts = { validated: 0, rejected: 0 };

    constructor(dl: DataLayer, opts: ValidatorOptions) {
        this.#dl = dl;
        this.#opts = opts;
    }

    status(): ValidatorStatus {
        return { ...this.#counts };
    }

    /**
     * Validate one delivered job and, when valid, fetch the start data (price at
     * delivery) from the same eval engine for intake to record. Rejections
     * (`valid: false`) are final agent faults; transient problems (no result
     * indexed yet, decrypt/key-server or eval-engine outage) throw so the caller
     * can retry.
     */
    async validate(jobId: string, asset: string): Promise<Verdict> {
        console.log(`[validator] validate ${jobId} (asset=${asset || '(none)'})`);
        // Transient failures here (rethrown so intake retries): result not registered yet, Seal
        // key-server outage, or a Seal no_access/decrypt failure. This is the silent gap that looks
        // like "paid but refunded non-delivered" — log it so the real cause is visible.
        const result = await this.#dl.jobResults
            .decrypt(jobId, this.#opts.schedulerKey)
            .catch((error: unknown) => {
                console.error(
                    `[validator] ${jobId} decrypt failed (will be retried):`,
                    error instanceof Error ? error.message : error,
                );
                throw error;
            });
        console.log(`[validator] ${jobId} decrypted; evaluator=${result.job.template.evaluator_id}`);

        const evaluatorId = result.job.template.evaluator_id;
        const engine = this.#opts.evalEngines.get(evaluatorId);
        if (!engine) {
            this.#counts.rejected++;
            return { valid: false, reason: `no eval engine for '${evaluatorId}'` };
        }

        const verdict = await callEvalValidate(engine.url, buildPayload(jobId, result, asset));
        if (!verdict.valid) {
            this.#counts.rejected++;
            console.warn(`[validator] ${jobId} rejected: ${verdict.reason}`);
            return verdict;
        }

        // Snapshot the start price at delivery (the job's started_at moment) for FINANCE jobs only.
        // Prediction jobs (polymarket-*) resolve from fixed params (market_id / target_ts /
        // event_id), not a start price — the polymarket evaluator has no /start_data endpoint, so
        // calling it 404s and would wrongly fail delivery. A prediction job's start_data is {}.
        const isPrediction = result.job.template.category === 'prediction';
        const start_data = isPrediction
            ? {}
            : await callEvalStartData(engine.url, asset, result.started_at);
        this.#counts.validated++;
        console.log(`[validator] ${jobId} valid; start_data ${JSON.stringify(start_data)}`);
        return { valid: true, start_data };
    }
}
