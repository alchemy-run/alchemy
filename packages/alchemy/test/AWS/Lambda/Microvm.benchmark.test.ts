import * as AWS from "@/AWS";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BenchmarkStack from "./fixtures/benchmark/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
  state: Alchemy.localState(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Building the effectful image (Firecracker snapshot, server-side) and
// deploying the orchestrator Lambda comfortably exceeds the default hook budget.
const HOOK_TIMEOUT = 1_500_000;
const TEST_TIMEOUT = 1_200_000;

// MicroVM is a preview feature: gated, account must be onboarded, image builds
// are asynchronous (minutes).
const skip = !process.env.LAMBDA_TEST_MICROVM;

// Number of MicroVMs to boot, and how many concurrently. MicroVM has a per-
// account *memory* quota (each instance reserves its `minimumMemoryInMiB`), so
// the defaults are deliberately small — unlike the Cloudflare Container
// benchmark's N=100. Raise BENCH_N / BENCH_CONCURRENCY on an account with a
// larger quota.
const N = Number(process.env.BENCH_N ?? 5);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? N);
// Each /boot launches a MicroVM and blocks until it is reachable, then
// terminates it; allow a long per-request ceiling for cold starts.
const REQUEST_TIMEOUT = "180 seconds";

// Force `Connection: close` so each request opens a fresh connection rather
// than pinning to one Lambda URL edge over a pooled keep-alive socket.
const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

// Wait for the freshly-deployed Lambda URL to answer 200 before benchmarking.
const waitForOrchestrator = (url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status === 200
          ? Effect.succeed(r)
          : Effect.fail(new Error(`orchestrator not ready: ${r.status}`)),
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
  /** Wall-clock latency of the whole request, measured by the client. */
  readonly outside: number;
  /** Latency reported from inside the Lambda (run → MicroVM reachable). */
  readonly inside: number | undefined;
}

interface VariantResult {
  readonly label: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly failures: ReadonlyArray<string>;
}

// Fire one boot request and time the full outside round-trip. A 200 carries
// `{ ms }` (the inside-Lambda measurement); anything else is recorded as a
// failure rather than throwing, so one bad boot doesn't sink the whole run.
const boot = (baseUrl: string, name: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const start = yield* Effect.sync(() => Date.now());
    const result = yield* client
      .get(`${baseUrl}/boot?name=${encodeURIComponent(name)}`)
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

const runVariant = (baseUrl: string, label: string, nonce: string) =>
  Effect.gen(function* () {
    const outcomes = yield* Effect.forEach(
      Array.from({ length: N }, (_, i) => `${nonce}-${i}`),
      (name) => boot(baseUrl, name),
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
    `  inside (RunMicrovm → reachable):`,
    `    min ${ms(inside.min)}  p50 ${ms(inside.p50)}  p90 ${ms(inside.p90)}  p95 ${ms(inside.p95)}  p99 ${ms(inside.p99)}  max ${ms(inside.max)}  mean ${ms(inside.mean)}`,
    ...(r.failures.length > 0
      ? [`  failures:`, ...r.failures.slice(0, 5).map((f) => `    - ${f}`)]
      : []),
  ].join("\n");
};

/**
 * MicroVM cold-start benchmark: launch N MicroVM instances from the effectful
 * {@link Sandbox} image and time how long each takes to run and become
 * reachable. The report mirrors the Cloudflare Container cold-start benchmark
 * (`Container.benchmark.test.ts`) so the two can be compared side by side.
 *
 * Set NO_DESTROY=1 to keep the deploy between runs while iterating, and
 * BENCH_N / BENCH_CONCURRENCY to scale the load (mind the MicroVM memory quota).
 */
describe.skipIf(skip)("microvm cold-start benchmark", () => {
  const stack = beforeAll(deploy(BenchmarkStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(BenchmarkStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    `boots ${N} MicroVMs and reports startup latency`,
    Effect.gen(function* () {
      const { url } = yield* stack;
      const baseUrl = url.replace(/\/+$/, "");
      yield* waitForOrchestrator(baseUrl);

      const nonce = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));
      const result = yield* runVariant(
        baseUrl,
        "microvm (effectful image)",
        `vm-${nonce}`,
      );

      const report = [
        "",
        `MicroVM cold-start benchmark (N=${N}, concurrency=${CONCURRENCY})`,
        formatVariant(result),
        "",
      ].join("\n");
      // `console.log` (not `Effect.logInfo`) so the report always reaches the
      // terminal — vitest buffers the structured logger for passing tests.
      yield* Effect.sync(() => console.log(report));

      // Informational, but a run where nothing started indicates a broken
      // deploy rather than slow MicroVMs.
      expect(result.samples.length).toBeGreaterThan(0);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
