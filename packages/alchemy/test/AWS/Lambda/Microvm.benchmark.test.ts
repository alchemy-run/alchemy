import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import BenchmarkStack from "./fixtures/benchmark/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Cloudflare.providers()),
  state: Alchemy.localState(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Building the effectful image (Firecracker snapshot, server-side) and
// deploying the orchestrator Lambda comfortably exceeds the default hook budget.
const HOOK_TIMEOUT = 1_500_000;
const TEST_TIMEOUT = 1_800_000;

// MicroVM is a preview feature: gated, account must be onboarded, image builds
// are asynchronous (minutes).
const skip = !process.env.LAMBDA_TEST_MICROVM;

// How many boot→shutdown cycles to run per variant. Each cycle boots ONE fresh
// MicroVM (distinct key), times its cold start, then shuts it down — run
// sequentially so the per-iteration series reveals how cold start trends as the
// same image is booted and torn down repeatedly. Sequential also keeps only one
// MicroVM alive at a time, respecting the per-account memory quota.
const ITER = Number(process.env.BENCH_ITER ?? 10);
// `/boot` blocks until the MicroVM is reachable; allow a long cold-start ceiling.
const REQUEST_TIMEOUT = "180 seconds";

// Force `Connection: close` so each request opens a fresh connection rather
// than pinning to one Lambda URL edge over a pooled keep-alive socket.
const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

// Wait for the freshly-deployed host URL to answer 200 before benchmarking.
const waitForHost = (url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    yield* client.get(url).pipe(
      Effect.flatMap((r) =>
        r.status === 200
          ? Effect.succeed(r)
          : Effect.fail(new Error(`host not ready: ${r.status}`)),
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
  /** 1-based iteration index (order the cycle ran in). */
  readonly iter: number;
  /** Wall-clock latency of the boot request, measured by the client (outside). */
  readonly outside: number;
  /** Inside: RunMicrovm → RUNNING (provisioned). */
  readonly bootMs: number;
  /** Inside: RunMicrovm → in-VM service answers (available). */
  readonly readyMs: number;
}

interface VariantResult {
  readonly label: string;
  readonly samples: ReadonlyArray<Sample>;
  readonly failures: ReadonlyArray<string>;
}

// One boot→shutdown cycle, timed from the outside. `/boot` returns the
// inside-measured `{ id, bootMs, readyMs }`; `/shutdown` tears the MicroVM down
// (best-effort, not timed) so the next cycle is an independent cold start.
const cycle = (baseUrl: string, variant: string, iter: number, key: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    const q = `variant=${variant}&key=${encodeURIComponent(key)}`;
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
      return { sample: undefined, failure: `${key}: ${result.error}` };
    if (result.status !== 200) {
      return {
        sample: undefined,
        failure: `${key}: HTTP ${result.status} ${result.body.slice(0, 160)}`,
      };
    }
    const parsed = JSON.parse(result.body) as {
      id: string;
      bootMs: number;
      readyMs: number;
    };
    // Tear it down (best-effort) so the next cycle is a fresh cold start.
    yield* client
      .get(`${baseUrl}/shutdown?variant=${variant}&id=${parsed.id}`)
      .pipe(Effect.timeout("60 seconds"), Effect.ignore);
    return {
      sample: {
        iter,
        outside,
        bootMs: parsed.bootMs,
        readyMs: parsed.readyMs,
      },
      failure: undefined,
    };
  });

const runVariant = (
  baseUrl: string,
  variant: string,
  label: string,
  nonce: string,
) =>
  Effect.gen(function* () {
    const outcomes: Array<{
      sample: Sample | undefined;
      failure: string | undefined;
    }> = [];
    // Sequential: we want the trend over time, and only one MicroVM alive.
    for (let i = 1; i <= ITER; i++) {
      outcomes.push(
        yield* cycle(baseUrl, variant, i, `${nonce}-${variant}-${i}`),
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
  if (xs.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p95: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: pct(50),
    p95: pct(95),
  };
};

const s = (n: number) => `${(n / 1000).toFixed(1)}s`;

const formatVariant = (r: VariantResult) => {
  const ordered = [...r.samples].sort((a, b) => a.iter - b.iter);
  const boot = stats(r.samples.map((x) => x.bootMs));
  const ready = stats(r.samples.map((x) => x.readyMs));
  const outside = stats(r.samples.map((x) => x.outside));
  return [
    `── ${r.label} ──`,
    `  ok: ${r.samples.length}/${ITER}   failed: ${r.failures.length}`,
    // The per-iteration series is the headline: does cold start shrink as we
    // boot/shutdown the same image repeatedly?
    `  readyMs by iteration: ${ordered.map((x) => s(x.readyMs)).join("  ")}`,
    `  bootMs  (run→RUNNING):   min ${s(boot.min)}  p50 ${s(boot.p50)}  p95 ${s(boot.p95)}  max ${s(boot.max)}  mean ${s(boot.mean)}`,
    `  readyMs (run→reachable): min ${s(ready.min)}  p50 ${s(ready.p50)}  p95 ${s(ready.p95)}  max ${s(ready.max)}  mean ${s(ready.mean)}`,
    `  outside (client):        min ${s(outside.min)}  p50 ${s(outside.p50)}  p95 ${s(outside.p95)}  max ${s(outside.max)}  mean ${s(outside.mean)}`,
    ...(r.failures.length > 0
      ? [`  failures:`, ...r.failures.slice(0, 5).map((f) => `    - ${f}`)]
      : []),
  ].join("\n");
};

/**
 * MicroVM cold-start benchmark. For each variant, run {@link ITER} boot→shutdown
 * cycles sequentially — each boots ONE fresh MicroVM (distinct key) from the
 * same image, times the cold start from the OUTSIDE (driving `/boot` then
 * `/shutdown`), and tears it down. The report shows cold start split into
 * `bootMs` (RunMicrovm → RUNNING) and `readyMs` (RunMicrovm → in-VM service
 * answers), plus the per-iteration series so the warm-up trend is visible.
 *
 * Driven from BOTH a Lambda host and a Cloudflare Worker host (cross-cloud
 * assume-role). Mirrors the Cloudflare Container benchmark so the two compare.
 *
 * Run WITHOUT NO_DESTROY so iteration 1 reflects a fresh deploy. Set BENCH_ITER
 * to change the cycle count.
 */
describe.skipIf(skip)("microvm cold-start benchmark", () => {
  const stack = beforeAll(deploy(BenchmarkStack), { timeout: HOOK_TIMEOUT });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(BenchmarkStack), {
    timeout: HOOK_TIMEOUT,
  });

  test(
    `boot→shutdown ${ITER}× per variant from Lambda and Worker hosts`,
    Effect.gen(function* () {
      const { url, workerUrl } = yield* stack;
      const lambdaUrl = url.replace(/\/+$/, "");
      const cfUrl = workerUrl.replace(/\/+$/, "");
      yield* waitForHost(lambdaUrl);
      yield* waitForHost(cfUrl);

      const nonce = yield* Effect.sync(() => crypto.randomUUID().slice(0, 8));

      const variants = [
        {
          base: lambdaUrl,
          variant: "effectful",
          label: "Lambda → MicroVM (effectful image)",
        },
        {
          base: lambdaUrl,
          variant: "external",
          label: "Lambda → MicroVM (external Dockerfile)",
        },
        {
          base: cfUrl,
          variant: "effectful",
          label: "Worker → MicroVM (effectful image)",
        },
        {
          base: cfUrl,
          variant: "external",
          label: "Worker → MicroVM (external Dockerfile)",
        },
      ];

      const blocks: string[] = [];
      let totalSamples = 0;
      for (const v of variants) {
        const r = yield* runVariant(v.base, v.variant, v.label, `${nonce}`);
        totalSamples += r.samples.length;
        blocks.push(formatVariant(r));
      }

      const report = [
        "",
        `MicroVM cold-start benchmark (boot→shutdown ×${ITER} per variant)`,
        ...blocks,
        "",
      ].join("\n");
      // `console.log` (not `Effect.logInfo`) so the report always reaches the
      // terminal — vitest buffers the structured logger for passing tests.
      yield* Effect.sync(() => console.log(report));

      // Informational, but a run where nothing started indicates a broken
      // deploy rather than slow MicroVMs.
      expect(totalSamples).toBeGreaterThan(0);
    }).pipe(logLevel),
    { timeout: TEST_TIMEOUT },
  );
});
