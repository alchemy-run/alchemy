# Neon Functions execute old code after a completed deployment

Observed on 2026-09-18 in `aws-us-east-2`, runtime `nodejs24` (reported Node `24.16.0`). This reproduces the shared update failure beneath all 13 `Neon.Website` constructors without a website framework, Alchemy Function provider, Effect runtime bridge, or Distilled deployment upload.

## Result

Deploy native handler A, then native handler B to the same function slug using official `neonctl@2.45.0`. Both deployments complete successfully. The management API reports `current_deployment.id = active_deployment.id = 2`, status `completed`, and an unchanged invocation URL. Fresh GET and POST requests continue executing A's code and environment.

Each response echoes a unique request nonce and exposes a module-initialization UUID and request counter. The same UUIDs seen before the update continue serving new nonces with advancing counters afterward. This is old code executing new requests, not replay of a cached HTTP response.

The initial three disposable-project experiments produced:

| Deployment path | Previously invoked function, 16 post-update responses | Function not invoked by the probe before update, 16 responses |
| --- | --- | --- |
| Direct SDK, deterministic ZIP timestamps | 16 A / 0 B | 8 A / 8 B |
| Direct SDK, current ZIP timestamps | 16 A / 0 B | 9 A / 7 B |
| Official CLI, CLI-owned bundling and upload | 16 A / 0 B | 7 A / 9 B |

“Not invoked” describes the probe, not a guarantee that Neon has created no execution context internally. Each run submitted full source deployments A → B with no intermediate config-only deployment. The code literal and `PROBE_VERSION` environment variable changed together. All post-update responses echoed the expected nonce and method with HTTP 200. Sampling covered eight rounds separated by five seconds; this measures the failure within that window, not an indefinite failure or a maximum rollout delay.

All three projects were destroyed through ordinary tracked project deletion, followed by independent typed `NotFound` checks. No production resources were changed.

## Official CLI evidence

Project: `morning-king-38511533`. Branch: `br-floral-silence-b5qa86au`.

| Function | Deployment 1 created (UTC) | Deployment 2 created (UTC) | Post-update sampling (UTC) |
| --- | --- | --- | --- |
| `probewarm` | 08:53:18.856329 | 08:53:25.680265 | 08:53:31–08:54:07 |
| `probecold` | 08:53:22.467489 | 08:53:28.858215 | 08:53:31–08:54:07 |

The warmed URL was `https://br-floral-silence-b5qa86au-probewarm.compute.c-7.us-east-2.aws.neon.tech/`. Its A instance `c416c65d-b895-4ff4-ab99-cc3943aa072f` served warmup counters 1–2 and post-update counters 3–13. Instance `c10308bd-d184-4a01-97bb-4b4a1f868025` served warmup counter 1 and post-update counters 2–6. Both retained `artifact-a` / `environment-a`.

The other function served both `artifact-a` / `environment-a` and `artifact-b` / `environment-b`. A previously unseen A module UUID appeared in the final round. Module boot timestamps are diagnostic observations, not proof of the underlying VM's creation time or a synchronized clock across instances.

The CLI returned exit 0 and deployment 2 `completed` for both updates. Independent management GETs confirmed deployment 2 active both before sampling and after all eight rounds. Final cleanup confirmed project `morning-king-38511533` absent. Selected structured observations are preserved in [function-update-evidence.json](./function-update-evidence.json).

## Skeptical follow-up: current CLI and fresh connections

The original CLI was pinned to 2.45.0. npm listed 5.0.0 as current, published on 2026-09-18 at 01:08:50 UTC. Two additional disposable-project controls used **5.0.0**:

| Control | Previously invoked function | Previously uninvoked function |
| --- | --- | --- |
| Same probe, current CLI | 16 A / 0 B | 8 A / 8 B |
| Current CLI, 30 seconds without invocation traffic after readiness, fresh curl process for every request | 16 A / 0 B | 9 A / 7 B |

The final control used HTTP/1.1, `Connection: close`, `--noproxy '*'`, fresh request nonces, and separate curl processes for warmup and every GET/POST. Thus Bun fetch connection reuse and a configured curl HTTP proxy are not necessary to reproduce the failure. This is still one client network vantage point; IP-based affinity or server-side routing caches are not excluded.

For the final control, project `dry-wind-02772059`, branch `br-bitter-rice-b4plgolw`, both deployments were confirmed active/completed at **09:14:14.763 UTC**. The probe then sent no invocation requests for 30 seconds. Fresh-connection sampling continued through **09:15:22.487 UTC**, approximately 68 seconds after that readiness observation, and still returned A. Final management GETs explicitly recorded `current = active = 2`, `completed` for both functions. Both follow-up projects were normally destroyed and independently confirmed absent. See [follow-up structured evidence](./function-update-followup-evidence.json).

An independent skeptical audit found no wrong-file, wrong-branch, missing-await, or missing-activation error. The final control also parses the CLI's returned deployment ID and URL and compares them with management state instead of relying only on log inspection. The exact published 5.0.0 implementation bundles the supplied file, submits ZIP/runtime/environment, and polls the newer current deployment; it adds no separate activation operation.

These controls establish stale execution after reported readiness even with new connections and a 30-second idle interval. They **do not establish that updates never converge**, that all accounts or regions are affected, or that a longer rollout/drain window cannot explain the observation. The idle interval tests a hypothesis; it is not an acceptance delay or a workaround. The precise serving-side cause and the intended exclusive-cutover guarantee require Neon-side confirmation.

## Five-minute idle control: passed

At the user's request, a separate bounded run left both functions without invocation traffic for **300 seconds** after confirming deployment 2 active/completed. It then sampled eight rounds of GET/POST requests through fresh proxy-bypassing curl processes. **All 32 responses executed B's code and environment**: 16/16 on the previously invoked function and 16/16 on the previously uninvoked function.

- Project: `lingering-river-33900504`; branch: `br-soft-mode-b4ysyb8f`; CLI: `neonctl@5.0.0`.
- Readiness observed: **2026-09-18 18:01:17.520 UTC**.
- Sampling: **18:06:17.968–18:06:55.065 UTC**, approximately 300–338 seconds after readiness.
- Both final management reads recorded `current = active = 2`, `completed`.
- Normal destruction completed; independent project lookup confirmed absence.

A preceding same-day 30-second-idle rerun still failed (16 A / 0 B on the warmed function; 5 A / 11 B on the other). The five-minute result is evidence that deployment state can converge after an idle interval, not evidence of permanent inability to update. It does not identify the exact convergence time, distinguish elapsed-time propagation from idle-instance retirement, establish behavior under continuous traffic, or guarantee five minutes is always sufficient. The projects were separate; this does not measure one deployment's transition from stale to fresh. No production delay or weakened stable-URL assertion was added, and the full Website matrix was not rerun.

## Continuous polling: observed cutover near two minutes

A follow-up using `neonctl@5.0.0` sent requests immediately after management readiness, with no idle wait. Each round used four fresh curl processes: GET and POST for both previously invoked and previously uninvoked functions, with approximately two seconds between rounds.

- **140 of 308 requests (45.5%)** still executed the old code/environment after deployment was active/completed.
- The last old response arrived approximately **113 seconds** after readiness for the previously invoked function and **110 seconds** for the previously uninvoked function.
- The previously uninvoked function returned **46 old responses after its first new response**. One current response is therefore insufficient evidence of completed rollout.
- The final **120 responses (100%)**, spanning approximately 68 seconds, all executed the new code/environment.

Project: `blue-waterfall-07906044`; branch: `br-jolly-darkness-b5lld7i1`; region: `aws-us-east-2`; runtime: `nodejs24`. Readiness was observed at `2026-09-18T20:51:37.040Z` and `2026-09-18T20:51:40.308Z` respectively. Raw timestamps are retained in [the structured cutover evidence](./function-cutover-evidence.json). This measures convergence in one continuously sampled rollout, not a universal maximum delay or the internal cause.

Deployment tests now poll the stable invocation URL until repeated samples consistently execute the requested version, then make their strict code/environment assertions. They retain active-deployment, stable-identity, no-op, and independent cleanup checks; no five-minute sleep is used.

## Minimal official-CLI reproduction

Use an owned disposable project in `aws-us-east-2`, its default branch, an authorized `NEON_API_KEY` in the environment, and two unused alphanumeric slugs. Never run this against existing application functions. This is a manual reproduction of the completed automated experiment, not an alternative passing acceptance test.

Save as `index.mjs`:

```js
const version = "artifact-a";
const instance = crypto.randomUUID();
const boot = Date.now();
let requests = 0;

export default {
  fetch(request) {
    return Response.json(
      {
        version,
        instance,
        boot,
        requests: ++requests,
        now: Date.now(),
        nonce: request.headers.get("x-probe-nonce"),
        method: request.method,
        environment: process.env.PROBE_VERSION,
        node: process.versions.node,
        pid: process.pid,
      },
      { headers: { "cache-control": "no-store", "x-probe-version": version } },
    );
  },
};
```

Set `PROJECT_ID` and `BRANCH_ID` to the disposable project's actual identifiers. Deploy A:

```sh
NEON_FUNCTIONS_POLL_TIMEOUT_MS=45000 timeout 60 pnpm dlx neonctl@2.45.0 functions deploy probewarm \
  --project-id "$PROJECT_ID" --branch "$BRANCH_ID" --src ./index.mjs \
  --env PROBE_VERSION=environment-a --output json --no-analytics
```

Record the returned `invocation_url` as `WARM_URL`. Invoke it four times with distinct nonces, including concurrent requests, and retain the bodies:

```sh
curl --fail-with-body --max-time 10 -H 'x-probe-nonce: warmup-1' "$WARM_URL"
```

Deploy the same source as `probecold` using the same command with that slug, and record `COLD_URL`, without invoking it. Change only the source literal `"artifact-a"` to `"artifact-b"`. Deploy the new file to both unchanged slugs with `--env PROBE_VERSION=environment-b`. Require exit 0 and `status: "completed"`; verify both returned URLs are unchanged.

Independently GET `/api/v2/projects/{project_id}/branches/{branch_id}/functions/{slug}` on `https://console.neon.tech` using management authentication. Require both `current_deployment.id` and `active_deployment.id` equal the deployment ID returned by the update, and active status `completed`.

Send one GET and one POST to each unchanged URL concurrently per round, eight rounds five seconds apart. Use a new nonce for every request:

```sh
curl --fail-with-body --max-time 10 -X POST \
  -H 'cache-control: no-cache' -H 'x-probe-nonce: after-update-warm-0-POST' \
  "$WARM_URL"
```

Assert nonce and method match the request. Expected code/environment are always `artifact-b` / `environment-b`; observed bodies also include A. Retain UUIDs/counters to distinguish stale execution from response replay. Re-read management state after sampling. Delete the disposable project through its owning stack or ordinary project deletion, and verify the project is absent before evaluating the final version assertions.

## What this establishes

- A website framework is unnecessary to reproduce the failure. All Website constructors deploy through the same Function service.
- Neither Alchemy's deterministic ZIP timestamp nor Distilled's multipart upload is necessary: the official CLI controls bundling and upload in the final experiment.
- A config-only update is unnecessary. Both generations contain full source uploads.
- HTTP response cache replay does not explain fresh nonce echoes and advancing counters from pre-update module UUIDs.
- Management acceptance does not establish that the stable URL exclusively executes the active generation.

The exact Neon internal cause remains unconfirmed. Routing to obsolete contexts, incomplete instance retirement, or stale deployment selection within the serving infrastructure require Neon-side inspection. There is no evidence here establishing which internal component is responsible, or how long eventual convergence takes. No reliable client-side workaround is verified.

The public deployment contract says a completed deployment is live and accepting requests. The audited official CLI deploy path uses the same deployment endpoint and exposes no additional publish/activate operation. Runtime documentation describes long-lived isolates but does not specify an update-drain guarantee that would justify weakening the stable-URL assertions.

References:

- [Deploy Functions](https://neon.com/docs/compute/functions/deploy)
- [Runtime and limits](https://neon.com/docs/compute/functions/reference/runtime-limits)
- [Published CLI 2.45.0 deploy implementation](https://unpkg.com/neon@2.45.0/dist/commands/functions.js)
- [Published CLI 5.0.0 deploy implementation](https://unpkg.com/neon@5.0.0/dist/commands/functions.js)

The existing Function and Website regressions remain failing and unchanged. Do not accept one B response as convergence, silently recreate the function to change its URL, or add an arbitrary delay and call the update fixed. Platform investigation should correlate the project/branch/deployment IDs above with the serving instances and routing decisions.
