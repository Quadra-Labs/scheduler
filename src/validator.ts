import type { Signer } from '@mysten/sui/cryptography';
import type { DataLayer } from 'quadra-data';

import type { EvalEngine } from './config.js';
import { buildPayload, callEvalValidate, callEvalStartData } from './evaluation.js';

export interface ValidatorOptions {
    /** Dedicated Seal-reader key (the `set_scheduler` address), not the data
     * layer's master write key. */
    schedulerKey: Signer;
    /** evaluator_id -> evaluation engine (shared with the scheduler engine). */
    evalEngines: Map<string, EvalEngine>;
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
        const result = await this.#dl.jobResults.decrypt(jobId, this.#opts.schedulerKey);

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

        // Snapshot the start price at delivery (the job's started_at moment).
        const start_data = await callEvalStartData(engine.url, asset, result.started_at);
        this.#counts.validated++;
        console.log(`[validator] ${jobId} valid; start_data ${JSON.stringify(start_data)}`);
        return { valid: true, start_data };
    }
}
