/**
 * Quadra Scheduler Engine — Express server.
 *
 * Runs two engines in one read-only process:
 * - SchedulerEngine: watches `job_scheduler`, fires when a job's lifetime ends
 *   (decrypt result → eval engine scores → gateway writes).
 * - ValidatorEngine: answers the intake engine's `POST /validate` — is this
 *   delivered result a valid output? (decrypt → eval engine validates).
 */
import { timingSafeEqual } from 'node:crypto';

import express from 'express';

import { createDataLayer, createGateway, loadSchedulerConfig } from './config.js';
import { SchedulerEngine } from './engine.js';
import { ValidatorEngine } from './validator.js';

/** Constant-time secret comparison (length-checked so it never throws). */
function tokenMatches(provided: string | undefined, expected: string): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

async function main(): Promise<void> {
    const config = loadSchedulerConfig();
    const dl = createDataLayer();
    const engine = new SchedulerEngine(dl, {
        pollMs: config.pollMs,
        gateway: createGateway(config),
        schedulerKey: config.schedulerKey,
        evalEngines: config.evalEngines,
    });
    await engine.start();

    const validator = new ValidatorEngine(dl, {
        schedulerKey: config.schedulerKey,
        evalEngines: config.evalEngines,
    });

    const app = express();
    app.use(express.json());

    // Intake asks: is this delivered result valid? (trusted, shared secret).
    // `valid: false` is a final rejection; transient trouble (no result yet,
    // key servers, eval engine down) is a 502 so intake can retry.
    app.post('/validate', (req, res) => {
        if (!tokenMatches(req.header('x-quadra-internal'), config.internalToken)) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }
        validator
            .validate(String(req.body.job_id))
            .then((verdict) => res.json(verdict))
            .catch((err) =>
                res.status(502).json({ error: err instanceof Error ? err.message : 'error' }),
            );
    });

    app.get('/health', (_req, res) => {
        const s = engine.status();
        res.json({
            ok: true,
            network: dl.config.network,
            jobs: Object.keys(s.jobs).length,
            fired: s.fired.length,
            lastVersion: s.lastVersion,
            refreshes: s.refreshes,
            validator: validator.status(),
        });
    });
    app.get('/status', (_req, res) =>
        res.json({ ...engine.status(), validator: validator.status() }),
    );
    app.get('/fired', (_req, res) => res.json(engine.firedList()));

    app.listen(config.port, () => {
        console.log(`[scheduler] listening on http://localhost:${config.port}`);
    });
}

main().catch((error) => {
    console.error('[scheduler] failed to start:', error);
    process.exit(1);
});
