/**
 * End-to-end: spawn the data gateway and the real scheduler server, write
 * schedules through the data layer (Walrus), and assert the scheduler caught
 * each one when its lifetime ended — undelivered jobs must be logged as
 * `not_delivered` through the gateway. Also checks the validator's /validate
 * auth gate. Run: npm run e2e  (needs data/.env configured).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ connect: { timeout: 60_000, family: 4 } }));

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DataLayer, GatewayClient } from 'quadra-data';

process.loadEnvFile(fileURLToPath(new URL('../../data/.env', import.meta.url)));

const PORT = 4099;
const GATEWAY_PORT = 8798;
const POLL_MS = 2000;
const INTERNAL_TOKEN = 'tok-internal-e2e';
const SCHEDULER_ROLE_TOKEN = 'tok-scheduler-e2e';
const INTAKE_ROLE_TOKEN = 'tok-intake-e2e';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FiredRecord {
    job_id: string;
    expires_at: number;
    fired_at: number;
    outcome: string;
}

async function getJson<T>(path: string, port = PORT): Promise<T> {
    const res = await fetch(`http://localhost:${port}${path}`);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return (await res.json()) as T;
}

async function waitForHealth(port: number, label: string, deadlineMs: number): Promise<void> {
    while (Date.now() < deadlineMs) {
        try {
            await getJson('/health', port);
            return;
        } catch {
            await sleep(1000);
        }
    }
    throw new Error(`${label} did not become healthy`);
}

let failures = 0;
function check(label: string, cond: boolean): void {
    console.log(`  ${cond ? '✓' : '✗'} ${label}`);
    if (!cond) failures++;
}

function spawnService(
    label: string,
    serverPath: string,
    cwd: string,
    env: Record<string, string>,
): ChildProcess {
    const tsxBin = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
    const child = spawn(tsxBin, [serverPath], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => process.stdout.write(`    [${label}] ${d}`));
    child.stderr?.on('data', (d) => process.stderr.write(`    [${label}:err] ${d}`));
    child.on('exit', (code, signal) =>
        console.log(`    [${label}] exited (code ${code}, signal ${signal})`),
    );
    return child;
}

async function main(): Promise<void> {
    console.log('\n═══ Scheduler ⇄ Gateway ⇄ Data layer end-to-end ═══\n');

    const dataDir = fileURLToPath(new URL('../../data', import.meta.url));
    const schedDir = fileURLToPath(new URL('..', import.meta.url));

    console.log(`▶ spawning data gateway on :${GATEWAY_PORT}`);
    const gateway = spawnService(
        'gateway',
        fileURLToPath(new URL('../../data/src/server.ts', import.meta.url)),
        dataDir,
        {
            PORT: String(GATEWAY_PORT),
            ROLE_TOKEN_SCHEDULER: SCHEDULER_ROLE_TOKEN,
            ROLE_TOKEN_INTAKE: INTAKE_ROLE_TOKEN,
        },
    );

    console.log(`▶ spawning scheduler server on :${PORT} (poll ${POLL_MS}ms)`);
    const scheduler = spawnService(
        'server',
        fileURLToPath(new URL('../src/server.ts', import.meta.url)),
        schedDir,
        {
            SCHEDULER_PORT: String(PORT),
            SCHEDULER_POLL_MS: String(POLL_MS),
            SCHEDULER_SECRET_KEY: Ed25519Keypair.generate().getSecretKey(),
            INTAKE_INTERNAL_TOKEN: INTERNAL_TOKEN,
            ROLE_TOKEN_SCHEDULER: SCHEDULER_ROLE_TOKEN,
            DATA_GATEWAY_URL: `http://localhost:${GATEWAY_PORT}`,
        },
    );
    const killAll = () => {
        scheduler.kill();
        gateway.kill();
    };

    try {
        await waitForHealth(GATEWAY_PORT, 'gateway', Date.now() + 30_000);
        await waitForHealth(PORT, 'scheduler', Date.now() + 30_000);
        console.log('  gateway + scheduler are healthy\n');

        // The validator's /validate must reject without the shared secret.
        const unauth = await fetch(`http://localhost:${PORT}/validate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ job_id: 'nope' }),
        });
        check('POST /validate without token -> 401', unauth.status === 401);

        // Write schedules THROUGH THE GATEWAY (intake role) — exactly like the
        // intake engine. The gateway is the only Walrus writer, so its per-pointer
        // serialization covers these writes racing the scheduler's removeJob.
        // Short absolute lifetimes: whether a job expires before or after the
        // scheduler first sees it, it must be caught (fired_at >= expires_at).
        const dl = DataLayer.forReads();
        const intakeGateway = new GatewayClient({
            url: `http://localhost:${GATEWAY_PORT}`,
            roleToken: INTAKE_ROLE_TOKEN,
        });
        const stamp = Date.now();
        const jobs = [
            { job_id: `sched-${stamp}-a`, expires_at: stamp + 20_000 },
            { job_id: `sched-${stamp}-b`, expires_at: stamp + 30_000 },
        ];
        console.log('\n▶ writing schedules via the gateway (each is a Walrus write):');
        for (const j of jobs) {
            await intakeGateway.scheduleJob(j.job_id, j.expires_at);
            console.log(`    set ${j.job_id} -> expires ${new Date(j.expires_at).toISOString()}`);
        }

        // No results were delivered for these jobs, so firing means: log the
        // failure + remove the schedule entry, both through the gateway.
        console.log('\n▶ waiting for the scheduler to catch every expiry (GET /fired)…');
        const deadline = Date.now() + 300_000;
        let fired: FiredRecord[] = [];
        while (Date.now() < deadline) {
            // A transient fetch hiccup must not abort the whole run.
            try {
                fired = await getJson<FiredRecord[]>('/fired');
                if (jobs.every((j) => fired.some((f) => f.job_id === j.job_id))) break;
            } catch (e) {
                console.log(`    (poll /fired failed: ${msg(e)}; retrying)`);
            }
            await sleep(3000);
        }

        const status = await getJson<{ refreshes: { grpc: number; poll: number } }>('/status');
        console.log(
            `\n  refreshes — gRPC: ${status.refreshes.grpc}, poll: ${status.refreshes.poll}\n`,
        );

        for (const j of jobs) {
            const rec = fired.find((f) => f.job_id === j.job_id);
            check(
                `caught ${j.job_id} (fired_at >= expires_at)`,
                !!rec && rec.fired_at >= j.expires_at,
            );
            check(`outcome of ${j.job_id} is not_delivered`, rec?.outcome === 'not_delivered');
        }

        // Gateway writes happened: the failure log has the entries and the
        // schedule entries are gone (removeJob ran).
        const log = await dl.delayedFailedJobs.list();
        for (const j of jobs) {
            check(
                `delayed_failed_jobs has ${j.job_id}`,
                log.some((f) => f.job_id === j.job_id && f.kind === 'delayed'),
            );
        }
        // The outcome is recorded before removeJob's (slow) Walrus write lands,
        // so give the removals their own deadline.
        console.log('▶ waiting for the schedule entries to be removed…');
        const removeDeadline = Date.now() + 180_000;
        let removed = false;
        while (Date.now() < removeDeadline && !removed) {
            try {
                const remaining = await dl.jobScheduler.list();
                removed = jobs.every((j) => !remaining.some((r) => r.job_id === j.job_id));
            } catch (e) {
                console.log(`    (poll schedule failed: ${msg(e)}; retrying)`);
            }
            if (!removed) await sleep(5000);
        }
        check('fired jobs were removed from the schedule', removed);

        killAll();
    } catch (error) {
        console.error('\n✗ e2e error:', msg(error));
        killAll();
        process.exit(1);
    }

    if (failures > 0) {
        console.error(`\n✗ ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\n✓ ALL CHECKS PASSED\n');
    process.exit(0);
}

function msg(e: unknown): string {
    if (!(e instanceof Error)) return String(e);
    const cause = e.cause instanceof Error ? ` (cause: ${e.cause.message})` : '';
    return `${e.message}${cause}`;
}

main().catch((error) => {
    console.error('\n✗ e2e failed:', error);
    process.exit(1);
});
