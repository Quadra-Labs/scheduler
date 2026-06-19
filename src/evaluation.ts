import { bcs } from '@mysten/sui/bcs';
import { fromHex } from '@mysten/sui/utils';
import * as ed25519 from '@noble/ed25519';
import type { JobResult } from 'quadra-data';

/** The signed score the enclave returns (`ScoreResult` in the Move/Rust side). */
export interface ScoreData {
    agent_id: string | number[];
    category_id: string;
    job_id: string;
    score: number;
    finalized_price: number | string;
}

/** The `process_data` response body. */
export interface EvalResponse {
    response: { intent: number; timestamp_ms: number | string; data: ScoreData };
    signature: string;
}

export interface EvalCallResult {
    status: number;
    ok: boolean;
    /** Parsed JSON on success; the raw message text on a 400. */
    body: EvalResponse | string;
}

/** BCS layout matching the enclave's `IntentMessage<ScoreResult>` exactly. */
const ScoreResult = bcs.struct('ScoreResult', {
    agent_id: bcs.fixedArray(32, bcs.u8()),
    category_id: bcs.string(),
    job_id: bcs.string(),
    score: bcs.u8(),
    finalized_price: bcs.u64(),
});
const IntentMessage = bcs.struct('IntentMessage', {
    intent: bcs.u8(),
    timestamp_ms: bcs.u64(),
    data: ScoreResult,
});

/** Build the `process_data` payload from a decrypted job result. */
export function buildPayload(jobId: string, result: JobResult) {
    const isPrediction = result.job.template.category === 'prediction';
    return {
        payload: {
            agent_id: result.agent,
            category_id: result.job.template.evaluator_id,
            job_id: jobId,
            agent_result: result.agent_result,
            job_template: {
                output: result.job.template.output,
                lifetime: result.job.lifetime,
            },
            started_at_ms: result.started_at,
            delivered_at_ms: result.delivered_at,
            // Prediction evaluators (polymarket-*) resolve ground truth from these fixed params
            // (market_id / target_ts / event_id), not from a Pyth asset, so forward them. Finance
            // jobs omit params and the evaluator reads `asset` instead.
            ...(isPrediction ? { params: result.params ?? {} } : {}),
        },
    };
}

/** POST a job to an evaluation engine's `/process_data` endpoint. */
export async function callEvalEngine(url: string, payload: unknown): Promise<EvalCallResult> {
    const res = await fetch(`${url.replace(/\/$/, '')}/process_data`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) return { status: res.status, ok: true, body: (await res.json()) as EvalResponse };
    return { status: res.status, ok: false, body: await res.text() };
}

/**
 * POST a job to an evaluation engine's `/validate` endpoint (input checks only,
 * no oracle/scoring). A 400 is the engine rejecting the input (with the reason);
 * any other failure is transient and thrown so the caller can retry.
 */
export async function callEvalValidate(
    url: string,
    payload: unknown,
): Promise<{ valid: boolean; reason?: string }> {
    const res = await fetch(`${url.replace(/\/$/, '')}/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) return { valid: true };
    const reason = await res.text();
    if (res.status === 400) return { valid: false, reason };
    throw new Error(`eval /validate -> ${res.status} ${reason}`);
}

function agentIdBytes(agent: string | number[]): number[] {
    if (Array.isArray(agent)) return agent;
    return Array.from(fromHex(agent));
}

/**
 * Verify the enclave signature over `bcs(IntentMessage{intent, timestamp_ms,
 * ScoreResult})` against the enclave's registered ed25519 public key. Pure —
 * the caller fetches `pk` from the on-chain `Enclave` object.
 */
export async function verifyScoreSignature(
    pk: Uint8Array,
    response: EvalResponse['response'],
    signatureHex: string,
): Promise<boolean> {
    const bytes = IntentMessage.serialize({
        intent: response.intent,
        timestamp_ms: BigInt(response.timestamp_ms),
        data: {
            agent_id: agentIdBytes(response.data.agent_id),
            category_id: response.data.category_id,
            job_id: response.data.job_id,
            score: response.data.score,
            finalized_price: BigInt(response.data.finalized_price),
        },
    }).toBytes();
    try {
        return await ed25519.verifyAsync(fromHex(signatureHex), bytes, pk);
    } catch {
        return false;
    }
}

/**
 * Classify an eval-engine rejection (HTTP 400 message). `'agent'` means the
 * agent is at fault (score 0); `'engine'` means an engine/oracle/config problem
 * (no score change).
 */
export function classifyEvalError(message: string): 'agent' | 'engine' {
    return /too late|before started_at|missing field|not of type|valid sui address/i.test(message)
        ? 'agent'
        : 'engine';
}
