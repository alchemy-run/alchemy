import { fileURLToPath } from "node:url";
import path from "pathe";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const cliEntry = path.join(packageRoot, "bin/alchemy.ts");
const emptyStack = path.join(here, "empty-stack.ts");

interface Sample {
  durationMs: number;
  exitCode: number | null;
}

const iterations = Number.parseInt(process.env.ITERATIONS ?? "15", 10);
const warmups = Number.parseInt(process.env.WARMUPS ?? "2", 10);

const quantile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;

const summarize = (name: string, samples: readonly Sample[]) => {
  const values = samples
    .map((sample) => sample.durationMs)
    .sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  console.log(
    `${name.padEnd(24)} n=${values.length.toString().padStart(2)} ` +
      `mean=${mean.toFixed(1).padStart(7)}ms ` +
      `min=${values[0]!.toFixed(1).padStart(7)}ms ` +
      `p50=${quantile(values, 0.5).toFixed(1).padStart(7)}ms ` +
      `p95=${quantile(values, 0.95).toFixed(1).padStart(7)}ms ` +
      `max=${values.at(-1)!.toFixed(1).padStart(7)}ms`,
  );
};

const runToExit = async (command: readonly string[]): Promise<Sample> => {
  const started = performance.now();
  const child = Bun.spawn(command, {
    cwd: workspaceRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await child.exited;
  return { durationMs: performance.now() - started, exitCode };
};

const runToOutput = async (
  command: readonly string[],
  marker: string,
): Promise<Sample> => {
  const started = performance.now();
  const child = Bun.spawn(command, {
    cwd: workspaceRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const decoder = new TextDecoder();
  let output = "";
  let markedAt: number | undefined;

  let resolveMarker!: () => void;
  const sawMarker = new Promise<void>((resolve) => {
    resolveMarker = resolve;
  });
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      if (markedAt === undefined && output.includes(marker)) {
        markedAt = performance.now();
        resolveMarker();
      }
    }
  };

  void consume(child.stdout);
  void consume(child.stderr);
  await Promise.race([
    sawMarker,
    child.exited.then(() => {
      throw new Error(
        `Process exited before emitting ${JSON.stringify(marker)}:\n${output}`,
      );
    }),
  ]);
  if (markedAt === undefined) {
    throw new Error(
      `Process exited before emitting ${JSON.stringify(marker)}:\n${output}`,
    );
  }
  // dev owns a watched exec child. Give the benchmark its own process group
  // so every iteration tears down both processes before the next begins.
  process.kill(-child.pid, "SIGTERM");
  await child.exited;
  return {
    durationMs: markedAt - started,
    exitCode: child.exitCode,
  };
};

const cases: ReadonlyArray<{
  name: string;
  run: () => Promise<Sample>;
}> = [
  {
    name: "bun process",
    run: () => runToExit([process.execPath, "-e", ""]),
  },
  {
    name: "effect import",
    run: () =>
      runToExit([process.execPath, "-e", 'await import("effect/Effect")']),
  },
  {
    name: "alchemy import",
    run: () => runToExit([process.execPath, "-e", 'await import("alchemy")']),
  },
  {
    name: "CLI module import",
    run: () =>
      runToExit([
        process.execPath,
        "-e",
        `await import(${JSON.stringify(path.join(packageRoot, "src/Cli/main.ts"))})`,
      ]),
  },
  {
    name: "CLI barrel import",
    run: () =>
      runToExit([process.execPath, "-e", 'await import("alchemy/Cli")']),
  },
  {
    name: "dev exec import",
    run: () =>
      runToExit([
        process.execPath,
        "-e",
        `await import(${JSON.stringify(path.join(packageRoot, "src/Cli/exec.ts"))})`,
      ]),
  },
  {
    name: "consumer stack import",
    run: () =>
      runToExit([
        process.execPath,
        "-e",
        `await import(${JSON.stringify(
          path.join(workspaceRoot, "examples/cloudflare-worker/alchemy.run.ts"),
        )})`,
      ]),
  },
  {
    name: "empty stack import",
    run: () =>
      runToExit([
        process.execPath,
        "-e",
        `await import(${JSON.stringify(emptyStack)})`,
      ]),
  },
  {
    name: "time to help",
    run: () => runToExit([process.execPath, cliEntry, "--help"]),
  },
  {
    name: "launched time to help",
    run: () => runToExit([process.execPath, "alchemy", "--help"]),
  },
  {
    name: "plan time to first Plan",
    run: () =>
      runToOutput(
        [
          process.execPath,
          cliEntry,
          "plan",
          emptyStack,
          "--stage",
          "startup-benchmark",
        ],
        "Plan:",
      ),
  },
  {
    name: "dev time to first Plan",
    run: () =>
      runToOutput(
        [
          process.execPath,
          cliEntry,
          "dev",
          emptyStack,
          "--stage",
          "startup-benchmark",
        ],
        "Plan:",
      ),
  },
];

const caseFilter = process.env.CASE;
for (const benchmark of cases.filter(
  ({ name }) => caseFilter === undefined || name.includes(caseFilter),
)) {
  for (let i = 0; i < warmups; i++) await benchmark.run();
  const samples: Sample[] = [];
  for (let i = 0; i < iterations; i++) samples.push(await benchmark.run());
  summarize(benchmark.name, samples);
}
