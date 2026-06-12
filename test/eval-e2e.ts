/**
 * Full end-to-end for #onExpired against a live network:
 *   - a mock eval engine that returns a REAL signed score,
 *   - the live data gateway (child process) the scheduler writes through,
 *   - a real Seal'd result the scheduler decrypts,
 *   - the SchedulerEngine actually: detect expiry -> decrypt -> call eval ->
 *     verify the enclave signature -> recordScore -> removeJob.
 *
 * Run: npm run test:eval-e2e   (needs a configured ../data/.env, Walrus writes are slow)
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { fromHex, toHex } from '@mysten/sui/utils';
import * as ed25519 from '@noble/ed25519';

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

import { DataLayer, GatewayClient } from 'quadra-data';
import type { JobResult } from 'quadra-data';
import { SchedulerEngine } from '../src/index.js';

process.loadEnvFile(fileURLToPath(new URL('../../data/.env', import.meta.url)));

const GATEWAY_PORT = 8801;
const MOCK_PORT = 9099;
const ROLE_TOKEN = 'e2e-scheduler-token';
const SCORE = 77;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean): void {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures++;
}

// Same BCS the enclave (and the engine) sign/verify over.
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

async function startMockEval(privKey: Uint8Array): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/process_data') {
            res.writeHead(404).end();
            return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            void (async () => {
                const { payload } = JSON.parse(body) as {
                    payload: { agent_id: string; category_id: string; job_id: string };
                };
                const ts = Date.now();
                const data = {
                    agent_id: Array.from(fromHex(payload.agent_id)),
                    category_id: payload.category_id,
                    job_id: payload.job_id,
                    score: SCORE,
                    finalized_price: 60050n,
                };
                const bytes = IntentMessage.serialize({
                    intent: 0,
                    timestamp_ms: BigInt(ts),
                    data,
                }).toBytes();
                const signature = toHex(await ed25519.signAsync(bytes, privKey));
                res.writeHead(200, { 'content-type': 'application/json' }).end(
                    JSON.stringify({
                        response: {
                            intent: 0,
                            timestamp_ms: ts,
                            data: {
                                agent_id: payload.agent_id,
                                category_id: payload.category_id,
                                job_id: payload.job_id,
                                score: SCORE,
                                finalized_price: 60050,
                            },
                        },
                        signature,
                    }),
                );
            })();
        });
    });
    await new Promise<void>((resolve) => server.listen(MOCK_PORT, resolve));
    return server;
}

async function recordAccess(
    dl: DataLayer,
    jobId: string,
    user: string,
    agent: string,
): Promise<void> {
    const tx = new Transaction();
    tx.moveCall({
        target: `${dl.config.quadraPackageId}::job_access::record`,
        arguments: [
            tx.object(dl.config.jobAccessRegistryId),
            tx.pure.string(jobId),
            tx.pure.address(user),
            tx.pure.address(agent),
        ],
    });
    const res = await dl.clients.sui.core.signAndExecuteTransaction({
        transaction: tx,
        signer: dl.clients.signer,
    });
    if (res.$kind === 'FailedTransaction') throw new Error('record access failed');
    await dl.clients.sui.core.waitForTransaction({ digest: res.Transaction.digest });
}

async function main(): Promise<void> {
    console.log('\n═══ scheduler #onExpired end-to-end ═══\n');

    // The Seal-reader key. Production uses a dedicated SCHEDULER_SECRET_KEY registered
    // via set_scheduler; for this harness we fall back to DATA_SECRET_KEY and grant it
    // per-job access below, since we only need *a* key that can decrypt the result.
    const schedulerKey = Ed25519Keypair.fromSecretKey(
        process.env.SCHEDULER_SECRET_KEY ?? process.env.DATA_SECRET_KEY!,
    );
    const schedulerAddr = schedulerKey.toSuiAddress();
    const agent = Ed25519Keypair.generate().toSuiAddress();
    const jobId = `eval-e2e-${Date.now()}`;

    // Mock eval engine with a real signing key; the engine verifies against its pub.
    const mockPriv = ed25519.utils.randomPrivateKey();
    const mockPub = await ed25519.getPublicKeyAsync(mockPriv);
    const mock = await startMockEval(mockPriv);
    console.log(`▶ mock eval engine on :${MOCK_PORT}`);

    // The data gateway the scheduler writes scores/removals through.
    const tsxBin = fileURLToPath(new URL('../../data/node_modules/.bin/tsx', import.meta.url));
    const gwPath = fileURLToPath(new URL('../../data/src/server.ts', import.meta.url));
    const gwDir = fileURLToPath(new URL('../../data', import.meta.url));
    const gateway = spawn(tsxBin, [gwPath], {
        cwd: gwDir,
        env: { ...process.env, PORT: String(GATEWAY_PORT), ROLE_TOKEN_SCHEDULER: ROLE_TOKEN },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    gateway.stderr.on('data', (d) => process.stderr.write(`    [gateway] ${d}`));

    const dlWrite = DataLayer.fromEnv();
    const dlRead = DataLayer.forReads();
    let engine: SchedulerEngine | undefined;
    try {
        // Wait for the gateway.
        for (let i = 0; i < 30; i++) {
            try {
                if ((await fetch(`http://localhost:${GATEWAY_PORT}/health`)).ok) break;
            } catch {
                /* not up */
            }
            await sleep(1000);
        }

        // Clear any already-expired jobs left by prior test runs, so this run fires
        // only our job (one bulk write).
        const stale = (await dlWrite.jobScheduler.list())
            .filter((j) => j.expires_at <= Date.now())
            .map((j) => j.job_id);
        if (stale.length) {
            console.log(`▶ clearing ${stale.length} stale expired job(s) from prior runs…`);
            await dlWrite.jobScheduler.removeMany(stale);
        }

        // Setup: a delivered, Seal'd result the scheduler can decrypt, scheduled to
        // have already expired.
        console.log('▶ recording Seal access + storing the sealed result (Walrus, slow)…');
        await recordAccess(dlWrite, jobId, schedulerAddr, agent); // scheduler key (as user) may decrypt
        const now = Date.now();
        const result: JobResult = {
            job_id: jobId,
            user: schedulerAddr,
            agent,
            status: 'delivered',
            job: {
                lifetime: '5m',
                template: {
                    id: 'mock-tpl',
                    category: 'finance',
                    description: '',
                    output: { minPrice: 'number', maxPrice: 'number' },
                    evaluator_id: 'mock',
                },
            },
            agent_result: { minPrice: 60000, maxPrice: 60100 },
            finalized_result: {},
            score: 0,
            started_at: now - 300_000,
            delivered_at: now - 240_000,
        };
        await dlWrite.jobResults.store(result);
        console.log('▶ scheduling the job as already-expired…');
        await dlWrite.jobScheduler.set(jobId, now - 1000);

        // Run the engine in-process so we can inject the enclave pk (verify path).
        engine = new SchedulerEngine(dlRead, {
            pollMs: 2000,
            gateway: new GatewayClient({
                url: `http://localhost:${GATEWAY_PORT}`,
                roleToken: ROLE_TOKEN,
            }),
            schedulerKey,
            evalEngines: new Map([
                ['mock', { url: `http://localhost:${MOCK_PORT}`, enclaveId: 'test' }],
            ]),
            fetchEnclavePk: async () => mockPub, // verify the real signature against the mock key
        });
        await engine.start();

        console.log('▶ waiting for the scheduler to evaluate + score the job…');
        let fired = engine.firedList().find((f) => f.job_id === jobId);
        const deadline = Date.now() + 300_000; // recordScore + removeJob are slow Walrus writes
        while (!fired && Date.now() < deadline) {
            await sleep(2000);
            fired = engine.firedList().find((f) => f.job_id === jobId);
        }
        console.log(`    outcome: ${JSON.stringify(fired)}`);

        check('job evaluated -> outcome "scored"', fired?.outcome === 'scored');
        check(`score = ${SCORE} (signed by the enclave, verified)`, fired?.score === SCORE);
        const onchainScore = await dlRead.agentScores.get(agent);
        check('agent_scores updated via gateway', onchainScore?.score === SCORE);
        const stillScheduled = (await dlRead.jobScheduler.list()).some((j) => j.job_id === jobId);
        check('job removed from job_scheduler', !stillScheduled);
    } finally {
        engine?.stop();
        mock.close();
        gateway.kill();
    }

    if (failures > 0) {
        console.error(`\n✗ ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\n✓ ALL CHECKS PASSED\n');
    process.exit(0);
}

main().catch((error) => {
    console.error('\n✗ eval-e2e failed:', error);
    process.exit(1);
});
