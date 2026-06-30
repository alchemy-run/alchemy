import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BenchmarkStack from "./fixtures/benchmark/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Building + pushing the effectful image, pulling the remote image, and
// deploying the worker/DOs comfortably exceeds the default hook budget.
const HOOK_TIMEOUT = 600_000;
// The benchmark spins up N containers per variant across three variants run
// serially; each cold start can take well over a minute, so give the whole
// run a very wide ceiling.
const TEST_TIMEOUT = 2_400_000;

// Number of container instances to spin up per variant, and how many to start
// concurrently. Override with BENCH_N / BENCH_CONCURRENCY when probing limits.
const N = Number(process.env.BENCH_N ?? 100);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? N);
// Each named DO instance boots its own container; the route blocks until the
// container is reachable (up to the start layer's ~3min cap), so allow a long
// per-request ceiling.
const REQUEST_TIMEOUT = "240 seconds";

const DEPLOY_PLACEHOLDER = "Alchemy worker is being deployed...";

// Force `Connection: close` so each request opens a fresh connection rather
// than pinning to one edge metal over a pooled keep-alive socket.
const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

// Wait for the freshly-deployed worker's base route to answer 200 with "ok"
// (i.e. not the pre-create deploy stub) before starting the benchmark.
const waitForWorker = (url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status !== 200
          ? Effect.fail(new Error(`worker not ready: ${r.status}`))
          : Effect.flatMap(r.text, (body) =>
              body.includes(DEPLOY_PLACEHOLDER) || !body.includes("ok")
                ? Effect.fail(new Error(`not ready: ${body}`))
                : Effect.succeed(body),
            ),
      ),
      Effect.timeout("30 seconds"),
      Effect.retry({
        schedule: Schedule.exponential("500 millis").pipe(
          Schedule.either(Schedule.spaced("3 seconds")),
        ),
        times: 30,
      }),
    );
  });

interface Sample {
  /** Wall-clock latency of the whole request, measured outside (the client). */
  readonly outside: number;
  /** Latency reported from inside the DO (container start → reachable). */
  readonly inside: number | undefined;
}

interface VariantResult {
  readonly label: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly failures: ReadonlyArray<string>;
}

// Fire one boot request and time the full outside round-trip. A 200 carries
// `{ ms }` (the inside-DO measurement); anything else is recorded as a failure
// rather than throwing, so one bad instance doesn't sink the whole run.
const boot = (baseUrl: string, path: string, name: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const start = yield* Effect.sync(() => Date.now());
    const result = yield* client
      .get(`${baseUrl}${path}?name=${encodeURIComponent(name)}`)
      .pipe(
        Effect.flatMap((r) =>
          Effect.map(r.text, (body) => ({ status: r.status, body })),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.map((res) => ({ ok: true as const, ...res })),
        Effect.catch((err) =>
          Effect.succeed({ ok: false as const, error: String(err) }),
        ),
      );
    const outside = (yield* Effect.sync(() => Date.now())) - start;

    if (!result.ok) {
      return { sample: undefined, failure: `${name}: ${result.error}` };
    }
    if (result.status !== 200) {
      return {
        sample: undefined,
        failure: `${name}: HTTP ${result.status} ${result.body.slice(0, 200)}`,
      };
    }
    const inside = (() => {
      try {
        return (JSON.parse(result.body) as { ms?: number }).ms;
      } catch {
        return undefined;
      }
    })();
    return { sample: { outside, inside }, failure: undefined };
  });

const runVariant = (
  baseUrl: string,
  path: string,
  label: string,
  nonce: string,
) =>
  Effect.gen(function* () {
    const outcomes = yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => `${nonce}-${i}`),
      (name) => boot(baseUrl, path, name),
      { concurrency: CONCURRENCY },
    );
    const samples = outcomes
      .map((o) => o.sample)
      .filter((s): s is Sample => s !== undefined);
    const failures = outcomes
      .map((o) => o.failure)
      .filter((f): f is string => f !== undefined);
    return { label, samples, failures } satisfies VariantResult;
  });

const stats = (xs: ReadonlyArray<number>) => {
  if (xs.length === 0) {
    return { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: pct(50),
    p90: pct(90),
    p95: pct(95),
    p99: pct(99),
  };
};

const formatVariant = (r: VariantResult) => {
  const outside = stats(r.samples.map((s) => s.outside));
  const inside = stats(
    r.samples
      .map((s) => s.inside)
      .filter((m): m is number => typeof m === "number"),
  );
  const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;
  return [
    `── ${r.label} ──`,
    `  ok: ${r.samples.length}/${N}   failed: ${r.failures.length}`,
    `  outside (client round-trip):`,
    `    min ${ms(outside.min)}  p50 ${ms(outside.p50)}  p90 ${ms(outside.p90)}  p95 ${ms(outside.p95)}  p99 ${ms(outside.p99)}  max ${ms(outside.max)}  mean ${ms(outside.mean)}`,
    `  inside (DO start→reachable):`,
    `    min ${ms(inside.min)}  p50 ${ms(inside.p50)}  p90 ${ms(inside.p90)}  p95 ${ms(inside.p95)}  p99 ${ms(inside.p99)}  max ${ms(inside.max)}  mean ${ms(inside.mean)}`,
    ...(r.failures.length > 0
      ? [`  failures:`, ...r.failures.slice(0, 5).map((f) => `    - ${f}`)]
      : []),
  ].join("\n");
};

/**
 * Cold-start benchmark: spin up N container instances per variant (each a
 * distinct DO → distinct container) and time how long each takes to start and
 * become reachable, comparing an Effect-native (bundled) container against a
 * non-Effect (remote pre-built image) container.
 *
 * Set NO_DESTROY=1 to keep the deploy between runs while iterating.
 */
describe("container cold-start benchmark", () => {
  const stack = beforeAll(deploy(BenchmarkStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(BenchmarkStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    `spins up ${N} instances per variant and compares startup latency`,
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* waitForWorker(url);

      const nonce = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));

      // Run the two variants sequentially so they don't contend for the same
      // pool of concurrent container starts (which would muddy the comparison).
      const effectful = yield* runVariant(
        url,
        "/effectful",
        "effectful (bundled Effect image)",
        `eff-${nonce}`,
      );
      const remote = yield* runVariant(
        url,
        "/remote",
        "non-effectful (remote echo image)",
        `rem-${nonce}`,
      );
      const bun = yield* runVariant(
        url,
        "/bun",
        "non-effectful (oven/bun:latest, no Effect bundle)",
        `bun-${nonce}`,
      );

      const report = [
        "",
        `Container cold-start benchmark (N=${N}, concurrency=${CONCURRENCY})`,
        formatVariant(effectful),
        formatVariant(bun),
        formatVariant(remote),
        "",
      ].join("\n");
      // `console.log` (not `Effect.logInfo`) so the report always reaches the
      // terminal — vitest buffers the structured logger for passing tests.
      yield* Effect.sync(() => console.log(report));

      // The benchmark is informational, but a run where nothing started at all
      // indicates a broken deploy rather than slow containers.
      expect(effectful.samples.length).toBeGreaterThan(0);
      expect(remote.samples.length).toBeGreaterThan(0);
      expect(bun.samples.length).toBeGreaterThan(0);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
