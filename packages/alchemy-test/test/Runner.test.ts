import { expect, it } from "alchemy-test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../bin/alchemy-test.ts");
const apiUrl = pathToFileURL(resolve(here, "../src/index.ts")).href;
const effectUrl = pathToFileURL(
  resolve(here, "../../../node_modules/effect/dist/Effect.js"),
).href;

const fixture = (hook: string, body: string): string => `
  import { it, registerHook } from ${JSON.stringify(apiUrl)};
  import * as Effect from ${JSON.stringify(effectUrl)};
  registerHook(${JSON.stringify(hook)}, { body: () => Effect.gen(function* () {
    yield* Effect.log(${JSON.stringify(`${hook}-captured-output`)});
    return yield* Effect.fail(new Error(${JSON.stringify(`${hook}-sentinel`)}));
  })
  });
  ${body}
`;

it("streams file-hook output to the run log while the hook is still running", async () => {
  // Regression: file-level hook output (deploy/destroy) used to be buffered
  // until FileEnd, so a long-running beforeAll produced a run log that
  // stopped growing entirely — a multi-minute cloud deploy read as a
  // deadlocked run (0% CPU, silent log). Hook log entries must reach the
  // per-run log file WHILE the hook is still executing.
  const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-livehook-"));
  try {
    await writeFile(
      resolve(root, "live-hook.test.ts"),
      `
        import { it, registerHook } from ${JSON.stringify(apiUrl)};
        import * as Effect from ${JSON.stringify(effectUrl)};
        registerHook("beforeAll", { body: () => Effect.gen(function* () {
          yield* Effect.log("hook-live-sentinel");
          yield* Effect.sleep("8 seconds");
        }) });
        it("body", () => {});
      `,
    );

    const child = Bun.spawn(
      [process.execPath, cli, root, "--retry", "0", "--concurrency", "1"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    try {
      // Poll the run log (created under the child's cwd) for the sentinel.
      // The hook sleeps 8s after logging; seeing the sentinel within ~6s
      // proves it was streamed mid-hook, not flushed at FileEnd.
      const logDir = resolve(root, ".alchemy", "log", "test");
      const deadline = Date.now() + 6_000;
      let streamed = false;
      while (Date.now() < deadline) {
        const { readdir, readFile } = await import("node:fs/promises");
        const entries = await readdir(logDir).catch(() => [] as string[]);
        for (const entry of entries) {
          const content = await readFile(resolve(logDir, entry), "utf8").catch(
            () => "",
          );
          if (content.includes("hook-live-sentinel")) {
            streamed = true;
            break;
          }
        }
        if (streamed) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(streamed).toBe(true);

      const exitCode = await child.exited;
      expect(exitCode).toBe(0);
    } finally {
      child.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports a timed-out test after a single attempt — no retries, no runner death", async () => {
  // Regression: a test that hit its per-test timeout used to be re-run by
  // the default retry (x2). Each retry burned the FULL timeout again (plus
  // the 10s interrupt grace when teardown was wedged), tripling the
  // wall-clock cost of a wedged cloud test — which pushed real suites past
  // external wall clocks (`timeout 240`, CI limits, Ctrl+C). The external
  // kill surfaced as an exit-130 "runner crash" with a truncated run log
  // and no failure report. A timeout consumed the whole time budget and may
  // have left its body fiber abandoned mid-teardown; it must be reported
  // immediately, exactly once.
  const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-timeout-"));
  try {
    await writeFile(
      resolve(root, "timeout.test.ts"),
      `
        import { it } from ${JSON.stringify(apiUrl)};
        it(
          "sleeps past its timeout",
          () => new Promise((r) => setTimeout(r, 60_000)),
          { timeout: 300 },
        );
      `,
    );

    const started = Date.now();
    // NOTE: no --retry flag — the DEFAULT retry (2) must not re-run timeouts.
    const child = Bun.spawn(
      [process.execPath, cli, root, "--concurrency", "1"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;
    const elapsed = Date.now() - started;

    // A clean per-test failure — not a dead runner.
    expect(exitCode).toBe(1);
    expect(output).toContain("timed out after 300ms");
    expect(output).toContain("Tests: 1 failed");
    // Exactly one attempt: no retry marker anywhere.
    expect(output).not.toContain("retried");
    expect(output).not.toContain("attempt 1 failed");
    // One 300ms attempt, not three — generous bound that still catches the
    // (1 + retries) wall-clock multiplication if it regresses.
    expect(elapsed).toBeLessThan(15_000);

    // The failure made it into the run log (it used to be lost when the
    // multiplied retries outlived the external wall clock).
    const log = await readRunLog(root);
    expect(log).toContain("timed out after 300ms");
    expect(log).toContain("Tests: 1 failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("still retries ordinary failures and streams each failed attempt", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-retry-"));
  try {
    await writeFile(
      resolve(root, "flaky.test.ts"),
      `
        import { it } from ${JSON.stringify(apiUrl)};
        let attempts = 0;
        it("always fails", () => {
          attempts++;
          throw new Error("ordinary-failure attempt " + attempts);
        });
      `,
    );

    const child = Bun.spawn(
      [process.execPath, cli, root, "--concurrency", "1"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).toBe(1);
    // Default retry (2) still applies to non-timeout failures...
    expect(output).toContain("[retried x2]");
    expect(output).toContain("ordinary-failure attempt 3");
    // ...and each failed attempt is announced BEFORE its retry runs, so a
    // killed run still has the earlier attempts' errors on record.
    expect(output).toContain("attempt 1 failed");
    expect(output).toContain("attempt 2 failed");
    const log = await readRunLog(root);
    expect(log).toContain("attempt 1 failed");
    expect(log).toContain("ordinary-failure attempt 1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("an externally-killed run leaves an attributed trailer in the log", async () => {
  // Regression: SIGTERM/SIGINT (Ctrl+C, `timeout N`, CI kill) interrupts the
  // main fiber and exits 130 — the run log used to just STOP after
  // `running N tests...`, with no record of what was in flight.
  const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-killed-"));
  try {
    await writeFile(
      resolve(root, "slow.test.ts"),
      `
        import { it } from ${JSON.stringify(apiUrl)};
        it(
          "very slow test",
          () => new Promise((r) => setTimeout(r, 60_000)),
          { timeout: 120_000 },
        );
      `,
    );

    const child = Bun.spawn(
      [process.execPath, cli, root, "--concurrency", "1"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    try {
      // Wait until the run is actually executing (RunStart reached the log),
      // then kill it the way a wall clock would.
      const deadline = Date.now() + 15_000;
      let started = false;
      while (Date.now() < deadline && !started) {
        started = (await readRunLog(root)).includes("running 1 tests");
        if (!started) await new Promise((r) => setTimeout(r, 200));
      }
      expect(started).toBe(true);

      child.kill("SIGTERM");
      const exitCode = await child.exited;
      // Signal semantics preserved: interruption still exits 130 —
      expect(exitCode).toBe(130);
      // — but the log now records the kill and what was running.
      const log = await readRunLog(root);
      expect(log).toContain("RUN INTERRUPTED");
      expect(log).toContain("very slow test");
    } finally {
      child.kill();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Concatenated contents of every per-run log under the given run root. */
const readRunLog = async (root: string): Promise<string> => {
  const { readdir, readFile } = await import("node:fs/promises");
  const logDir = resolve(root, ".alchemy", "log", "test");
  const entries = await readdir(logDir).catch(() => [] as string[]);
  const contents = await Promise.all(
    entries.map((entry) =>
      readFile(resolve(logDir, entry), "utf8").catch(() => ""),
    ),
  );
  return contents.join("\n");
};

it("fails the process for every hook kind and preserves hook output", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "alchemy-test-hooks-"));
  try {
    await Promise.all([
      writeFile(
        resolve(root, "before-all.test.ts"),
        fixture("beforeAll", 'it("body", () => {});'),
      ),
      writeFile(
        resolve(root, "before-each.test.ts"),
        fixture("beforeEach", 'it("body", () => {});'),
      ),
      writeFile(
        resolve(root, "after-each.test.ts"),
        fixture(
          "afterEach",
          'it.fails("expected body failure", () => { throw new Error("expected-body-failure"); });',
        ),
      ),
      writeFile(
        resolve(root, "after-all.test.ts"),
        fixture("afterAll", 'it("body", () => {});'),
      ),
    ]);

    const child = Bun.spawn(
      [process.execPath, cli, root, "--retry", "0", "--concurrency", "1"],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(exitCode).toBe(1);
    expect(output).toContain("beforeAll hook failed:");
    expect(output).toContain("beforeEach hook failed:");
    expect(output).toContain("afterEach hook failed:");
    expect(output).toContain("afterAll hook failed:");
    expect(output).toContain("Tests: 4 failed | 1 passed");
    for (const hook of ["beforeAll", "beforeEach", "afterEach", "afterAll"]) {
      expect(output).toContain(`${hook}-captured-output`);
      expect(output).toContain(`${hook}-sentinel`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
