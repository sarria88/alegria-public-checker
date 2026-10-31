# Optional independent free Cron dispatcher

This monitoring-only Worker is a proposal, disabled by default. It does not deploy the application, change DNS/routes or touch production services. The proposed GitHub workflow changes are two backward-compatible expressions on top of source revision `24ace86`: the monitor-job guard `(github.event_name != 'schedule' || vars.CHECKER_CLOCK != 'external')`, and a separate inert concurrency group for skipped native schedule events when the external clock is selected. That group prevents a skipped native event from replacing a pending external product dispatch. Existing active product and provider-test groups remain unchanged. The native Cron definition stays intact and remains active when this variable is absent. Keep it active until this external clock has been deployed, observed and validated.

## Scope and actual guarantees

Cloudflare Cron invokes the Worker nominally every five minutes in UTC. It sends one fixed HTTPS POST to the existing public checker's `workflow_dispatch` endpoint, with main, operation cycle and bootstrap false. It never calls production endpoints or sends a production heartbeat. GitHub executes the existing HTTP/browser checker and sends its own completion heartbeat after finishing.

Only scheduled events can dispatch. Every HTTP request returns 404; `workers.dev`, preview URLs and routes are disabled in the configuration. No TLS validation is weakened. Redirects are rejected. The external request is aborted after ten seconds. Errors are fixed labels; tokens, headers, responses and bodies are never logged. No retry can hide a failed dispatch.

An accepted GitHub dispatch is not proof that a cycle started, finished or passed. GitHub runners can still queue or lose timeliness, and provider outages remain possible. Cron changes can take up to fifteen minutes to propagate. Observe actual completed cycle timestamps; this helper alone does not establish the required PASS every five minutes or the 24-hour acceptance window.

## Free plan and authorization prerequisites

Before deployment, verify the selected account remains on **Workers Free**, that its shared quota has headroom, and that creating this monitoring-only Worker uses an available Cron slot. Do not upgrade, enable a paid plan or attach storage, queues, databases or custom domains. Published Workers Free limits are 100,000 requests/day and 10 ms CPU per invocation. At five-minute cadence this helper expects 288 invocations/day; waiting for network I/O is separate from CPU time. Expected incremental charge is zero within the verified Free limits. Runtime CPU/quota behavior still needs a hosted observation; an exceeded free limit must stop work rather than motivate a paid upgrade.

Authentication and persistent credential creation are user steps. Create a fine-grained GitHub PAT owned by the intended account, restricted to **only the public checker repository**, with **Actions: write** and no additional Contents, Secrets or other repository permissions (GitHub may include mandatory metadata read). Set a short deliberate expiry and retain the expiry date securely. Enter the PAT directly as the Cloudflare Worker secret `GITHUB_DISPATCH_TOKEN`; never paste it into chat, source, URLs or command arguments. `GITHUB_TOKEN_EXPIRES_AT` is the matching UTC ISO expiry timestamp. The Worker refuses an expired or missing timestamp. Rotate before expiry with the same narrow permission scope, then verify dispatch again.

Deployment requires actual Cloudflare login/account access and confirmation of the selected Free account within the user's authorized external-monitoring scope. This proposal performs no account changes or deployment. No Cloudflare or GitHub token is included here.

## Setup and validation

1. Publish only this directory's allowlisted source through a separate reviewed change; do not import application history or evidence.
2. In the chosen Free account, create the monitoring Worker with the module code and configuration. Configure the secret and expiry through the provider's secret controls. Leave `ENABLED=false` initially.
3. Confirm there are no HTTP routes, custom domains or production DNS changes. Configure Cron `*/5 * * * *`; allow for documented propagation.
4. Set `ENABLED=true` only after configuration, Free quota and secret scope are verified. Use a provider-supported scheduled-event test, then observe real Cron event success and the corresponding GitHub run. The HTTP endpoint must remain 404 and cannot be used as a trigger.
5. Verify the existing checker completes and its independently hosted Better Stack completion heartbeat is refreshed. Compare real cycle start/finish times across several intervals. Keep all state, encrypted evidence and product alert policy in the existing checker unchanged.
6. Only after a real Cloudflare-triggered cycle completes successfully, set the existing checker's repository variable `CHECKER_CLOCK=external` to skip native schedule jobs while retaining manual and external workflow dispatches. Do not set it during proposal publication or before validation. The native Cron definition is not removed. Reverting or removing this variable restores native schedule admission without changing production checker state.
7. Prove scheduler/credential failure with a controlled pause and the independent completion monitor under an approved test window; never fake completion pings from this Worker. Retain the recorded limitations of native heartbeat recovery and its evaluation cadence.

Pause by setting `ENABLED=false` and verify later Cron events dispatch nothing. Cron removal is optional and can take time to propagate. Resume with the same reviewed code, unexpired narrow token and `ENABLED=true`; do not reset production checker state or bootstrap. The independent Better Stack watcher is outside both this Worker and GitHub's scheduler; it detects absent completed cycles, including failures of either service. No separate future automation or automatic closure of acceptance issues is created.

To revoke access, first pause with `ENABLED=false`. Revoke this specific fine-grained dispatcher token in GitHub's personal access token settings, then remove the Worker secret (or replace it with a newly authorized token) and clear/update its matching expiry. Verify subsequent Cron events create no GitHub dispatches. Preserve all production checker state and evidence; credential revocation never requires a fresh bootstrap. Rotate only this dispatch credential, without broadening its repository or permission scope.

Keep overlap with GitHub's native schedule bounded to the validation window. If both clocks begin working, they can double cycle/artifact frequency; workflow concurrency serializes runs but does not deduplicate triggers. Sustained dual-clock operation exceeds the existing five-minute storage envelope and must not be assumed safe within its reservation. The reviewed `CHECKER_CLOCK` guard allows a configuration-only choice of one active clock after external validation. Do not set it prematurely or remove the existing GitHub schedule before validation.

## Offline tests

Run `node --test cloudflare-dispatcher/tests/worker.test.mjs` from the repository root. Tests use fake requests only and require no dependencies or credentials. They cover the disabled default, exact target/body, redirect rejection, expiry, sanitized failures, ten-second abort and always-404 HTTP behavior. They do not attest deployment, live provider permissions, 10 ms CPU use or actual cadence.

## Primary references

- [Cloudflare Cron Triggers and propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers Free pricing and limits](https://developers.cloudflare.com/workers/platform/pricing/)
- [CPU accounting and Cron runtime limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Worker secret bindings](https://developers.cloudflare.com/workers/configuration/secrets/)
- [GitHub dispatch endpoint and Actions-write permission](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
