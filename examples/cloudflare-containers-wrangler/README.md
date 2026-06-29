# cloudflare-containers-wrangler

A control benchmark that spins up N Cloudflare Container instances using **only**
Cloudflare's official tooling — `wrangler` + [`@cloudflare/containers`](https://developers.cloudflare.com/containers/) —
with zero Alchemy code. Used to determine whether the container cold-start
slowness observed in the Alchemy benchmark
(`packages/alchemy/test/Cloudflare/Container/Container.benchmark.test.ts`) is
attributable to Alchemy or to the Cloudflare Containers platform itself.

The image (`oven/bun:latest` + a one-line `Bun.serve`) is identical to the
Alchemy "bun-baseline" variant, so the numbers are directly comparable.

## How it works

- `src/index.ts` — a Worker + `BenchContainer` (a `@cloudflare/containers`
  `Container`). `GET /start?name=X` resolves a distinct container instance per
  name and `fetch`es it; the first fetch blocks through cold start, so the
  measured time is start → reachable.
- `bench.ts` — a standalone runner that fires N distinct names against the
  deployed worker (bounded concurrency), then prints the same
  min/p50/p90/p95/p99/max/mean breakdown as the Alchemy benchmark.

## Run it

```sh
# from this directory
bun install
wrangler login            # or set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
bun run deploy            # wrangler deploy — prints the workers.dev URL

# benchmark (defaults: N=2, concurrency=N)
WORKER_URL=https://alchemy-bench-containers-wrangler.<subdomain>.workers.dev bun run bench

# push it harder
BENCH_N=100 BENCH_CONCURRENCY=10 WORKER_URL=... bun run bench

# tear down
bun run destroy
```

Env knobs for `bench.ts`: `WORKER_URL` (required), `BENCH_N`,
`BENCH_CONCURRENCY`, `BENCH_REQUEST_TIMEOUT_MS`.
