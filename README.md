# Portable external public checker

Standalone HTTP and browser monitor. This repository contains checker code, automation and fictitious loopback tests only. It contains no application source, database access, private history, live evidence or credential values. Publishing the code does not activate monitoring.

## Provenance

The portable checker source was extracted from authorized source revision `398c544226c21182245284dbdf262bc3b3adf58e`. Its original tests subtree is `4bebe78d9725df7650344e5d22c3a02d38caf4be`. `SOURCE-PROVENANCE.json` records original Git blob identities. The provider adapter and automation are separate additions. The original private documentation and repository history were deliberately excluded. No application is built or deployed by this repository.

## Local verification

Requires Node >=22.13. Run `npm ci` inside `checker`, then `npx playwright install chromium`. `node --test checker/tests/*.test.mjs automation/tests/*.test.mjs` runs fake-loopback tests, including real browser fixtures. Tests do not prove live DNS/TLS, delivered alerts or a working hosted schedule.

## Activation prerequisites

Create a new public repository from this allowlisted directory without importing another repository's Git history. Use a standard `ubuntu-latest` hosted runner. Do not configure a larger runner or change another repository's visibility. Protect main and restrict who can change workflows or secrets. The job remains inert unless both repository variables `PUBLIC_CHECKER_ENABLED=true` and `CHECKER_STORAGE_VERIFIED=true` are set.

Add these values through the repository's secret controls; never put them in source, chat, command arguments or public logs:

- `CHECKER_ARTIFACT_KEY`: one cryptographically random 32-byte key encoded as base64. Store an operator recovery copy securely; losing or rotating this key without decrypting/re-encrypting retained state blocks recovery.
- `BETTER_STACK_API_TOKEN`: team-scoped Incidents API credential.
- `BETTER_STACK_COMPLETION_HEARTBEAT_URL`: regenerated completion heartbeat secret URL.
- `BETTER_STACK_REQUESTER_EMAIL`: API requester identity; the actual alert recipient is the primary on-call responder configured in Better Stack.
- `PUBLIC_CHECKER_MANIFEST_JSON`: the independently reviewed frontend byte manifest as JSON (strictly less than 48 KiB). Never generate confidence solely from current live bytes.
- `EXPECTED_API_RELEASE`, `EXPECTED_FRONTEND_RELEASE`: reviewed full source revision IDs.
- `CHECKER_ACA_APP_URL`, `CHECKER_ACA_REVISION_URL`: exact observed authorities from reviewed deployment evidence. Never guess these or use broader host allowlists.

The operator must create and authorize persistent credentials and verify email alert, recovery and dead-man reception. This repository creates none. Do not use a personal computer as the permanent execution host.

For first initialization only: Actions → External public checker → Run workflow → main → select `bootstrap=true`. Subsequent runs leave bootstrap false. Existing state is always restored even if bootstrap is selected; no state reset overrides an open incident. Missing, corrupt, expired, wrong-key or inconsistent monitor/provider state stops execution for operator reconciliation.

## Actual behavior and limits

The nominal cron is at minutes 2,7,12,…,57 each hour. GitHub schedules can be delayed or dropped, and pending jobs can be coalesced; this does not guarantee one completed PASS every five minutes. A real observation period must measure completion gaps. The checker cycle timeout is 120 seconds; notification delivery has bounded time outside the cycle. A 150-second wrapper stops a stuck process without fabricating a completion heartbeat. GitHub concurrency and the checker lock prevent overlap.

Product incidents retain the portable state policy: two consecutive FAIL/INCOMPLETE cycles open one incident; two PASS cycles recover; different checks may fail in successive cycles. Pending failed deliveries remain in persistent state. Better Stack completion heartbeat is sent after a cycle finishes, including FAIL. The independent provider expects five minutes plus seven minutes grace. Native heartbeat recovery on its next ping does **not** implement two completed cycles. Provider evaluation cadence and >12-minute silence behavior must be observed; an explicit `/fail` test alone does not prove elapsed-silence detection.

State persistence uses encrypted end-of-job artifacts. This is not transactional storage: catastrophic runner cancellation or upload failure can lose the newest state. Provider metadata reconciles retried alert creation but is not a globally exactly-once guarantee. Do not claim operational acceptance until this limitation is resolved or explicitly accepted through the governing specification.

Pause by setting `PUBLIC_CHECKER_ENABLED=false`; re-enable with the same state/key. Never delete state or invent fresh healthy state to hide an incident. Preserve independent direct monitors while investigating.

## Restricted evidence in a public repository

The checker stdout/stderr are redirected to temporary local files; public logs expose only bounded outcome and automation errors. State, JSON reports, logs and all screenshots are encrypted before upload using AES-256-GCM with a fresh random nonce, purpose-bound authenticated data and the repository secret key. Decryption fails on tampering, wrong key, purpose mismatch, unexpected file paths or archive size violations. No plaintext evidence artifact is uploaded. Artifact names, timestamps, sizes, workflow activity and aggregate status remain public metadata. A product PASS does not mean retention succeeded: packing or storage failures fail the whole workflow visibly and must be investigated.

Only `*.sealed` payloads are uploaded. State and per-cycle evidence request seven-day retention; bounded aggregate counters request thirty days. Screenshots are packed as lossless WebP: each conversion verifies exact decoded dimensions and every RGBA pixel against the original PNG. The encrypted per-cycle screenshot index records original path/PNG SHA256, pixel SHA256, WebP SHA256 and the encrypted image object's artifact name. Shared image objects request fourteen-day retention and are renewed when less than seven days plus one hour remains. The mapping preserves every screenshot's association with its cycle; the image encoding changes while all pixels remain exact. Original PNG byte encoding is not reconstructed from WebP, and its recorded SHA256 describes the original bytes.

The bounded encrypted image ledger reserves storage for at most 100 retained object generations, each at most 512 KiB. Planned ledger state is uploaded before any new image object, so an unsuccessful state upload cannot create unaccounted new image uploads. Repeated screenshots reuse an existing object only after checking its actual unexpired artifact in the same main branch. Image lookup, conversion, encryption or missing historical object failures are operational failures. No screenshot is omitted to hide a cap failure. Catastrophic cancellation can still lose recent incident state; artifact persistence is not transactional.

These settings are an implementation request, not proof of available historical evidence. Verify actual retention, key custody and decryption before acceptance. A downloaded sealed file can be decrypted in an approved private environment with `node automation/sealed-artifacts.mjs unseal INPUT OUTPUT state` (or `evidence` / `metrics` / `image`) and `CHECKER_ARTIFACT_KEY` supplied securely through environment. WebP image objects retain their dimensions and pixel hash for verification.

## Free storage feasibility

Standard hosted compute in public repositories is free, while artifact storage has an account-wide allowance shared with Packages. Verify the current plan, remaining storage, and an enforced zero-spend budget before setting `CHECKER_STORAGE_VERIFIED`. Do not upgrade or authorize overage by default.

Hard encrypted payload caps are 16 KiB state, 512 KiB per shared image object and 4 KiB aggregate metrics per run. The complete per-cycle JSON evidence cap is the explicitly verified `CHECKER_EVIDENCE_LIMIT_BYTES` repository variable, with no implicit default. Set `CHECKER_RESERVED_STORAGE_BYTES` only after verifying that amount of unused included account storage is reserved for this monitor. A preflight requires the worst-case 2,016 seven-day state/evidence payloads plus 8,640 thirty-day metric payloads, 100 retained image object generations and a 50 MiB ZIP/service buffer to fit that reservation. A 32 KiB JSON evidence cap requires about 228.25 MiB reserved, plus separate headroom for extra manual runs and other account usage. Every encryption and upload is gated by a successful budget preflight. If a cap or the image generation count is exceeded, the complete payload is refused and the workflow fails visibly; evidence is never truncated or silently omitted. The state upload can still succeed so the incident is not reset. Such a failure blocks seven-day evidence acceptance.

Prior screenshot samples ranged from approximately 73–484 kB each, with mean about 189 kB. Lossless WebP reduced their total by about 29% while every decoded pixel matched; many screenshots were identical and can share stored objects. Without deduplication, the observed WebP average would still project more than 500 MiB over seven days before reports/state. This design relies on bounded shared image objects rather than weakening screenshot assertions. Rare large images, frequent changes, many manual runs or growth in other account storage can exhaust the reservation or the shared quota. Keep the existing account hard zero-spend block; over-quota execution/storage must stop rather than incur charges. Quota exhaustion can stop the checker and is detected by its independent heartbeat. Actual seven-day/30-day availability still needs verification. No thirty-day diagnostics/IP log store is supplied here; metrics contain only outcome, duration and status counts.

## Official references

- [GitHub schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [GitHub hosted compute and artifact storage billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Better Stack completion heartbeat and explicit failure](https://betterstack.com/docs/uptime/cron-and-heartbeat-monitor/)
- [Better Stack incident creation](https://betterstack.com/docs/uptime/api/create-a-new-incident/)
- [Better Stack incident resolution](https://betterstack.com/docs/uptime/api/resolve-an-ongoing-incident/)

