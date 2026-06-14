/**
 * Unit checks for the evaluation client (no network): signature verification over
 * the exact enclave BCS layout, error classification, and payload shape.
 * Run: npm run test:eval
 */
import { bcs } from '@mysten/sui/bcs';
import { fromHex, toHex } from '@mysten/sui/utils';
import * as ed25519 from '@noble/ed25519';
import type { JobResult } from 'quadra-data';

import {
    buildPayload,
    classifyEvalError,
    verifyScoreSignature,
    type EvalResponse,
} from '../src/evaluation.js';

let failures = 0;
function check(label: string, ok: boolean): void {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures++;
}

// Same layout the enclave signs over.
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

async function main(): Promise<void> {
    console.log('\n═══ scheduler eval unit ═══\n');

    // --- signature verification (mirrors the enclave's sign path) ----------
    const priv = ed25519.utils.randomPrivateKey();
    const pub = await ed25519.getPublicKeyAsync(priv);
    const agentHex = 'ab'.repeat(32);
    const data = {
        agent_id: Array.from(fromHex(agentHex)),
        category_id: 'price-range-guess',
        job_id: 'job-1',
        score: 100,
        finalized_price: 60050n,
    };
    const responseInner = { intent: 0, timestamp_ms: 1_700_000_061_000 };
    const bytes = IntentMessage.serialize({
        intent: responseInner.intent,
        timestamp_ms: BigInt(responseInner.timestamp_ms),
        data,
    }).toBytes();
    const sigHex = toHex(await ed25519.signAsync(bytes, priv));

    const response: EvalResponse['response'] = {
        intent: 0,
        timestamp_ms: responseInner.timestamp_ms,
        data: {
            agent_id: `0x${agentHex}`,
            category_id: 'price-range-guess',
            job_id: 'job-1',
            score: 100,
            finalized_price: 60050,
        },
    };

    check('valid signature verifies', await verifyScoreSignature(pub, response, sigHex));

    const tampered = { ...response, data: { ...response.data, score: 99 } };
    check('tampered score fails', !(await verifyScoreSignature(pub, tampered, sigHex)));

    const wrongKey = await ed25519.getPublicKeyAsync(ed25519.utils.randomPrivateKey());
    check('wrong key fails', !(await verifyScoreSignature(wrongKey, response, sigHex)));

    // --- error classification ---------------------------------------------
    check(
        '"delivered too late" -> agent',
        classifyEvalError('job delivered too late: took ...') === 'agent',
    );
    check(
        '"missing field" -> agent',
        classifyEvalError("agent_result is missing field 'x'") === 'agent',
    );
    check(
        '"not of type" -> agent',
        classifyEvalError("field 'x' is not of type 'number'") === 'agent',
    );
    check(
        '"oracle fetch failed" -> engine',
        classifyEvalError('oracle fetch failed: 500') === 'engine',
    );
    check(
        '"not resolvable yet" -> engine',
        classifyEvalError('job is not resolvable yet') === 'engine',
    );

    // --- payload shape -----------------------------------------------------
    const result = {
        job_id: 'job-1',
        user: '0xuser',
        agent: `0x${agentHex}`,
        status: 'delivered',
        job: {
            lifetime: '5m',
            template: {
                id: 'price_range_5m',
                category: 'finance',
                description: '',
                output: { minPrice: 'number', maxPrice: 'number' },
                evaluator_id: 'price-range-guess',
                start_data_template: { start_price: 'number' },
                minimum_lifetime: 60_000,
                allowed_assets: ['BTC'],
            },
        },
        agent_result: { minPrice: 60000, maxPrice: 60100 },
        finalized_result: {},
        score: 0,
        started_at: 1_700_000_000_000,
        delivered_at: 1_700_000_060_000,
    } as unknown as JobResult;
    const p = buildPayload('job-1', result, 'BTC', { start_price: 6_000_000_000_000 }).payload;
    check('payload category_id = evaluator_id', p.category_id === 'price-range-guess');
    check(
        'payload job_template is {output,lifetime}',
        JSON.stringify(Object.keys(p.job_template).sort()) === '["lifetime","output"]',
    );
    check('payload carries asset + start_data', p.asset === 'BTC' && !!p.start_data);
    check(
        'payload carries timestamps',
        p.started_at_ms === 1_700_000_000_000 && p.delivered_at_ms === 1_700_000_060_000,
    );

    if (failures > 0) {
        console.error(`\n✗ ${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\n✓ ALL CHECKS PASSED\n');
}

main().catch((error) => {
    console.error('\n✗ eval unit failed:', error);
    process.exit(1);
});
