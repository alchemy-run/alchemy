# Cloudflare CPU benchmark harness

Deploy these fixtures through Alchemy to compare a baseline and candidate source
revision. Bun, pnpm, Python 3.9+, a Cloudflare account with Workers enabled, and an
API token authorized to deploy the selected resources and read Workers
observability are required. Set `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` in the shell through your normal secret manager. Never put
credentials in a command argument or result file.

The collectors use only Python's standard library; Python 3.9 is the minimum
because the deep collectors use `str.removeprefix` and `str.removesuffix`.

## Prepare two source worktrees

Use the same harness commit on both revisions. The harness imports production
code from its own worktree; it never replaces production files with snapshots.
Set `BASELINE_REV`, `CANDIDATE_REV`, and `HARNESS_COMMIT` to the desired commits,
then run from the repository root:

```sh
export BASELINE_ROOT="$(pwd)/../alchemy-cpu-baseline"
export CANDIDATE_ROOT="$(pwd)/../alchemy-cpu-candidate"
export CPU_RUN_ROOT="$(mktemp -d)"
export CPU_STAGE="cpu-experiment"
git worktree add --detach "$BASELINE_ROOT" "$BASELINE_REV"
git worktree add --detach "$CANDIDATE_ROOT" "$CANDIDATE_REV"
mkdir -p "$CPU_RUN_ROOT/state" "$CPU_RUN_ROOT/results"
for tree in "$BASELINE_ROOT" "$CANDIDATE_ROOT"; do
  git -C "$tree" cherry-pick "$HARNESS_COMMIT"
  git -C "$tree" submodule update --init submodules/distilled
  (cd "$tree" && pnpm install --frozen-lockfile)
  mkdir -p "$tree/.alchemy"
  ln -s "$CPU_RUN_ROOT/state" "$tree/.alchemy/state"
done
```

If a revision already contains the harness commit, omit its cherry-pick. Use
fresh worktrees: the state symlink must not replace an existing state directory.
Keep the shared state and stage throughout the experiment so redeploys update
the same resources. Run deployments sequentially. Retain the chosen revisions,
harness commit, commands, and deploy output beside each uniquely named result.

## Deploy, load, and collect

Run from the baseline worktree first. The CLI takes the configuration file
**positionally**:

```sh
cd "$BASELINE_ROOT"
bun alchemy deploy benchmark/cloudflare-cpu/alchemy.run.ts --stage "$CPU_STAGE" --yes --no-input
```

Set `WORKER_NAME` and `WORKER_URL` from the returned `workerName` and `workerUrl`.
Create a new prefix and short non-UUID run ID for every cohort. UUID-shaped URL
values can be redacted by the provider and prevent telemetry correlation.

```sh
export PREFIX="$CPU_RUN_ROOT/results/baseline-core-r1"
bun benchmark/cloudflare-cpu/observe.ts --worker "$WORKER_NAME" --output-prefix "$PREFIX" -- \
  --url "$WORKER_URL" --variant baseline --revision "$BASELINE_REV" \
  --run-id baseline-core-r1 --endpoints noop,workflow-codec,rpc-records \
  --requests 100 --warmups 20 --concurrency 4 --ops 1000
python3 benchmark/cloudflare-cpu/collect-cpu.py "$PREFIX"
python3 benchmark/cloudflare-cpu/summarize.py "$PREFIX" > "$PREFIX-summary.json"
```

Deploy from `CANDIDATE_ROOT` with the same command, stage, and shared state. Use
the candidate revision, a fresh prefix such as `candidate-core-r1`, and identical
workload settings. Repeat interleaved baseline/candidate rounds when necessary.
Collectors never overwrite existing files; keep partial runs and use a fresh
prefix for another attempt.

| Main route                  | Work inside the Worker                                           |
| --------------------------- | ---------------------------------------------------------------- |
| `noop`, `effect-ops`        | HTTP adaptation, or named Effect primitive operations            |
| `workflow-codec`            | Production workflow result encoding and decoding                 |
| `rpc-shape`                 | RPC value-wrapper diagnostic; no remote RPC                      |
| `rpc-records`, `rpc-binary` | Production structured or binary RPC codecs                       |
| `ai-image`, `ai-tools`      | Production AI adapter with a validating in-memory inference sink |
| `queue-packing`             | Production queue batch packing without queue I/O                 |

Choose counts suited to the route. For example, use `--ops 128` for binary
chunks, `--ops 5` for images, `--ops 100` for tools, or `--ops 500 --concurrency 1`
for queue packing. Every load driver validates responses and retains failed
samples without retrying them. `--help` lists its bounds.

`observe.ts` saves deployment/version metadata and raw matching tail events.
`collect-cpu.py` queries stored invocation telemetry with bounded pagination and
retries. Its coverage requires every expected invocation, finite CPU, and the
same version as the stable before/after manifest. Wrong or missing versions
invalidate the cohort; conflicting duplicate versions remain diagnostic data.
`summarize.py` independently revalidates records, including older collector
files, and emits no CPU statistics for invalid or incomplete cohorts. Both exit
nonzero when the cohort fails validation. Missing data is never filled from
client latency. The strict optional `summarize-complete-tail.py PREFIX` requires
one exact CF-Ray match for every measured request before using live-tail CPU.

CPU is provider-reported execution time. Client latency includes network and
body reading; provider wall time is a third measurement. Keep them separate.
Configured 100% logging does not guarantee complete telemetry. Preserve coverage
and correctness alongside any statistics. Raw tail files may contain request
metadata; inspect and redact them before sharing. Put reviewed, unique result
artifacts under `results/` only when intentionally publishing an experiment.

## Other fixtures

Each configuration below deploys a separate stack with local state. Use the
same baseline/candidate procedure, and take identities from its deploy output.

| Configuration           | Load driver / collector                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `dispatch.run.ts`       | `observe.ts --load-script dispatch-load`; then `collect-cpu.py` and `collect-do-cpu.py`  |
| `r2.run.ts`             | `observe.ts --load-script r2-load`; then `collect-cpu.py`                                |
| `deep/alchemy.run.ts`   | `observe.ts --load-script deep/load`; then `collect-cpu.py` and `deep/collect-remote.py` |
| `deep/websocket.run.ts` | `deep/websocket-load.ts`; then `deep/collect-websocket.py`                               |

Prefix configuration paths with `benchmark/cloudflare-cpu/`. For dispatch,
select the plain or traced Worker and keep tracing fixed across comparisons.
`rpc-shape` here makes one real DO call; `--ops 0` selects its no-op method.
Retrieve `actorId` from `curl --fail "$WORKER_URL/do-identity"`, then collect:

```sh
python3 benchmark/cloudflare-cpu/collect-do-cpu.py "$PREFIX" --actor-id "$ACTOR_ID"
```

Keep frontend Worker CPU and receiving DO CPU separate. DO and deep collectors
join invocation identities rather than estimating receiving CPU from latency.
For deep Worker RPC, supply the matching backend name from deploy output:

```sh
python3 benchmark/cloudflare-cpu/deep/collect-remote.py "$PREFIX" \
  --endpoint deep/rpc-worker-20 --remote-worker "$BACKEND_WORKER_NAME"
```

For deep DO, SQL, or scheduling endpoints, the receiving Worker defaults to the
frontend. Match `--endpoint` to the one measured route. Scheduling requires
concurrency 1 and `--ops 100` or `1000`; setup traffic has its own excluded marker.

R2 uses a test bucket with destructive cleanup enabled. Use `--count 1`, `16`,
or `64` MiB, `--concurrency 1`, and `--endpoints r2-copy-effect` or
`r2-copy-native`. Add `--seed` on the first run at each size. Preserve objects
across variants; source and copy verification are excluded from measured CPU.

WebSocket load uses a new actor per trial and records synthetic protocol frames:

```sh
bun benchmark/cloudflare-cpu/deep/websocket-load.ts --url "$WORKER_URL" \
  --variant baseline --revision "$BASELINE_REV" --run-id baseline-ws-r1 \
  --ops 1000 --trials 3 --metadata-bytes 1024 --output "$PREFIX-latency.json"
python3 benchmark/cloudflare-cpu/deep/collect-websocket.py "$PREFIX-latency.json" \
  --worker "$WORKER_NAME" --namespace-id "$NAMESPACE_ID"
```

WebSocket totals remain provisional unless the native message/close event model
is verified. Structured log markers do not count as invocations. Do not assume
a close-event count to force complete coverage.

Use separate prefixes and traffic for `observe.ts --profile`; profiling changes
execution overhead and must not be included in comparison timing. Supply the
deployed Worker ID with `--profile-worker-id`; DO profiles also need the exact
namespace and actor IDs. Retain source maps and raw profiles with their version.

## Offline checks and cleanup

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s benchmark/cloudflare-cpu/tests -v
bun alchemy destroy benchmark/cloudflare-cpu/alchemy.run.ts --stage "$CPU_STAGE" --yes --no-input
```

Destroy each other configuration you deployed with the same positional path and
its exact stage. Run cleanup from a worktree still linked to the shared state,
verify those experimental resources are absent, and retain results before
removing worktrees or the temporary directory. R2 destruction removes the test
objects and bucket. No deployment or cloud cleanup runs during offline tests.
