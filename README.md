# Quadra Scheduler Engine

Watches the `job_scheduler` database (Walrus, via the data layer), keeps the
schedule in memory, and when a job's lifetime ends (`expires_at <= now`)
**evaluates it**: reads the Seal'd result, calls the job's evaluation engine (a
Sui Nautilus enclave), verifies the enclave's signature, writes the score (or a
failure) through the gateway, and removes the job. An Express service.

Jobs are added/removed through the **data layer**; the scheduler reads + watches
and writes its outcomes through the **gateway** (`ROLE_TOKEN_SCHEDULER`).

The same process also runs the **validator engine** (see below): a distinct job
from scheduling — it answers the intake engine's "is this delivery valid?" so
intake can release payment.

## On lifetime end (`#onExpired`)

1. No result in `job_results_index` → **not delivered**: find the agent from the
   on-chain `JobPaid` event, `recordScore(agent, 0)` + log a failure, remove the job.
2. Delivered → decrypt the result (scheduler Seal key) → look up the eval engine
   by `template.evaluator_id` → `POST {url}/process_data`.
3. **200**: if the engine has an `enclave_id`, fetch `Enclave.pk` and verify the
   ed25519 signature over `bcs(IntentMessage{intent,timestamp_ms,ScoreResult})`
   before trusting it → `recordScore(agent, score)`.
   **400**: agent-fault (late / bad schema) → score 0 + failure; engine/oracle
   fault → failure only (no score change).
4. Remove the job from `job_scheduler`. Outcomes are exposed at `/status`.

Eval engines are loaded dynamically from the Walrus `eval_engines` catalog
(`POINTER_EVAL_ENGINES` in `../data/.env`). Register each evaluator after deploy
with `npm run register-eval-engine` in the data package (or `PUT /eval-engines/:id`
via the gateway). One enclave serves one `evaluator_id` (= the enclave's
`category_id`); many templates can share it. Omit `enclave_id` for local dev to
skip signature verification. Deprecated: set `EVAL_ENGINES` in env to overlay entries
for local dev without gateway writes. Unit test: `npm run test:eval`.

## How it watches

- **Primary:** the data layer's gRPC pointer watcher (`PointerWatcher`) pushes
  `job_scheduler` pointer changes → refresh the in-memory schedule.
- **Fallback:** each `SCHEDULER_POLL_MS` interval, poll the pointer version; if it
  advanced before gRPC reported it, refresh. The same interval scans for expiries.
- Each refresh logs which mechanism captured it (`via=gRPC` / `via=poll`), and the
  counts are exposed at `/status`.

Reads + HTTP only (writes go through the gateway, not Walrus directly) ⇒ the gRPC
stream stays healthy in this process.

## Validator engine

A separate concern from scheduling: it decides whether a delivered job is valid so
the intake engine can release payment, without the intake engine ever seeing the
(Seal-sealed) result. Request/response — intake asks, the validator answers.

- `POST /validate { job_id }` (header `x-quadra-internal: {INTAKE_INTERNAL_TOKEN}`,
  constant-time compared): **decrypts** the sealed result with the scheduler's Seal
  key, looks up the job's eval engine by `template.evaluator_id`, and has the
  **evaluation engine** validate the input (`POST {url}/validate` — category,
  timeliness, output schema; no oracle, no scoring).
- Answers `{ valid: true }` (intake releases + schedules scoring) or
  `{ valid: false, reason }` (final rejection — intake's 30-min deadline refunds).
  Transient trouble (no result indexed yet, key servers, engine down) is a 502 so
  intake/the agent can retry.
- Read + HTTP only (no Walrus writes), so it doesn't disturb the scheduler's stream.

The validator decrypts with a **dedicated** `SCHEDULER_SECRET_KEY` (kept separate
from the data layer's master `DATA_SECRET_KEY`). Its address must be the one
registered via `job_access::set_scheduler`, or the key servers won't approve its
decryption.

## Run

```bash
cd ../data && npm run build      # scheduler imports the quadra-data dist
cd ../scheduler && npm install
npm start                        # Express on SCHEDULER_PORT (default 4000)
```

Config comes from `../data/.env` (shared with the data layer); plus `SCHEDULER_PORT`,
`SCHEDULER_POLL_MS`, `INTAKE_INTERNAL_TOKEN` (**required**, must match intake),
`SCHEDULER_SECRET_KEY` (**required** — the dedicated Seal-reader key), the gateway
(`DATA_GATEWAY_URL`, `ROLE_TOKEN_SCHEDULER`). Ensure eval engines are registered in
the Walrus catalog (`POINTER_EVAL_ENGINES`). Keep `/validate` on a private network.

Endpoints: `GET /health`, `GET /status` (in-memory jobs + fired log + refresh
counters + validator status), `GET /fired`.

## Test

```bash
npm run e2e            # watch/poll detection: 3 schedules, asserts each fired
npm run test:eval      # unit: signature verify (valid/tampered/wrong-key), error
                       #       classification, payload shape (no network)
npm run test:eval-e2e  # FULL live #onExpired (needs ../data/.env; Walrus-slow)
```

`test:eval-e2e` proves the whole evaluation path against live testnet: it spawns
the real data gateway plus a mock Nautilus enclave that returns a **real
ed25519-signed score**, stores a Seal'd result, schedules it expired, and asserts
the engine decrypts it, calls the engine, **verifies the signature**, records the
score through the gateway, and removes the job. It injects the enclave key via the
`fetchEnclavePk` test hook, so the signature-verification path runs without a
deployed enclave. (`e2e` leaves stale jobs behind; `test:eval-e2e` clears expired
ones first so it stays isolated.)
