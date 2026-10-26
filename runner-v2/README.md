# Durable Radar controller — integration not yet operational

This controller repairs queue identity, recovery and completion semantics. It is **not** a replacement implementation of the research engine. It is not enabled by the current `npm start`, and no paid resources are created by this change.

The existing `server.js` remains a discovery prototype. Its completion reporting is corrected separately: discovery always has a partial outcome, and health explicitly says `ready: false` for full scans.

## Implemented and tested locally

- SQLite WAL with full synchronous commits on a persistent filesystem.
- One run per Istanbul calendar day and source lane, with original ledger identity retained.
- Atomic batch submission, lease-based recovery, one active run, stale-worker rejection.
- Kariyer, LinkedIn, other legal sources, AI order for queued batches. A blocked predecessor blocks later lanes.
- Timed commands without shell interpolation; graceful interruption; five attempts with exponential delay, then explicit operator recovery of the same ID.
- Existing coverage/evidence validators and tests run before the publication adapter.
- Completion requires a matching ledger hash and confirmed live deployment receipt for the existing dashboard.
- Authenticated submission/status/retry API. No bearer token belongs in browser code.
- No notification sender; no per-retry notification spam.

Run `node --test runner-v2/test.mjs` with Node 24. The killed-process test proves queue recovery across SIGKILL. Pipeline tests use mocked adapters and do **not** prove a real research run or production publication.

## Remaining activation requirements

1. Supply a durable Render disk and a service that stays running, or implement an external durable store. The current free service cannot satisfy this configuration. No plan upgrade is included or authorized by this patch.
2. Store the actual private Radar repository on that disk. Its canonical `dist/registry.json`, immutable IDs, source plans, completed user decisions and evidence must be retained. Do not copy these private records into this public GitHub repository.
3. Implement and authorize an executable scan adapter for the full source plan. The current ChatGPT-driven protocol is not a shell command. The legacy six-query SerpAPI function does not qualify. Search/review API credentials and any Gmail read access need independent server-side configuration; ChatGPT connector access is not automatically inherited by Render.
4. Implement the production publication adapter with secure repository/publisher credentials. It must upsert, run all gates, reconcile an earlier deployment on retry, and confirm the exact published commit.
5. Connect the existing scheduler to authenticated batch submissions; do not create duplicate schedules. Synchronize terminal user decisions before research; fail if authoritative state is unavailable. No dashboard button or schedule is rewired by this change.
6. Live-test interrupt/resume, duplicate submissions, exclusion of Applied/Hidden IDs and company/role matches, all source packages and a real publication. Only then enable the dashboard button.

## Configuration contract

Node 24; start command `node runner-v2/server.mjs`.

- `RENDER_DISK_MOUNT_PATH`: actual attached persistent disk mount.
- `RADAR_STORE_DIR`: existing directory inside the disk for `queue.sqlite`.
- `RADAR_REPO_DIR`: actual full Radar checkout inside the disk.
- `RADAR_RUNNER_TOKEN`: strong secret of at least 32 characters, securely configured.
- `RADAR_SCAN_COMMAND_JSON`: trusted executable argument array, for example `["node","scripts/real-scan.mjs"]` **only after that real adapter exists**.
- `RADAR_PUBLISH_COMMAND_JSON`: trusted executable argument array for the publication adapter.

Missing configuration yields `/health` with `ready:false`. `/runs` returns 503 without enqueuing. The controller never falls back to the six-query prototype.

POST `/runs` with an authorized server-side bearer token and body:

```json
{"runs":[
  {"day":"2026-10-26","lane":"kariyer","ledgerId":"kariyer-20261026"},
  {"day":"2026-10-26","lane":"linkedin","ledgerId":"linkedin-20261026"},
  {"day":"2026-10-26","lane":"ai","ledgerId":"ai-20261026"}
]}
```

Adapters receive `RADAR_LEDGER_ID`, `RADAR_LANE`, `RADAR_DAY`, `RADAR_ATTEMPT`, `RADAR_RESUME=true`. They must resume checkpointed work and retain the original ledger. Publication also receives `RADAR_LEDGER_HASH`.

Scan adapter obligations: load SCAN_PROTOCOL/scan-plan/completed-workflow before any external request; skip terminal IDs and company-role equivalents; execute every lane query independently; save raw search/direct-source evidence; review full text and all admission filters; use upsert; checkpoint before and after each bounded operation. Do not invent evidence or classify access failure as closure. These are integration requirements, not functionality implemented by this controller.

Publication writes `runs/publications/LEDGER_ID.json` containing `ledgerId`, `lane`, `ledgerHash`, `status:"published"`, `commitSha`, `deploymentId`, `projectId:"appgprj_6aa6887b4f608191b6ff5e91a1d6a03c"`, and `deploymentEvidencePath`. That saved evidence JSON must match project, deployment and commit with `status:"live"`, derived from the publication provider response. Local assertions are not proof of provider success.

GET `/runs/ID` returns status. POST `/runs/ID/retry` authorizes another bounded recovery cycle after the underlying blocker is fixed. It never changes ledger identity or reopens completed user decisions. A restart automatically recovers expired claims after the five-minute lease; leases heartbeat while commands execute.

## Operational limits

SQLite supports this single persistent-disk instance design, not distributed workers across separate disks. The disk-backed repository is shared mutable state and must have one publisher/worker. External side effects require adapter idempotency even with leases. This controller validates evidence structure; it cannot establish the truth of research claims made by a faulty adapter. Neither arbitrary retries nor paid hosting alone supplies the missing research engine.
