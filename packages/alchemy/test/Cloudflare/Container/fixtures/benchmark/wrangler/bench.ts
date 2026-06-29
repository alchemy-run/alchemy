/**
 * Standalone cold-start benchmark for the plain wrangler + `@cloudflare/containers`
 * worker. Mirrors the methodology of the Alchemy benchmark
 * (`packages/alchemy/test/Cloudflare/Container/Container.benchmark.test.ts`) so
 * the two are directly comparable, but uses zero Alchemy code — just `fetch`
 * against the deployed worker.
 *
 * Usage (from this directory):
 *   bun x wrangler deploy                     # build + push the image, deploy the worker
 *   WORKER_URL=https://<worker>.workers.dev bun bench.ts
 *   BENCH_N=2 BENCH_CONCURRENCY=2 WORKER_URL=... bun bench.ts
 *   bun x wrangler delete                     # tear down
 *
 * `wrangler` and `@cloudflare/containers` resolve from the `alchemy` package's
 * devDependencies (catalog), so no separate install is needed.
 */

const WORKER_URL = (process.env.WORKER_URL ?? process.argv[2] ?? "").replace(
  /\/$/,
  "",
);
const N = Number(process.env.BENCH_N ?? 2);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? N);
const REQUEST_TIMEOUT_MS = Number(
  process.env.BENCH_REQUEST_TIMEOUT_MS ?? 240_000,
);

if (!WORKER_URL) {
  console.error(
    "Set WORKER_URL to the deployed worker, e.g. WORKER_URL=https://x.workers.dev bun bench.ts",
  );
  process.exit(1);
}

interface Sample {
  outside: number;
  inside: number | undefined;
}

const wait = async (url: string) => {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url, { headers: { connection: "close" } });
      const body = await res.text();
      if (res.status === 200 && body.includes("ok")) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, Math.min(3000, 500 * 2 ** i)));
  }
  throw new Error("worker never became ready");
};

const boot = async (
  name: string,
): Promise<{ sample?: Sample; failure?: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(
      `${WORKER_URL}/start?name=${encodeURIComponent(name)}`,
      { headers: { connection: "close" }, signal: controller.signal },
    );
    const body = await res.text();
    const outside = Date.now() - start;
    if (res.status !== 200) {
      return { failure: `${name}: HTTP ${res.status} ${body.slice(0, 200)}` };
    }
    let inside: number | undefined;
    try {
      inside = (JSON.parse(body) as { ms?: number }).ms;
    } catch {
      inside = undefined;
    }
    return { sample: { outside, inside } };
  } catch (err) {
    return { failure: `${name}: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
};

// Simple bounded-concurrency pool.
const runPool = async (
  names: string[],
  concurrency: number,
): Promise<Array<{ sample?: Sample; failure?: string }>> => {
  const results: Array<{ sample?: Sample; failure?: string }> = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, names.length) },
    async () => {
      while (next < names.length) {
        const i = next++;
        results[i] = await boot(names[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

const stats = (xs: number[]) => {
  if (xs.length === 0)
    return { min: 0, max: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const pct = (p: number) =>
    s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    min: s[0],
    max: s[s.length - 1],
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    p50: pct(50),
    p90: pct(90),
    p95: pct(95),
    p99: pct(99),
  };
};

const main = async () => {
  await wait(WORKER_URL);

  const nonce = crypto.randomUUID().slice(0, 8);
  const names = Array.from({ length: N }, (_, i) => `${nonce}-${i}`);
  const outcomes = await runPool(names, CONCURRENCY);

  const samples = outcomes
    .map((o) => o.sample)
    .filter((s): s is Sample => s !== undefined);
  const failures = outcomes
    .map((o) => o.failure)
    .filter((f): f is string => f !== undefined);

  const outside = stats(samples.map((s) => s.outside));
  const inside = stats(
    samples
      .map((s) => s.inside)
      .filter((m): m is number => typeof m === "number"),
  );
  const sec = (n: number) => `${(n / 1000).toFixed(1)}s`;

  console.log(
    [
      "",
      `wrangler + @cloudflare/containers cold-start benchmark (N=${N}, concurrency=${CONCURRENCY})`,
      `── non-effectful (oven/bun:latest, plain wrangler) ──`,
      `  ok: ${samples.length}/${N}   failed: ${failures.length}`,
      `  outside (client round-trip):`,
      `    min ${sec(outside.min)}  p50 ${sec(outside.p50)}  p90 ${sec(outside.p90)}  p95 ${sec(outside.p95)}  p99 ${sec(outside.p99)}  max ${sec(outside.max)}  mean ${sec(outside.mean)}`,
      `  inside (worker start→reachable):`,
      `    min ${sec(inside.min)}  p50 ${sec(inside.p50)}  p90 ${sec(inside.p90)}  p95 ${sec(inside.p95)}  p99 ${sec(inside.p99)}  max ${sec(inside.max)}  mean ${sec(inside.mean)}`,
      ...(failures.length > 0
        ? ["  failures:", ...failures.slice(0, 5).map((f) => `    - ${f}`)]
        : []),
      "",
    ].join("\n"),
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
