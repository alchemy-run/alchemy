import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

/**
 * Primary cohort (run separately for native control and candidate):
 * bun benchmark/cloudflare-cpu/r2-load.ts --url URL --variant baseline --revision REV --seed --count 16 --endpoints r2-copy-effect --output PREFIX-latency.json
 * Defaults: one request at a time, 10 warmups, 30 measured copies, 30s deadline.
 * --seed writes only the selected fixed source key; omit on subsequent runs.
 */
const fixtures = {
  1: {
    bytes: 1048576,
    checksum: 133693440,
    sha256: "e91db7585175e26eed3527e57a3cbd55a8832e64f7021ab1c64c067dcc990ab2",
  },
  16: {
    bytes: 16777216,
    checksum: 2139095040,
    sha256: "e3e019b9bf017a8fd1de597964e880a5ad5145e115132f92849cd2b28a1f7232",
  },
  64: {
    bytes: 67108864,
    checksum: 8556380160,
    sha256: "39615dc73614a616858fcbe5ccc2e47e22cd2de9a9adad99065435d22a5fbaff",
  },
} as const;
type Endpoint = "r2-copy-effect" | "r2-copy-native";
type Sample = {
  endpoint: string;
  phase: string;
  sequence: number;
  startedAt: string;
  endedAt: string;
  elapsedMs: number;
  status: number | null;
  body: string | null;
  correct: boolean;
  cfRay: string | null;
  error: string | null;
};
const help = `Usage: bun benchmark/cloudflare-cpu/r2-load.ts --url URL --variant LABEL --revision REV --output FILE
  --url URL           Public R2 benchmark Worker origin, or BENCH_URL
  --variant LABEL     Baseline/candidate label (required)
  --revision REV      Exact source revision/patch label (required)
  --output FILE       New JSON file (required; never overwritten)
  --endpoints LIST    r2-copy-effect and/or r2-copy-native (default: r2-copy-effect)
  --count N           Fixture size in MiB: 1, 16 or 64 (default: 16)
  --requests N        Measured copies per endpoint (default: 30; max: 300)
  --warmups N         Excluded warmup copies per endpoint (default: 10; max: 50)
  --concurrency N     Must be 1; each mode owns one fixed target key
  --seed              Seed the selected source before the run
  --run-id ID         Correlation marker (default: r2-TIMESTAMP)
  --help              Show help
Every request has a 30-second deadline and is never retried.
Source verification and verification after EVERY copy are excluded from measured samples.
`;

const integer = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Expected integer ${min}..${max}`);
  return value;
};
const stats = (samples: Sample[]) => {
  const values = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const percentile = (p: number) => values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
  return {
    count: values.length,
    minMs: values[0] ?? null,
    maxMs: values.at(-1) ?? null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    meanMs: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
  };
};

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      url: { type: "string" },
      variant: { type: "string" },
      revision: { type: "string" },
      output: { type: "string" },
      endpoints: { type: "string" },
      count: { type: "string" },
      requests: { type: "string" },
      warmups: { type: "string" },
      concurrency: { type: "string" },
      seed: { type: "boolean" },
      "run-id": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const rawUrl = values.url ?? process.env.BENCH_URL;
  if (!rawUrl || !values.variant || !values.revision || !values.output) throw new Error(help);
  const origin = new URL(rawUrl);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("--url must be a public origin without credentials, path or query");
  const count = Number(values.count ?? 16) as keyof typeof fixtures;
  if (![1, 16, 64].includes(count)) throw new Error("--count must be 1, 16 or 64 MiB");
  const fixture = fixtures[count];
  const endpoints = (values.endpoints ?? "r2-copy-effect").split(",") as Endpoint[];
  if (
    endpoints.length === 0 ||
    new Set(endpoints).size !== endpoints.length ||
    endpoints.some((endpoint) => !["r2-copy-effect", "r2-copy-native"].includes(endpoint))
  ) {
    throw new Error("--endpoints must select distinct r2-copy-effect/r2-copy-native");
  }
  const requests = integer(values.requests, 30, 1, 300);
  const warmups = integer(values.warmups, 10, 0, 50);
  integer(values.concurrency, 1, 1, 1);
  const runId = values["run-id"] ?? `r2-${Date.now()}`;
  const output = resolve(values.output);
  if (await Bun.file(output).exists()) throw new Error(`Refusing to overwrite ${output}`);
  await mkdir(dirname(output), { recursive: true });
  const startedAt = new Date().toISOString();
  const auxiliary: Sample[] = [];
  let expectedVersion: string | undefined;

  const request = async (
    endpoint: string,
    phase: string,
    sequence: number,
    auxiliaryRequest = false,
  ): Promise<Sample> => {
    const url = new URL(`/${endpoint}`, origin);
    // Auxiliary requests use a separate marker and are not part of the CPU
    // collector cohort. Both sets use only its whitelisted query keys.
    url.searchParams.set("run", auxiliaryRequest ? `${runId}-aux` : runId);
    url.searchParams.set("phase", phase);
    if (endpoint !== "health") url.searchParams.set("count", String(count));
    const sample: Sample = {
      endpoint,
      phase,
      sequence,
      startedAt: new Date().toISOString(),
      endedAt: "",
      elapsedMs: 0,
      status: null,
      body: null,
      correct: false,
      cfRay: null,
      error: null,
    };
    const start = performance.now();
    try {
      const response = await fetch(url, {
        method: endpoint === "r2-seed" ? "POST" : "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      sample.status = response.status;
      sample.cfRay = response.headers.get("cf-ray");
      sample.body = await response.text();
      sample.elapsedMs = performance.now() - start;
      sample.endedAt = new Date().toISOString();
      const body = JSON.parse(sample.body);
      if (endpoint === "health") {
        sample.correct =
          response.status === 200 &&
          body.ok === true &&
          body.harness === "cloudflare-cpu-r2-v1" &&
          typeof body.version?.id === "string";
        if (sample.correct && phase === "before") expectedVersion = body.version.id;
      } else {
        const mode = endpoint.endsWith("native")
          ? "native"
          : endpoint.endsWith("effect")
            ? "effect"
            : "seed";
        const key = mode === "seed" ? `seed/${count}` : `copy/${mode}/${count}`;
        sample.correct =
          response.status === 200 &&
          body.ok === true &&
          body.mib === count &&
          body.bytes === fixture.bytes &&
          body.sha256 === fixture.sha256 &&
          body.version?.id === expectedVersion &&
          typeof body.etag === "string" &&
          body.etag.length > 0;
        if (endpoint.startsWith("r2-copy-")) {
          sample.correct &&=
            body.endpoint === endpoint &&
            body.count === count &&
            body.mode === mode &&
            body.sourceKey === `seed/${count}` &&
            body.targetKey === key;
        } else {
          sample.correct &&=
            body.key === key &&
            body.checksum === fixture.checksum &&
            body.operation === (endpoint === "r2-seed" ? "seed" : "verify");
        }
      }
      if (!sample.correct)
        sample.error = "Unexpected status, object identity, size, metadata or digest";
    } catch (error) {
      sample.elapsedMs ||= performance.now() - start;
      sample.endedAt ||= new Date().toISOString();
      sample.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    return sample;
  };

  const before = await request("health", "before", 0);
  if (before.correct && values.seed) auxiliary.push(await request("r2-seed", "seed", 0, true));
  if (before.correct && auxiliary.every((sample) => sample.correct)) {
    auxiliary.push(await request("r2-verify-seed", "verify", 0, true));
  }
  const ready =
    before.correct && auxiliary.length > 0 && auxiliary.every((sample) => sample.correct);
  let aborted = !ready;

  const batch = async (endpoint: Endpoint, phase: "warmup" | "measured", target: number) => {
    const samples: Sample[] = [];
    const start = performance.now();
    const startedAt = new Date().toISOString();
    for (let sequence = 0; sequence < target && !aborted; sequence++) {
      const sample = await request(endpoint, phase, sequence);
      samples.push(sample);
      if (!sample.correct) {
        aborted = true;
        break;
      }
      const verified = await request(
        endpoint.replace("copy", "verify"),
        "verify",
        auxiliary.length,
        true,
      );
      auxiliary.push(verified);
      if (!verified.correct) aborted = true;
    }
    return {
      startedAt,
      endedAt: new Date().toISOString(),
      cohortWallMs: performance.now() - start,
      elapsedMs: samples.reduce((sum, sample) => sum + sample.elapsedMs, 0),
      samples,
    };
  };
  const workloads = [];
  if (ready)
    for (const endpoint of endpoints) {
      const warmup = await batch(endpoint, "warmup", warmups);
      const measured = await batch(endpoint, "measured", requests);
      const successful = measured.samples.filter((sample) => sample.correct);
      const summary = {
        attempted: measured.samples.length,
        successful: successful.length,
        failed: measured.samples.length - successful.length,
        requestsPerSecond: measured.elapsedMs
          ? measured.samples.length / (measured.elapsedMs / 1000)
          : null,
        latencyAll: stats(measured.samples),
        latencySuccessful: stats(successful),
      };
      workloads.push({ endpoint, warmup, measured, summary });
      console.log(JSON.stringify({ endpoint, ...summary }));
      if (aborted) break;
    }
  const after = await request("health", "after", 0);
  const versionBefore = before.correct ? JSON.parse(before.body!).version : null;
  const versionAfter = after.correct ? JSON.parse(after.body!).version : null;
  const versionStable = versionBefore !== null && versionBefore.id === versionAfter?.id;
  const totalRequests =
    2 +
    workloads.reduce(
      (sum, workload) => sum + workload.warmup.samples.length + workload.measured.samples.length,
      0,
    );
  const allCorrect =
    ready &&
    !aborted &&
    after.correct &&
    versionStable &&
    workloads.length === endpoints.length &&
    workloads.every(
      (workload) =>
        workload.warmup.samples.length === warmups && workload.measured.samples.length === requests,
    );
  const result = {
    schemaVersion: 1,
    harness: "cloudflare-cpu-r2-v1",
    runId,
    variant: values.variant,
    revision: values.revision,
    url: origin.origin,
    startedAt,
    endedAt: new Date().toISOString(),
    client: { runtime: `bun ${Bun.version}`, platform: process.platform, arch: process.arch },
    configuration: {
      endpoints,
      requests,
      warmups,
      concurrency: 1,
      operations: count,
      fixtureMiB: count,
      timeoutMs: 30000,
    },
    fixture,
    versionBefore,
    versionAfter,
    versionStable,
    allCorrect,
    aborted,
    totalRequests,
    totalActualRequests: totalRequests + auxiliary.length,
    measuredRequests: workloads.reduce(
      (sum, workload) => sum + workload.measured.samples.length,
      0,
    ),
    health: { before, after },
    workloads,
    auxiliary,
    metricNotes: {
      cpu: "Stored invocation CPU for the primary run marker only; no CPU is inferred from client time",
      elapsed:
        "Per-copy client time includes actual R2 get + put and response read; excludes verification",
      windows:
        "Cohort wall windows include auxiliary verification gaps; sum-copy elapsed and latency do not",
      totalRequests:
        "CPU collector cohort only: before/after health + warmup/measured copies; auxiliary requests have runId-aux",
      verification:
        "Full byte pattern, SHA-256, checksum, metadata and size verified after every copy; outside measured samples",
      retries: "None; abort remaining workload on the first failed copy or integrity check",
    },
  };
  await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      output,
      allCorrect,
      totalRequests,
      totalActualRequests: result.totalActualRequests,
    }),
  );
  if (!allCorrect) process.exitCode = 1;
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
