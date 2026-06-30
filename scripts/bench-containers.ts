#!/usr/bin/env bun
/**
 * Cold-start benchmark runner + report generator.
 *
 *   bun bench:containers
 *
 * Runs the Cloudflare Container and (optionally) AWS Lambda MicroVM cold-start
 * benchmarks on a FRESH deploy, streams their live output, then parses the
 * per-variant reports into a single markdown comparison written to
 * `bench-report.md` (override with BENCH_OUT).
 *
 * Each benchmark boots → shuts down each variant `BENCH_ITER` times
 * sequentially (a fresh instance/key per cycle), measuring the time until the
 * in-instance service is reachable. Cloudflare images are pre-warmed to the
 * edge metal first so we measure container cold start, not one-time image
 * distribution.
 *
 * Flags / env:
 *   --containers-only        run only the Cloudflare Container benchmark
 *   --microvm                force-run the MicroVM benchmark
 *   BENCH_ITER=N             cycles per variant (default 10)
 *   BENCH_OUT=path           report output path (default ./bench-report.md)
 *   LAMBDA_TEST_MICROVM=1    enables the MicroVM benchmark (preview, gated)
 *
 * The MicroVM benchmark only runs when LAMBDA_TEST_MICROVM is set (or
 * --microvm is passed); otherwise it is skipped with a note, since MicroVM is a
 * gated preview feature.
 */
import { spawn } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;
const ALCHEMY = `${ROOT}packages/alchemy`;

const args = new Set(process.argv.slice(2));
const containersOnly = args.has("--containers-only");
const runMicrovm =
  !containersOnly &&
  (args.has("--microvm") || Boolean(process.env.LAMBDA_TEST_MICROVM));
const outPath = process.env.BENCH_OUT ?? `${ROOT}bench-report.md`;

interface Suite {
  readonly key: string;
  readonly title: string;
  /** Substring of the report header line that begins the captured block. */
  readonly header: string;
  readonly test: string;
  readonly filter: string;
  readonly env: Record<string, string>;
}

const suites: Suite[] = [
  {
    key: "containers",
    title: "Cloudflare Containers (Worker → DO → Container)",
    header: "Container cold-start benchmark",
    test: "test/Cloudflare/Container/Container.benchmark.test.ts",
    filter: "cold-start trend",
    env: { ALCHEMY_PROFILE: "testing" },
  },
  {
    key: "microvm",
    title: "AWS Lambda MicroVM (Lambda host + Worker host)",
    header: "MicroVM cold-start benchmark",
    test: "test/AWS/Lambda/Microvm.benchmark.test.ts",
    filter: "boot→shutdown",
    env: { ALCHEMY_PROFILE: "testing", LAMBDA_TEST_MICROVM: "1" },
  },
];

/** Run one vitest suite, teeing its output to our stdout while capturing it. */
async function runSuite(suite: Suite): Promise<string> {
  const cmd = [
    "bun",
    "vitest",
    "run",
    "--disable-console-intercept",
    "-t",
    suite.filter,
    suite.test,
  ];
  process.stdout.write(`\n=== running ${suite.title} ===\n`);
  const proc = spawn({
    cmd,
    cwd: ALCHEMY,
    env: { ...process.env, ...suite.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let captured = "";
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    // @ts-expect-error Bun streams are async-iterable
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      captured += text;
      process.stdout.write(text);
    }
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  if (code !== 0) {
    process.stdout.write(`\n!! ${suite.title} exited with code ${code}\n`);
  }
  return captured;
}

/** Extract the report block (header line through the variant tables). */
function extractReport(output: string, header: string): string {
  const lines = output.split("\n");
  const start = lines.findIndex((l) => l.includes(header));
  if (start === -1) return "";
  const block: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(Test Files|Tests|Duration|Start at|⎯|❯|PASS|FAIL|\$)/.test(l)) {
      break;
    }
    block.push(l);
  }
  while (block.length > 0 && block[block.length - 1].trim() === "") {
    block.pop();
  }
  return block.join("\n");
}

interface Row {
  readonly platform: string;
  readonly variant: string;
  readonly bootP50: string;
  readonly readyP50: string;
  readonly readyMean: string;
  readonly firstReady: string;
  readonly ok: string;
}

/** Parse per-variant rows out of a captured report block. */
function parseRows(report: string, platform: string): Row[] {
  const rows: Row[] = [];
  const lines = report.split("\n");
  let variant = "";
  let ok = "";
  let bootP50 = "—";
  let firstReady = "—";
  let readyP50 = "—";
  let readyMean = "—";
  const flush = () => {
    if (variant) {
      rows.push({ platform, variant, bootP50, readyP50, readyMean, firstReady, ok });
    }
    bootP50 = firstReady = readyP50 = readyMean = "—";
    ok = "";
  };
  for (const l of lines) {
    const head = l.match(/^── (.+) ──$/);
    if (head) {
      flush();
      variant = head[1];
      continue;
    }
    const okM = l.match(/ok:\s*(\d+\/\d+)/);
    if (okM) ok = okM[1];
    const series = l.match(/readyMs by iteration:\s*([\d.]+s)/);
    if (series) firstReady = series[1];
    const boot = l.match(/bootMs[^:]*:.*p50\s+([\d.]+s)/);
    if (boot) bootP50 = boot[1];
    const ready = l.match(/readyMs[^:]*:.*p50\s+([\d.]+s).*mean\s+([\d.]+s)/);
    if (ready) {
      readyP50 = ready[1];
      readyMean = ready[2];
    }
  }
  flush();
  return rows;
}

async function main() {
  const selected = suites.filter(
    (s) => s.key === "containers" || (s.key === "microvm" && runMicrovm),
  );

  const captures = new Map<string, string>();
  for (const suite of selected) {
    captures.set(suite.key, await runSuite(suite));
  }

  const allRows: Row[] = [];
  const sections: string[] = [];
  for (const suite of selected) {
    const report = extractReport(captures.get(suite.key) ?? "", suite.header);
    allRows.push(...parseRows(report, suite.title));
    sections.push(
      `## ${suite.title}\n\n${report ? "```\n" + report + "\n```" : "_no report captured (suite may have failed — see console output above)_"}`,
    );
  }

  const summary = [
    "| Platform | Variant | ok | boot p50 | ready p50 | ready mean | 1st boot |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...allRows.map(
      (r) =>
        `| ${r.platform} | ${r.variant} | ${r.ok} | ${r.bootP50} | ${r.readyP50} | ${r.readyMean} | ${r.firstReady} |`,
    ),
  ].join("\n");

  const microvmNote = runMicrovm
    ? ""
    : "\n_MicroVM benchmark skipped — set `LAMBDA_TEST_MICROVM=1` (or pass `--microvm`) to include it; it is a gated preview feature._\n";

  const md = [
    "# Cold-start benchmark report",
    "",
    `_Generated ${new Date().toISOString()} · ${process.env.BENCH_ITER ?? 10} boot→shutdown cycles per variant._`,
    "",
    "Each variant boots a fresh instance (distinct key) from the same image, times the cold start until the in-instance service is reachable, then shuts it down — repeated sequentially so the trend over time is visible. Cloudflare images are pre-warmed to the edge metal so we measure container cold start, not one-time image distribution. `ready` = time to available service; `boot` = provision→running (MicroVM only).",
    microvmNote,
    "## Summary",
    "",
    summary,
    "",
    ...sections,
    "",
  ].join("\n");

  await Bun.write(outPath, md);
  process.stdout.write(`\n\nReport written to ${outPath}\n`);
  process.stdout.write("\n" + summary + "\n");
}

await main();
