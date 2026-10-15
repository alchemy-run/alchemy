import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const help = `Usage: bun benchmark/cloudflare-cpu/load.ts --url URL --variant LABEL --revision REV --output FILE

  --url URL            Deployed Worker origin, or BENCH_URL
  --variant LABEL      Baseline/candidate label (required)
  --revision REV       Exact source revision/tree label (required)
  --output FILE        New JSON evidence file (required; never overwritten)
  --endpoints LIST     noop,effect-ops,workflow-codec,rpc-shape,rpc-binary,rpc-records,ai-image,ai-tools,queue-packing (default: first three)
  --requests N         Measured requests per endpoint (default: 100, max: 10000)
  --warmups N          Excluded warmup requests per endpoint (default: 10, max: 1000)
  --concurrency N      Max in-flight requests (default: 4, max: 64)
  --ops N              Operations/request (default: 1000; ai-image: 5; ai-tools: 100; queue-packing: 500)
                      Max: 20000; rpc-binary: 2048; ai-image: 20; ai-tools/queue-packing: 500
  --timeout-ms N       Timeout for each full response (default: 15000, max: 60000)
  --run-id ID          URL query marker for Workers Logs (default: cpu-TIMESTAMP)
  --help               Show this help

Latency is client elapsed time including the response body, never Worker CPU.
No retries are made. Warmups, failed samples, and before/after health probes are retained.
`;

type Endpoint =
  | "noop"
  | "effect-ops"
  | "workflow-codec"
  | "rpc-shape"
  | "rpc-binary"
  | "rpc-records"
  | "ai-image"
  | "ai-tools"
  | "queue-packing";
type Sample = {
  endpoint: Endpoint | "health";
  phase: "warmup" | "measured" | "before" | "after";
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

function integer(value: string | undefined, fallback: number, max: number, minimum = 1) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > max) {
    throw new Error(`Expected integer from ${minimum} to ${max}; received ${value}`);
  }
  return result;
}

function percentile(sorted: number[], percentage: number) {
  return sorted.length === 0
    ? null
    : sorted[Math.max(0, Math.ceil(sorted.length * percentage) - 1)];
}

function latency(samples: Sample[]) {
  const sorted = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? null,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.at(-1) ?? null,
    meanMs:
      sorted.length === 0 ? null : sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

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
      requests: { type: "string" },
      warmups: { type: "string" },
      concurrency: { type: "string" },
      ops: { type: "string" },
      "timeout-ms": { type: "string" },
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
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error(
      "--url must be an HTTP(S) origin without credentials, path, query, or fragment",
    );
  const endpoints = (values.endpoints ?? "noop,effect-ops,workflow-codec").split(",") as Endpoint[];
  if (
    endpoints.length === 0 ||
    new Set(endpoints).size !== endpoints.length ||
    endpoints.some(
      (endpoint) =>
        ![
          "noop",
          "effect-ops",
          "workflow-codec",
          "rpc-shape",
          "rpc-binary",
          "rpc-records",
          "ai-image",
          "ai-tools",
          "queue-packing",
        ].includes(endpoint),
    )
  )
    throw new Error(
      "--endpoints must select distinct noop,effect-ops,workflow-codec,rpc-shape,rpc-binary,rpc-records,ai-image,ai-tools,queue-packing entries",
    );
  const requests = integer(values.requests, 100, 10_000);
  const warmups = integer(values.warmups, 10, 1_000, 0);
  const concurrency = integer(values.concurrency, 4, 64);
  const defaultOperations =
    endpoints.length === 1 && endpoints[0] === "ai-image"
      ? 5
      : endpoints.length === 1 && endpoints[0] === "ai-tools"
        ? 100
        : endpoints.length === 1 && endpoints[0] === "queue-packing"
          ? 500
          : 1_000;
  const operations = integer(values.ops, defaultOperations, 20_000, 0);
  if (endpoints.includes("rpc-binary") && operations > 2048) {
    throw new Error("--ops must be <= 2048 for rpc-binary (32 MiB of decoded chunks per request)");
  }
  if (endpoints.includes("ai-image") && operations > 20) {
    throw new Error("--ops must be <= 20 for ai-image (1 MiB per adapter call)");
  }
  if (endpoints.includes("ai-tools") && operations > 500) {
    throw new Error("--ops must be <= 500 for ai-tools (40 tools per adapter call)");
  }
  if (endpoints.includes("queue-packing") && operations > 500) {
    throw new Error("--ops must be <= 500 for queue-packing (98 KiB per message)");
  }
  const timeoutMs = integer(values["timeout-ms"], 15_000, 60_000);
  const runId = values["run-id"] ?? `cpu-${Date.now()}`;
  const output = resolve(values.output);
  if (await Bun.file(output).exists()) throw new Error(`Refusing to overwrite ${output}`);
  await mkdir(dirname(output), { recursive: true });
  const startedAt = new Date().toISOString();

  async function request(endpoint: Endpoint | "health", phase: Sample["phase"], sequence: number) {
    const url = new URL(`/${endpoint}`, origin);
    url.searchParams.set("run", runId);
    url.searchParams.set("phase", phase);
    if (endpoint !== "noop" && endpoint !== "health") {
      url.searchParams.set("count", String(operations));
    }
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
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      sample.status = response.status;
      sample.cfRay = response.headers.get("cf-ray");
      sample.body = await response.text();
      sample.elapsedMs = performance.now() - start;
      sample.endedAt = new Date().toISOString();
      const body = JSON.parse(sample.body);
      const expectedChecksum =
        endpoint === "workflow-codec"
          ? operations * 45
          : endpoint === "rpc-binary"
            ? operations * 16_384 * 127.5
            : endpoint === "rpc-records"
              ? 2 * operations * operations + operations
              : endpoint === "ai-image"
                ? (operations * 3046236408) >>> 0
                : endpoint === "ai-tools"
                  ? (operations * 1959072881) >>> 0
                  : endpoint === "queue-packing"
                    ? operations * 56_000
                    : (operations * (operations + 1)) / 2;
      const streamShapeCorrect =
        endpoint === "rpc-binary"
          ? body.chunks === operations && body.bytes === operations * 16_384
          : endpoint === "rpc-records"
            ? body.records === operations
            : endpoint === "ai-image"
              ? body.iterations === operations &&
                body.bytes === operations * 1048576 &&
                body.dataUrlCharacters === operations * 1398126 &&
                body.diagnostic ===
                  "Actual Workers AI LanguageModel adapter with an in-memory validating Ai.run sink; excludes remote inference."
              : endpoint === "ai-tools"
                ? body.iterations === operations &&
                  body.tools === operations * 40 &&
                  body.schemaCharacters === operations * 31551 &&
                  body.diagnostic ===
                    "Actual Workers AI LanguageModel adapter with an in-memory validating Ai.run sink; excludes remote inference."
                : endpoint === "queue-packing"
                  ? body.batches === Math.ceil(operations / 2) && body.messageBytes === 98_111
                  : true;
      sample.correct =
        response.status === 200 &&
        body.ok === true &&
        (endpoint === "health"
          ? body.harness === "cloudflare-cpu-v1" &&
            typeof body.version?.id === "string" &&
            typeof body.features?.uint8ArrayToBase64 === "boolean" &&
            typeof body.features?.uint8ArrayFromBase64 === "boolean"
          : body.endpoint === endpoint &&
            (endpoint === "noop" ||
              (body.count === operations &&
                body.checksum === expectedChecksum &&
                streamShapeCorrect)));
      if (!sample.correct) sample.error = "Unexpected status or response body";
    } catch (error) {
      sample.elapsedMs ||= performance.now() - start;
      sample.endedAt ||= new Date().toISOString();
      sample.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    return sample;
  }

  async function batch(endpoint: Endpoint, phase: "warmup" | "measured", count: number) {
    const samples: Sample[] = new Array(count);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(count, concurrency) }, async () => {
        while (next < count) {
          const sequence = next++;
          samples[sequence] = await request(endpoint, phase, sequence);
        }
      }),
    );
    const elapsedMs = performance.now() - start;
    return { startedAt, endedAt: new Date().toISOString(), elapsedMs, samples };
  }

  const before = await request("health", "before", 0);
  const workloads = [];
  if (before.correct) {
    for (const endpoint of endpoints) {
      const warmup = await batch(endpoint, "warmup", warmups);
      const measured = await batch(endpoint, "measured", requests);
      const successes = measured.samples.filter((sample) => sample.correct);
      workloads.push({
        endpoint,
        warmup,
        measured,
        summary: {
          attempted: measured.samples.length,
          successful: successes.length,
          failed: measured.samples.length - successes.length,
          requestsPerSecond: measured.samples.length / (measured.elapsedMs / 1_000),
          successfulRequestsPerSecond: successes.length / (measured.elapsedMs / 1_000),
          latencyAll: latency(measured.samples),
          latencySuccessful: latency(successes),
        },
      });
      console.log(JSON.stringify({ endpoint, ...workloads.at(-1)!.summary }));
    }
  }
  const after = await request("health", "after", 0);
  const versionBefore = before.correct ? JSON.parse(before.body!).version : null;
  const versionAfter = after.correct ? JSON.parse(after.body!).version : null;
  const features = before.correct ? JSON.parse(before.body!).features : null;
  const versionStable = versionBefore !== null && versionBefore.id === versionAfter?.id;
  const allCorrect =
    before.correct &&
    after.correct &&
    versionStable &&
    workloads.every(
      ({ warmup, summary }) =>
        warmup.samples.every((sample) => sample.correct) && summary.failed === 0,
    );
  const result = {
    schemaVersion: 1,
    harness: "cloudflare-cpu-v1",
    runId,
    variant: values.variant,
    revision: values.revision,
    url: origin.origin,
    client: { runtime: `bun ${Bun.version}`, platform: process.platform, arch: process.arch },
    configuration: { endpoints, requests, warmups, concurrency, operations, timeoutMs },
    startedAt,
    endedAt: new Date().toISOString(),
    totalRequests: 2 + workloads.length * (requests + warmups),
    measuredRequests: workloads.length * requests,
    versionBefore,
    versionAfter,
    features,
    versionStable,
    allCorrect,
    health: { before, after },
    workloads,
    metricNotes: {
      elapsed: "Client monotonic elapsed time through full body read; includes network; not CPU",
      cpu: "Retrieve invocation CPU from Cloudflare for each measured endpoint/time window and run query marker",
      warmups:
        "Excluded from measured windows and latency/throughput summaries; raw samples retained",
      retries: "None",
      ai: "Hosted adapter CPU diagnostic using the actual LanguageModel adapter and an in-memory validating inference sink; excludes remote inference",
    },
  };
  await Bun.write(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({ output, allCorrect, versionStable, totalRequests: result.totalRequests }),
  );
  if (!allCorrect) process.exitCode = 1;
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
