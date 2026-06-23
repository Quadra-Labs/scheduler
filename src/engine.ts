import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import type { Signer } from '@mysten/sui/cryptography';
import type { DataLayer, GatewayClient, PointerWatcher } from 'quadra-data';

import type { EvalEngineLookup } from 'quadra-data';

import {
    buildPayload,
    callEvalEngine,
    classifyEvalError,
    verifyScoreSignature,
    type EvalResponse,
} from './evaluation.js';
import { resolveRpcUrl, retryingRpcTransport, withRetry } from './rpcRetry.js';

export type Outcome = 'scored' | 'failed' | 'eval_error' | 'no_engine' | 'not_delivered';

/** A job whose lifetime ended and that the scheduler has handled. */
export interface FiredRecord {
    job_id: string;
    expires_at: number;
    fired_at: number;
    outcome: Outcome;
    score?: number;
    reason?: string;
}

export type RefreshVia = 'init' | 'gRPC' | 'poll';

export interface SchedulerStatus {
    jobs: Record<string, number>;
    fired: FiredRecord[];
    lastVersion: number;
    lastRefreshVia: RefreshVia | null;
    refreshes: { grpc: number; poll: number };
}

export interface SchedulerEngineOptions {
    pollMs: number;
    gateway: GatewayClient;
    /** The dedicated Seal-reader key (registered via `job_access::set_scheduler`). */
    schedulerKey: Signer;
    /** evaluator_id -> evaluation engine (dynamic Walrus catalog). */
    evalEngines: EvalEngineLookup;
    /** Override the on-chain `Enclave.pk` read (testing only). */
    fetchEnclavePk?: (enclaveId: string) => Promise<Uint8Array>;
}

/**
 * Watches `job_scheduler` and, when a job's lifetime ends, reads the Seal'd
 * result, calls the job's evaluation engine (a Nautilus enclave), verifies the
 * enclave's signature, writes the score (or a failure) through the gateway, and
 * removes the job. Changes are detected by the gRPC pointer watcher with a
 * per-interval pointer-version poll fallback. Reads + HTTP only (writes go
 * through the gateway), so the gRPC stream stays healthy.
 */
export class SchedulerEngine {
    #dl: DataLayer;
    #pollMs: number;
    #gateway: GatewayClient;
    #schedulerKey: Signer;
    #evalEngines: EvalEngineLookup;
    #fetchEnclavePkOverride: ((enclaveId: string) => Promise<Uint8Array>) | undefined;
    #sui: SuiJsonRpcClient;
    #pointerId: string;
    #jobs = new Map<string, number>();
    #fired = new Map<string, FiredRecord>();
    #inflight = new Set<string>();
    #lastVersion = -1;
    #counts = { grpc: 0, poll: 0 };
    #lastRefreshVia: RefreshVia | null = null;
    #watcher: PointerWatcher | undefined;
    #timer: ReturnType<typeof setInterval> | undefined;

    constructor(dl: DataLayer, options: SchedulerEngineOptions) {
        this.#dl = dl;
        this.#pollMs = options.pollMs;
        this.#gateway = options.gateway;
        this.#schedulerKey = options.schedulerKey;
        this.#evalEngines = options.evalEngines;
        this.#fetchEnclavePkOverride = options.fetchEnclavePk;
        this.#pointerId = dl.config.pointers.job_scheduler;
        this.#sui = new SuiJsonRpcClient({
            network: dl.config.network,
            transport: retryingRpcTransport(resolveRpcUrl(getJsonRpcFullnodeUrl(dl.config.network))),
        });
    }

    async start(): Promise<void> {
        const state = await withRetry(() => this.#dl.clients.wj.readPointer(this.#pointerId));
        this.#lastVersion = state.version;
        await this.#refresh(state.version, 'init');

        this.#watcher = this.#dl.createWatcher();
        this.#watcher.on((c) => {
            if (c.db === 'job_scheduler') void this.#onNewVersion(c.version, 'gRPC');
        });
        this.#watcher.start();

        this.#timer = setInterval(() => void this.#tick(), this.#pollMs);
        console.log(
            `[scheduler] started: ${this.#jobs.size} jobs, pointer v${this.#lastVersion}, poll ${this.#pollMs}ms, ${this.#evalEngines.size} eval engine(s)`,
        );
    }

    stop(): void {
        this.#watcher?.stop();
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = undefined;
    }

    status(): SchedulerStatus {
        return {
            jobs: Object.fromEntries(this.#jobs),
            fired: [...this.#fired.values()],
            lastVersion: this.#lastVersion,
            lastRefreshVia: this.#lastRefreshVia,
            refreshes: { ...this.#counts },
        };
    }

    firedList(): FiredRecord[] {
        return [...this.#fired.values()];
    }

    async #tick(): Promise<void> {
        try {
            const state = await withRetry(() => this.#dl.clients.wj.readPointer(this.#pointerId));
            await this.#onNewVersion(state.version, 'poll');
        } catch (error) {
            console.error(
                '[scheduler] poll failed:',
                error instanceof Error ? error.message : error,
            );
        }
        this.#scanExpiries();
    }

    /** Refresh the schedule if the pointer advanced. gRPC and poll race; set
     * `#lastVersion` first so the loser is a no-op. */
    async #onNewVersion(version: number, via: RefreshVia): Promise<void> {
        if (version <= this.#lastVersion) return;
        this.#lastVersion = version;
        if (via === 'gRPC') this.#counts.grpc++;
        else if (via === 'poll') this.#counts.poll++;
        console.log(`[scheduler] change captured via ${via} (pointer v${version})`);
        await this.#refresh(version, via);
    }

    async #refresh(version: number, via: RefreshVia): Promise<void> {
        const jobs = await this.#dl.jobScheduler.list();
        this.#jobs = new Map(jobs.map((j) => [j.job_id, j.expires_at]));
        this.#lastRefreshVia = via;
        console.log(
            `[scheduler] schedule refreshed via ${via}: ${this.#jobs.size} jobs (pointer v${version})`,
        );
    }

    #scanExpiries(): void {
        const now = Date.now();
        for (const [job_id, expires_at] of this.#jobs) {
            if (expires_at <= now && !this.#fired.has(job_id) && !this.#inflight.has(job_id)) {
                this.#inflight.add(job_id);
                void this.#onExpired(job_id, expires_at).finally(() =>
                    this.#inflight.delete(job_id),
                );
            }
        }
    }

    /** A job's lifetime ended: evaluate the delivered result, score it, remove it.
     * Transient failures (decrypt/network/gateway) are left unfired to retry. */
    async #onExpired(job_id: string, expires_at: number): Promise<void> {
        try {
            const blobId = await this.#dl.jobResultsIndex.get(job_id);
            if (!blobId) {
                await this.#handleNotDelivered(job_id, expires_at);
                return;
            }

            const result = await this.#dl.jobResults.decrypt(job_id, this.#schedulerKey);
            const evaluatorId = result.job.template.evaluator_id;
            const engine = this.#evalEngines.get(evaluatorId);
            if (!engine) {
                await this.#gateway.addFailure({
                    job_id,
                    agent: result.agent,
                    kind: 'failed',
                    reason: `no eval engine for '${evaluatorId}'`,
                });
                await this.#gateway.removeJob(job_id);
                this.#record(job_id, expires_at, 'no_engine', { reason: evaluatorId });
                return;
            }

            // Score against the asset + start price captured at delivery (intake
            // recorded these in the scheduler when the job validated).
            const start = await this.#dl.jobScheduler.getStart(job_id);
            const call = await callEvalEngine(
                engine.url,
                buildPayload(job_id, result, start?.asset ?? '', start?.data ?? {}),
            );
            if (call.ok) {
                const ev = call.body as EvalResponse;
                if (engine.enclaveId) {
                    const pk = await (
                        this.#fetchEnclavePkOverride ?? this.#fetchEnclavePk.bind(this)
                    )(engine.enclaveId);
                    if (!(await verifyScoreSignature(pk, ev.response, ev.signature))) {
                        throw new Error(`enclave signature invalid for ${job_id}`);
                    }
                } else {
                    console.warn(
                        `[scheduler] ${job_id}: no enclave_id for '${evaluatorId}', trusting response (dev)`,
                    );
                }
                const score = ev.response.data.score;
                await this.#gateway.recordScore(result.agent, score);
                await this.#gateway.removeJob(job_id);
                this.#record(job_id, expires_at, 'scored', { score });
                console.log(`[scheduler] job ${job_id} scored ${score} -> agent_scores`);
            } else {
                const msg = typeof call.body === 'string' ? call.body : JSON.stringify(call.body);
                const fault = classifyEvalError(msg);
                if (fault === 'agent') {
                    await this.#gateway.recordScore(result.agent, 0);
                    await this.#gateway.addFailure({
                        job_id,
                        agent: result.agent,
                        kind: 'failed',
                        reason: msg,
                    });
                    this.#record(job_id, expires_at, 'failed', { score: 0, reason: msg });
                } else {
                    await this.#gateway.addFailure({
                        job_id,
                        agent: result.agent,
                        kind: 'delayed',
                        reason: `eval error: ${msg}`,
                    });
                    this.#record(job_id, expires_at, 'eval_error', { reason: msg });
                }
                await this.#gateway.removeJob(job_id);
                console.warn(`[scheduler] job ${job_id} eval ${fault}-fault: ${msg}`);
            }
        } catch (error) {
            console.error(
                `[scheduler] onExpired ${job_id} failed (will retry):`,
                error instanceof Error ? error.message : error,
            );
        }
    }

    /** No result was delivered by lifetime end: score the agent 0 and log it. */
    async #handleNotDelivered(job_id: string, expires_at: number): Promise<void> {
        const agent = await this.#fetchAgentFromJobPaid(job_id);
        if (agent) {
            await this.#gateway.recordScore(agent, 0);
            await this.#gateway.addFailure({
                job_id,
                agent,
                kind: 'delayed',
                reason: 'not delivered within lifetime',
            });
            this.#record(job_id, expires_at, 'not_delivered', { score: 0 });
        } else {
            await this.#gateway.addFailure({
                job_id,
                agent: null,
                kind: 'delayed',
                reason: 'not delivered (agent unknown)',
            });
            this.#record(job_id, expires_at, 'not_delivered');
        }
        await this.#gateway.removeJob(job_id);
        console.log(`[scheduler] job ${job_id} not delivered; scored 0`);
    }

    /** Find the agent for a job from its on-chain `JobPaid` event (bounded scan). */
    async #fetchAgentFromJobPaid(jobId: string): Promise<string | undefined> {
        const type = `${this.#dl.config.quadraPackageId}::intake::JobPaid`;
        let cursor: { txDigest: string; eventSeq: string } | null | undefined;
        for (let page = 0; page < 10; page++) {
            const res = await this.#sui.queryEvents({
                query: { MoveEventType: type },
                cursor,
                order: 'descending',
                limit: 50,
            });
            for (const e of res.data) {
                const j = e.parsedJson as { job_id?: string; agent_wallet?: string };
                if (j.job_id === jobId) return j.agent_wallet;
            }
            if (!res.hasNextPage) break;
            cursor = res.nextCursor;
        }
        return undefined;
    }

    /** Read the registered ed25519 public key from the on-chain `Enclave` object. */
    async #fetchEnclavePk(enclaveId: string): Promise<Uint8Array> {
        const o = await this.#sui.getObject({ id: enclaveId, options: { showContent: true } });
        const pk = (o.data?.content as { fields?: { pk?: number[] } } | undefined)?.fields?.pk;
        if (!pk) throw new Error(`Enclave ${enclaveId} has no pk`);
        return Uint8Array.from(pk);
    }

    #record(
        job_id: string,
        expires_at: number,
        outcome: Outcome,
        extra: { score?: number; reason?: string } = {},
    ): void {
        this.#fired.set(job_id, { job_id, expires_at, fired_at: Date.now(), outcome, ...extra });
    }
}
