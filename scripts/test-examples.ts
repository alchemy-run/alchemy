const examples = [
  "./examples/cloudflare-dev",
  "./examples/cloudflare-worker",
  "./examples/cloudflare-pr-package",
  "./examples/cloudflare-worker-async",
  "./examples/cloudflare-tanstack",
  "./examples/cloudflare-tanstack-start-solid",
  "./examples/cloudflare-neon-drizzle",
  "./examples/cloudflare-vue",
  "./examples/cloudflare-solidstart",
  "./examples/cloudflare-foldkit",
  "./examples/cloudflare-octane",
  "./examples/cloudflare-website-astro",
  "./examples/cloudflare-website-nextjs",
  "./examples/cloudflare-website-nuxt",
  "./examples/cloudflare-website-sveltekit",
  "./examples/cloudflare-website-waku",
  "./examples/aws-dev",
  "./examples/aws-ecs",
  "./examples/aws-lambda",
  "./examples/aws-website-astro",
  "./examples/aws-website-nextjs",
  "./examples/aws-website-nuxt",
  "./examples/aws-website-sveltekit",
  "./examples/aws-website-waku",
] as const;

type CommandResult = {
  label: string;
  command: readonly string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type TaskState = {
  label: string;
  command: readonly string[];
  status: "pending" | "running" | "ok" | "failed";
  startedAt?: number;
  endedAt?: number;
  exitCode?: number | null;
};

const readStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<string> => new Response(stream).text();

const elapsedSeconds = (state: TaskState): string => {
  if (state.startedAt === undefined) {
    return "0s";
  }
  const endedAt = state.endedAt ?? performance.now();
  return `${Math.round((endedAt - state.startedAt) / 1000)}s`;
};

const makeStatusRenderer = (states: readonly TaskState[]) => {
  const interactive = process.stdout.isTTY === true;
  let renderedRows = 0;

  const taskLine = (state: TaskState) => {
    const icon =
      state.status === "ok"
        ? "ok"
        : state.status === "failed"
          ? "failed"
          : state.status;
    const exit =
      state.exitCode === undefined || state.exitCode === 0
        ? ""
        : ` exit ${state.exitCode ?? "signal"}`;
    return `  ${icon.padEnd(7)} ${state.label} ${elapsedSeconds(state)}${exit}`;
  };

  // Physical rows a line occupies once the terminal wraps it.
  const rowsFor = (line: string) => {
    const columns = process.stdout.columns || 80;
    return Math.max(1, Math.ceil(line.length / columns));
  };
  const rowsForAll = (output: readonly string[]) =>
    output.reduce((total, line) => total + rowsFor(line), 0);

  const fullLines = () => ["Example tests", ...states.map(taskLine)];

  // The in-place repaint moves the cursor up with `\x1b[NF`, which cannot
  // climb above the top of the viewport: if a paint is taller than the
  // terminal (or lines wrap), the write scrolls and every repaint leaks its
  // topmost rows into scrollback. Keep each paint strictly shorter than the
  // viewport by collapsing finished tasks into the header once space runs
  // out (`+ 1` accounts for the cursor parking on the row below the paint).
  const lines = () => {
    const rows = process.stdout.rows || 24;
    const full = fullLines();
    if (rowsForAll(full) + 1 <= rows) {
      return full;
    }
    const done = states.filter((state) => state.status === "ok").length;
    const active = states.filter((state) => state.status !== "ok");
    const header = `Example tests (${done}/${states.length} ok)`;
    const activeLines = active.map(taskLine);
    let shown = activeLines.length;
    const fits = (count: number) => {
      const overflow = count < activeLines.length ? 1 : 0;
      return (
        rowsForAll([header, ...activeLines.slice(0, count)]) + overflow + 1 <=
        rows
      );
    };
    while (shown > 0 && !fits(shown)) {
      shown--;
    }
    return shown === activeLines.length
      ? [header, ...activeLines]
      : [
          header,
          ...activeLines.slice(0, shown),
          `  … ${activeLines.length - shown} more`,
        ];
  };

  return {
    render() {
      if (!interactive) {
        return;
      }
      if (renderedRows > 0) {
        process.stdout.write(`\x1b[${renderedRows}F\x1b[J`);
      }
      const output = lines();
      process.stdout.write(`${output.join("\n")}\n`);
      renderedRows = rowsForAll(output);
    },
    finish() {
      if (interactive && renderedRows > 0) {
        process.stdout.write(`\x1b[${renderedRows}F\x1b[J`);
        renderedRows = 0;
      }
      // Always end with the full table (the live view may be compacted).
      for (const line of fullLines()) {
        console.log(line);
      }
    },
  };
};

const run = async (
  state: TaskState,
  render: () => void,
): Promise<CommandResult> => {
  state.status = "running";
  state.startedAt = performance.now();
  render();

  const child = Bun.spawn([...state.command], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readStream(child.stdout),
    readStream(child.stderr),
  ]);

  state.status = exitCode === 0 ? "ok" : "failed";
  state.exitCode = exitCode;
  state.endedAt = performance.now();
  render();

  return {
    label: state.label,
    command: state.command,
    exitCode,
    stdout,
    stderr,
  };
};

const runParallel = async (
  tasks: readonly { label: string; command: readonly string[] }[],
): Promise<readonly CommandResult[]> => {
  const states = tasks.map(
    (task): TaskState => ({
      ...task,
      status: "pending",
    }),
  );
  const renderer = makeStatusRenderer(states);
  renderer.render();
  const interval = setInterval(() => renderer.render(), 1000);

  try {
    return await Promise.all(
      states.map((state) => run(state, () => renderer.render())),
    );
  } finally {
    clearInterval(interval);
    renderer.finish();
  }
};

const testResults = await runParallel(
  examples.map((example) => ({
    label: example,
    command: ["bun", "run", "--filter", example, "test"],
  })),
);
const failedTests = testResults.filter((result) => result.exitCode !== 0);

if (failedTests.length > 0) {
  console.error("\nFailed example tests:");
  for (const failure of failedTests) {
    const exit = failure.exitCode === null ? "signal" : failure.exitCode;
    console.error(
      `- ${failure.label} (exit ${exit}): ${failure.command.join(" ")}`,
    );
  }

  for (const failure of failedTests) {
    console.error(`\n--- ${failure.label} stdout ---`);
    if (failure.stdout.length > 0) {
      console.error(failure.stdout.trimEnd());
    } else {
      console.error("(empty)");
    }

    console.error(`\n--- ${failure.label} stderr ---`);
    if (failure.stderr.length > 0) {
      console.error(failure.stderr.trimEnd());
    } else {
      console.error("(empty)");
    }
  }
  process.exit(1);
}

const [formatFailure] = await runParallel([
  { label: "format", command: ["bun", "run", "format"] },
]);
if (formatFailure.exitCode !== 0) {
  console.error("\nFormat failed:");
  if (formatFailure.stdout.length > 0) {
    console.error(formatFailure.stdout.trimEnd());
  }
  if (formatFailure.stderr.length > 0) {
    console.error(formatFailure.stderr.trimEnd());
  }
  process.exit(formatFailure.exitCode ?? 1);
}
