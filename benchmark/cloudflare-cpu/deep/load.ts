import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { scheduledExpected, scheduledNow } from "./scheduled-fixture.ts";

// Example: bun benchmark/cloudflare-cpu/deep/load.ts --url URL --variant baseline
// --revision SOURCE_REVISION --endpoints deep/rpc-worker-100 --ops 100
// --requests 100 --warmups 20 --concurrency 1 --output PREFIX-latency.json
// The deployed revision is explicit; this driver never resets source.
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  strict: true,
  options: {
    url: { type: "string" },
    variant: { type: "string" },
    revision: { type: "string" },
    output: { type: "string" },
    endpoints: { type: "string" },
    ops: { type: "string" },
    requests: { type: "string" },
    warmups: { type: "string" },
    concurrency: { type: "string" },
    "timeout-ms": { type: "string" },
    "run-id": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Deep deployed RPC/SQL/scheduled-event benchmark. Required: --url --variant --revision --output
--endpoints: comma-separated deep/noop, deep/rpc-worker[-1|-20|-100], deep/rpc-do[-1|-20|-100], deep/sql, deep/sql-noop, deep/scheduled
--ops: unary calls/request 1..1000; SQL writes or scheduled events 100 or 1000. Default20 for RPC,100 if SQL/scheduled selected.
--requests 100 (max500), --warmups 20 (max100), --concurrency 1 (max16), --timeout-ms 30000 (max60000).
--run-id: use a short non-UUID identifier for Cloudflare log correlation.
Every response is validated. Warmups are separate. No requests are retried.
Scheduled runs require concurrency1 and POST a separate preparation before every drain.
Preparations use an auxiliary run ID and are excluded from measured latency and CPU cohorts.`);
  process.exit(0);
}
const numeric = (value: string | undefined, fallback: number, min: number, max: number) => {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`Expected integer ${min}..${max}, got ${value}`);
  return n;
};
const rawUrl = values.url ?? process.env.BENCH_URL;
if (!rawUrl || !values.variant || !values.revision || !values.output)
  throw new Error("Required: --url --variant --revision --output");
const origin = new URL(rawUrl);
if (
  !["http:", "https:"].includes(origin.protocol) ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
) {
  throw new Error("URL must be an origin with no credentials, path, query or fragment");
}
const endpoints = (values.endpoints ?? "deep/rpc-worker,deep/rpc-do").split(",");
const endpointPattern =
  /^deep\/(noop|rpc-worker(?:-(?:1|20|100))?|rpc-do(?:-(?:1|20|100))?|sql|sql-noop|scheduled)$/;
if (
  new Set(endpoints).size !== endpoints.length ||
  endpoints.some((endpoint) => !endpointPattern.test(endpoint))
)
  throw new Error("Invalid/duplicate endpoint");
const scheduled = endpoints.includes("deep/scheduled");
const operations = numeric(
  values.ops,
  endpoints.includes("deep/sql") || scheduled ? 100 : 20,
  1,
  1000,
);
if ((endpoints.includes("deep/sql") || scheduled) && operations !== 100 && operations !== 1000)
  throw new Error("SQL/scheduled requires --ops 100 or 1000");
const requests = numeric(values.requests, 100, 1, 500);
const warmups = numeric(values.warmups, 20, 0, 100);
const concurrency = numeric(values.concurrency, 1, 1, 16);
if (scheduled && concurrency !== 1)
  throw new Error("Scheduled fixture uses one actor and requires --concurrency 1");
const timeoutMs = numeric(values["timeout-ms"], 30000, 1, 60000);
const runId = values["run-id"] ?? `deep-${Date.now()}`;
const output = resolve(values.output);
if (await Bun.file(output).exists()) throw new Error(`Refusing to overwrite ${output}`);
await mkdir(dirname(output), { recursive: true });
type Sample = {
  endpoint: string;
  phase: string;
  index: number;
  sequence: number;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  elapsedMs: number;
  status: number | null;
  body: string | null;
  ok: boolean;
  correct: boolean;
  cfRay: string | null;
  error: string | null;
};
const expectedCount = (endpoint: string) => (endpoint.endsWith("noop") ? 0 : operations);
const remoteVersions = new Map<string, Set<string>>();
let frontVersion: string | undefined;
let scheduledActor: string | undefined;
const preparations: Sample[] = [];
const request = async (endpoint: string, phase: string, index: number): Promise<Sample> => {
  const url = new URL(`/${endpoint}`, origin);
  url.searchParams.set("run", phase === "setup" ? `${runId}-setup` : runId);
  url.searchParams.set("phase", phase);
  if (endpoint !== "health") url.searchParams.set("count", String(expectedCount(endpoint)));
  const sample: Sample = {
    endpoint,
    phase,
    index,
    sequence: index,
    startedAt: new Date().toISOString(),
    endedAt: "",
    latencyMs: 0,
    elapsedMs: 0,
    status: null,
    body: null,
    ok: false,
    correct: false,
    cfRay: null,
    error: null,
  };
  const start = performance.now();
  try {
    const response = await fetch(url, {
      method: phase === "setup" ? "POST" : "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    sample.status = response.status;
    sample.cfRay = response.headers.get("cf-ray");
    sample.body = await response.text();
    sample.elapsedMs = sample.latencyMs = performance.now() - start;
    sample.endedAt = new Date().toISOString();
    const body = JSON.parse(sample.body);
    let valid = response.status === 200 && body.ok === true && typeof body.version?.id === "string";
    if (endpoint === "health") {
      valid &&= body.harness === "cloudflare-deep-v1";
      if (valid && phase === "before") frontVersion = body.version.id;
    } else {
      const count = expectedCount(endpoint);
      valid &&=
        body.endpoint === endpoint && body.count === count && body.version.id === frontVersion;
      if (endpoint.startsWith("deep/scheduled")) {
        valid &&=
          /^[0-9a-f]{64}$/.test(body.actorId) &&
          (scheduledActor === undefined || body.actorId === scheduledActor);
        if (phase === "setup") {
          valid &&=
            body.variant === "scheduled-prepare" &&
            body.prepared === true &&
            body.seeded === count &&
            body.now === scheduledNow &&
            body.nextAlarm === scheduledNow - count;
        } else {
          valid &&=
            body.variant === "native-rpc-public-scheduled-events" &&
            Object.entries(scheduledExpected(count)).every(([key, value]) => body[key] === value);
        }
        if (valid) scheduledActor = body.actorId;
      } else {
        valid &&= body.checksum === (count * (count + 1)) / 2;
      }
      if (endpoint.startsWith("deep/rpc-")) {
        const groupSize = Number(/-(1|20|100)$/.exec(endpoint)?.[1] ?? 20);
        valid &&=
          body.groupSize === groupSize &&
          body.rpcCalls === count &&
          typeof body.remoteVersion === "string" &&
          body.remoteVersion.length > 0;
        valid &&= endpoint.startsWith("deep/rpc-do")
          ? /^[0-9a-f]{64}$/.test(body.actorId)
          : body.actorId === "";
        if (valid) {
          const versions = remoteVersions.get(endpoint) ?? new Set<string>();
          versions.add(body.remoteVersion);
          remoteVersions.set(endpoint, versions);
        }
      } else if (endpoint.startsWith("deep/sql")) {
        valid &&= body.rows === count && /^[0-9a-f]{64}$/.test(body.actorId);
      }
    }
    sample.ok = sample.correct = valid;
    if (!valid) sample.error = "Response status/version/fixture mismatch";
  } catch (error) {
    sample.elapsedMs ||= performance.now() - start;
    sample.latencyMs = sample.elapsedMs;
    sample.endedAt ||= new Date().toISOString();
    sample.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return sample;
};
const stats = (samples: Sample[]) => {
  const v = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const p = (q: number) => v[Math.max(0, Math.ceil(v.length * q) - 1)] ?? null;
  return {
    count: v.length,
    minMs: v[0] ?? null,
    maxMs: v.at(-1) ?? null,
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    p99Ms: p(0.99),
    meanMs: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null,
  };
};
const batch = async (endpoint: string, phase: string, n: number) => {
  const samples: Sample[] = [];
  let next = 0;
  let preparationFailed = false;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(n, concurrency) }, async () => {
      while (next < n && !preparationFailed) {
        const index = next++;
        if (endpoint === "deep/scheduled") {
          const preparation = await request("deep/scheduled-prepare", "setup", preparations.length);
          preparations.push(preparation);
          if (!preparation.correct) {
            preparationFailed = true;
            break;
          }
        }
        samples[index] = await request(endpoint, phase, index);
      }
    }),
  );
  const wallElapsedMs = performance.now() - start;
  return {
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs:
      endpoint === "deep/scheduled"
        ? samples.reduce((sum, sample) => sum + sample.latencyMs, 0)
        : wallElapsedMs,
    wallElapsedMs,
    preparationFailed,
    samples,
  };
};
const startedAt = new Date().toISOString();
const before = await request("health", "before", 0);
const workloads = [];
if (before.correct)
  for (const endpoint of endpoints) {
    const warmup = await batch(endpoint, "warmup", warmups);
    const measured = await batch(endpoint, "measured", requests);
    const successes = measured.samples.filter((sample) => sample.correct);
    const summary = {
      attempted: measured.samples.length,
      successful: successes.length,
      failed: measured.samples.length - successes.length,
      requestsPerSecond: measured.samples.length / (measured.elapsedMs / 1000),
      latencyAll: stats(measured.samples),
      latencySuccessful: stats(successes),
    };
    workloads.push({ endpoint, warmup, measured, summary });
    console.log(JSON.stringify({ endpoint, ...summary }));
  }
const after = await request("health", "after", 0);
const versionBefore = before.correct ? JSON.parse(before.body!).version : null;
const versionAfter = after.correct ? JSON.parse(after.body!).version : null;
const versionStable = versionBefore !== null && versionBefore.id === versionAfter?.id;
const remoteVersionStable = [...remoteVersions.values()].every((versions) => versions.size === 1);
const allCorrect =
  before.correct &&
  after.correct &&
  versionStable &&
  remoteVersionStable &&
  workloads.every(
    (workload) =>
      workload.warmup.samples.length === warmups &&
      workload.measured.samples.length === requests &&
      workload.warmup.samples.every((sample) => sample.correct) &&
      workload.summary.failed === 0,
  ) &&
  preparations.every((sample) => sample.correct);
const actualWorkloadRequests = workloads.reduce(
  (sum, workload) => sum + workload.warmup.samples.length + workload.measured.samples.length,
  0,
);
await Bun.write(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      harness: "cloudflare-deep-v1",
      runId,
      url: origin.origin,
      variant: values.variant,
      revision: values.revision,
      startedAt,
      endedAt: new Date().toISOString(),
      versionBefore,
      versionAfter,
      versionStable,
      remoteVersionStable,
      remoteVersions: Object.fromEntries(
        [...remoteVersions].map(([endpoint, versions]) => [endpoint, [...versions]]),
      ),
      health: { before, after },
      configuration: { endpoints, operations, requests, warmups, concurrency, timeoutMs },
      workloads,
      preparations,
      preparationRunId: `${runId}-setup`,
      allCorrect,
      totalRequests: 2 + actualWorkloadRequests,
      totalActualRequests: 2 + actualWorkloadRequests + preparations.length,
      measuredRequests: workloads.reduce(
        (sum, workload) => sum + workload.measured.samples.length,
        0,
      ),
      notes:
        "Actual HTTP RPC/native DO SQL/scheduled events. Client latency includes the measured remote calls; collect receiving Worker/DO CPU separately. Scheduled preparation requests have a separate run ID and are excluded from the measured cohort; scheduled elapsedMs sums c1 drain latency while wallElapsedMs includes preparation. Clock override is only the scheduler input, never CPU measurement. No retries; SQL transactionSync contains only synchronous public SQL Effects.",
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ output, allCorrect, versionStable, remoteVersionStable }));
if (!allCorrect) process.exitCode = 1;
