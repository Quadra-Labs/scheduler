import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DataLayer, GatewayClient } from 'quadra-data';

// Public Sui/Walrus endpoints prefer IPv4 with a generous connect timeout.
setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

// The scheduler reads the same Walrus databases as the data layer, so it shares
// the data layer's .env (pointers, keys, network). Override with DATA_ENV_PATH.
try {
    const envPath =
        process.env.DATA_ENV_PATH ?? fileURLToPath(new URL('../../data/.env', import.meta.url));
    process.loadEnvFile(envPath);
} catch {
    // env may already be provided by the parent process (e.g. a spawned child)
}

export interface SchedulerConfig {
    port: number;
    /** Fallback poll + expiry-scan interval in ms. */
    pollMs: number;
    /** Shared secret intake must present on `POST /validate`. */
    internalToken: string;
    /** Dedicated key the validator + evaluator decrypt with — its address must be
     * the one registered via `job_access::set_scheduler` (kept separate from the
     * data layer's master write key). */
    schedulerKey: Ed25519Keypair;
    /** Data gateway base URL for writes (scores, failures, removing handled jobs). */
    gatewayUrl: string;
    /** Scheduler's gateway role token (`ROLE_TOKEN_SCHEDULER`). */
    roleToken: string;
    /** evaluator_id -> evaluation engine (one enclave per evaluator_id). */
    evalEngines: Map<string, EvalEngine>;
}

/** Where to reach (and how to verify) one evaluation engine. */
export interface EvalEngine {
    /** Base URL of the enclave / its backend (POST /process_data). */
    url: string;
    /** On-chain `enclave::Enclave` object id. Omit to skip signature verification
     * (local dev). */
    enclaveId?: string;
}

function num(name: string, fallback: number): number {
    const value = process.env[name];
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${value}"`);
    return n;
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var ${name}`);
    return value;
}

export function loadSchedulerConfig(): SchedulerConfig {
    return {
        port: num('SCHEDULER_PORT', 4000),
        pollMs: num('SCHEDULER_POLL_MS', 2000),
        internalToken: required('INTAKE_INTERNAL_TOKEN'),
        schedulerKey: Ed25519Keypair.fromSecretKey(required('SCHEDULER_SECRET_KEY')),
        gatewayUrl: process.env.DATA_GATEWAY_URL ?? 'http://localhost:8787',
        roleToken: required('ROLE_TOKEN_SCHEDULER'),
        evalEngines: loadEvalEngines(),
    };
}

/** Parse `EVAL_ENGINES` (a JSON object `evaluator_id -> { url, enclave_id? }`). */
function loadEvalEngines(): Map<string, EvalEngine> {
    const raw = process.env.EVAL_ENGINES;
    if (!raw) return new Map();
    let parsed: Record<string, { url: string; enclave_id?: string }>;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(
            `EVAL_ENGINES is not valid JSON: ${error instanceof Error ? error.message : error}`,
        );
    }
    return new Map(
        Object.entries(parsed).map(([id, e]) => [
            id,
            { url: e.url, ...(e.enclave_id ? { enclaveId: e.enclave_id } : {}) },
        ]),
    );
}

/** Read-only data layer (no master key); the scheduler reads + decrypts only. */
export function createDataLayer(): DataLayer {
    return DataLayer.forReads();
}

/** Gateway client for when the scheduler writes scores / removes handled jobs. */
export function createGateway(config: SchedulerConfig): GatewayClient {
    return new GatewayClient({ url: config.gatewayUrl, roleToken: config.roleToken });
}
