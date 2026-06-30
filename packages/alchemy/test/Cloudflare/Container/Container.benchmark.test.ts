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

// Cold-start under modest concurrency, measured in batches. Each batch boots
// CONCURRENCY fresh containers AT ONCE (distinct DO names → distinct
// containers), waits for all to become reachable, then stops all of them before
// the next batch. Running BATCHES batches of distinct keys (CONCURRENCY ×
// BATCHES total cold starts) reveals both the under-load cold start (within a
// batch) and the trend across batches (warm image/edge), while never holding
// more than CONCURRENCY containers at once. Mirrors the MicroVM benchmark.
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 10);
const BATCHES = Number(process.env.BENCH_BATCHES ?? 10);
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
  /** 1-based batch index this sample belongs to. */
  readonly batch: number;
  /** Wall-clock latency of the boot request, measured by the client (outside). */
  readonly outside: number;
  /** Inside the DO: container start → reachable (available service). */
  readonly readyMs: number | undefined;
}

interface VariantResult {
  readonly label: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly failures: ReadonlyArray<string>;
}

// Boot ONE fresh container and time the cold start from the outside. `/boot`
// returns the inside-measured `{ bootMs, readyMs }` (container start →
// reachable). Does NOT shut down — the batch stops all of its instances
// together afterwards, so CONCURRENCY containers are alive at once.
const bootOne = (
  baseUrl: string,
  variant: string,
  batch: number,
  name: string,
) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const q = `variant=${variant}&name=${encodeURIComponent(name)}`;
    const start = yield* Effect.sync(() => Date.now());
    const result = yield* client.get(`${baseUrl}/boot?${q}`).pipe(
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

    if (!result.ok)
      return { sample: undefined, failure: `${name}: ${result.error}` };
    if (result.status !== 200) {
      return {
        sample: undefined,
        failure: `${name}: HTTP ${result.status} ${result.body.slice(0, 160)}`,
      };
    }
    const readyMs = (() => {
      try {
        return (JSON.parse(result.body) as { readyMs?: number }).readyMs;
      } catch {
        return undefined;
      }
    })();
    return { sample: { batch, outside, readyMs }, failure: undefined };
  });

// Stop one container (best-effort, untimed) so the next batch is a fresh cold
// start and we never hold more than CONCURRENCY containers at once.
const shutdownOne = (baseUrl: string, variant: string, name: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const q = `variant=${variant}&name=${encodeURIComponent(name)}`;
    yield* client
      .get(`${baseUrl}/shutdown?${q}`)
      .pipe(Effect.timeout("60 seconds"), Effect.ignore);
  });

const runVariant = (
  baseUrl: string,
  variant: string,
  label: string,
  nonce: string,
) =>
  Effect.gen(function* () {
    // Untimed warm-up: the FIRST pull of a freshly-pushed image (and its shared
    // base, e.g. oven/bun:latest) onto a cold edge metal costs tens of seconds
    // — a one-time DEPLOY artifact charged to whichever variant boots first, NOT
    // a per-cold-start cost. Boot+shutdown once here so the image is distributed
    // before timing, isolating container cold start from image distribution.
    const warm = `${nonce}-${variant}-warm`;
    yield* bootOne(baseUrl, variant, 0, warm);
    yield* shutdownOne(baseUrl, variant, warm);

    const outcomes: Array<{
      sample: Sample | undefined;
      failure: string | undefined;
    }> = [];
    // BATCHES batches of CONCURRENCY concurrent cold starts. Within a batch the
    // boots race (placement under load); batch-over-batch shows the trend. Each
    // batch is fully stopped before the next so at most CONCURRENCY containers
    // are alive at once.
    for (let b = 1; b <= BATCHES; b++) {
      const names = Array.from(
        { length: CONCURRENCY },
        (_, i) => `${nonce}-${variant}-b${b}-${i}`,
      );
      const batch = yield* Effect.forEach(
        names,
        (name) => bootOne(baseUrl, variant, b, name),
        { concurrency: CONCURRENCY },
      );
      outcomes.push(...batch);
      yield* Effect.forEach(
        names,
        (name) => shutdownOne(baseUrl, variant, name),
        { concurrency: CONCURRENCY },
      );
    }
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

const sN = (n: number) => `${(n / 1000).toFixed(1)}s`;

const formatVariant = (r: VariantResult) => {
  const total = CONCURRENCY * BATCHES;
  const ready = stats(
    r.samples
      .map((s) => s.readyMs)
      .filter((m): m is number => typeof m === "number"),
  );
  const outside = stats(r.samples.map((s) => s.outside));
  // Per-batch mean readyMs — the headline: does the under-load cold start
  // shrink batch-over-batch as the image/edge warms?
  const byBatch: string[] = [];
  for (let b = 1; b <= BATCHES; b++) {
    const xs = r.samples
      .filter((s) => s.batch === b)
      .map((s) => s.readyMs)
      .filter((m): m is number => typeof m === "number");
    byBatch.push(xs.length > 0 ? sN(stats(xs).mean) : "—");
  }
  return [
    `── ${r.label} ──`,
    `  ok: ${r.samples.length}/${total}   failed: ${r.failures.length}   (${CONCURRENCY} concurrent × ${BATCHES} batches)`,
    `  readyMs by batch (mean): ${byBatch.join("  ")}`,
    `  readyMs (start→reachable): min ${sN(ready.min)}  p50 ${sN(ready.p50)}  p95 ${sN(ready.p95)}  max ${sN(ready.max)}  mean ${sN(ready.mean)}`,
    `  outside (client):          min ${sN(outside.min)}  p50 ${sN(outside.p50)}  p95 ${sN(outside.p95)}  max ${sN(outside.max)}  mean ${sN(outside.mean)}`,
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
    `cold-start: ${CONCURRENCY} concurrent × ${BATCHES} batches per variant`,
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* waitForWorker(url);

      const nonce = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));

      const variants = [
        { variant: "effectful", label: "effectful (bundled Effect image)" },
        {
          variant: "bun",
          label: "non-effectful (oven/bun:latest, no Effect bundle)",
        },
        { variant: "remote", label: "non-effectful (remote echo image)" },
      ];

      const blocks: string[] = [];
      let totalSamples = 0;
      for (const v of variants) {
        const r = yield* runVariant(url, v.variant, v.label, nonce);
        totalSamples += r.samples.length;
        blocks.push(formatVariant(r));
      }

      const report = [
        "",
        `Container cold-start benchmark (${CONCURRENCY} concurrent × ${BATCHES} batches = ${CONCURRENCY * BATCHES} cold starts per variant; image pre-warmed to the metal so we measure container cold start, not first-pull distribution)`,
        ...blocks,
        "",
      ].join("\n");
      // `console.log` (not `Effect.logInfo`) so the report always reaches the
      // terminal — vitest buffers the structured logger for passing tests.
      yield* Effect.sync(() => console.log(report));

      // The benchmark is informational, but a run where nothing started at all
      // indicates a broken deploy rather than slow containers.
      expect(totalSamples).toBeGreaterThan(0);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );

  // Number of crash-loop attempts to time. Small — this measures latency-to-
  // fail, not throughput.
  const CRASH_N = Number(process.env.BENCH_CRASH_N ?? 10);

  test(
    "surfaces a fatal crash fast instead of burning the readiness budget",
    Effect.gen(function* () {
      const { url } = yield* stack;
      yield* waitForWorker(url);

      const nonce = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
      const client = freshConn(yield* HttpClient.HttpClient);

      const results = yield* Effect.forEach(
        Array.from({ length: CRASH_N }, (_, i) => `crash-${nonce}-${i}`),
        (name) =>
          Effect.gen(function* () {
            const start = yield* Effect.sync(() => Date.now());
            const res = yield* client
              .get(`${url}/crashloop?name=${encodeURIComponent(name)}`)
              .pipe(Effect.timeout(REQUEST_TIMEOUT));
            const body = yield* res.text;
            const outside = (yield* Effect.sync(() => Date.now())) - start;
            const parsed = JSON.parse(body) as { ms: number; ok: boolean };
            return { outside, inside: parsed.ms, ok: parsed.ok };
          }),
        { concurrency: CRASH_N },
      );

      const insideStats = stats(results.map((r) => r.inside));
      const outsideStats = stats(results.map((r) => r.outside));
      const sec = (n: number) => `${(n / 1000).toFixed(1)}s`;
      const failedFast = results.filter((r) => !r.ok).length;

      yield* Effect.sync(() =>
        console.log(
          [
            "",
            `Container crash-loop fail-fast (N=${CRASH_N})`,
            `── fatal crash (container exits immediately) ──`,
            `  detected-as-failed: ${failedFast}/${CRASH_N}`,
            `  time-to-fail inside (DO):`,
            `    min ${sec(insideStats.min)}  p50 ${sec(insideStats.p50)}  p95 ${sec(insideStats.p95)}  max ${sec(insideStats.max)}  mean ${sec(insideStats.mean)}`,
            `  time-to-fail outside (client):`,
            `    min ${sec(outsideStats.min)}  p50 ${sec(outsideStats.p50)}  p95 ${sec(outsideStats.p95)}  max ${sec(outsideStats.max)}  mean ${sec(outsideStats.mean)}`,
            "",
          ].join("\n"),
        ),
      );

      // Every attempt must be detected as failed — the container crash-loops.
      expect(failedFast).toBe(CRASH_N);
      // And it must fail FAST: before the fix this retried the crash for the
      // full readiness budget (tens of seconds → minutes); aligned with native
      // it surfaces in ~one poll past the platform's allocation time. Bound well
      // under the per-request ceiling to catch a regression to budget-burning.
      expect(insideStats.p95).toBeLessThan(60_000);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
