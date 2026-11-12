import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Cluster from "@alchemy.run/effect-cluster";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { DATABASE_URL, RUNNER_DIR } from "./fixtures/process/cluster.ts";
import GreeterLive from "./fixtures/process/greeter-live.ts";

const testOptions = { providers: Cluster.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const stack = Core.scratchStack(testOptions, "ClusterProcess", import.meta.url);

/** `runner.env` as a map, unquoting each value. */
const readEnv = () =>
  Object.fromEntries(
    fs
      .readFileSync(path.join(RUNNER_DIR, "runner.env"), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 2, -1).replace(/\\(.)/g, "$1")];
      }),
  );

// A pool of plain processes: the deploy writes the runner and its
// environment for the host's process manager, and declares nothing else.
describe("Effect Cluster as plain processes", { tags: ["provider:cluster", "local"] }, () => {
  beforeAll(
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(Effect.void.pipe(Effect.provide(GreeterLive)));
    }),
    { timeout: 300_000 },
  );

  afterAll(stack.destroy(), { timeout: 120_000 });

  test(
    "writes the runner program",
    Effect.sync(() => {
      const runner = fs.readFileSync(path.join(RUNNER_DIR, "runner.mjs"), "utf8");
      expect(runner.length).toBeGreaterThan(0);
    }),
  );

  test(
    "writes the environment every runner needs, readable by its owner only",
    Effect.sync(() => {
      const mode = fs.statSync(path.join(RUNNER_DIR, "runner.env")).mode & 0o777;
      expect(mode).toBe(0o600);
      const env = readEnv();
      expect(env.CLUSTER_DATABASE_URL).toBe(DATABASE_URL);
      expect(env.CLUSTER_GATEWAY_TOKEN?.length).toBeGreaterThan(0);
      expect(env.CLUSTER_SHARD_GROUPS).toMatch(/^alchemy:/);
      expect(env.ALCHEMY_PHASE).toBe("runtime");
    }),
  );

  // Needs a Postgres the runner can reach: CLUSTER_PROCESS_DATABASE_URL.
  test.skipIf(!process.env.CLUSTER_PROCESS_DATABASE_URL)(
    "a runner started from those files hosts the entity and serves the gateway",
    Effect.gen(function* () {
      const output: string[] = [];
      const runner = spawn("node", [path.join(RUNNER_DIR, "runner.mjs")], {
        env: { ...process.env, ...readEnv() },
        stdio: ["ignore", "pipe", "pipe"],
      });
      runner.stdout.on("data", (chunk) => output.push(String(chunk)));
      runner.stderr.on("data", (chunk) => output.push(String(chunk)));
      yield* Effect.addFinalizer(() => Effect.sync(() => runner.kill("SIGTERM")));
      const health = yield* Effect.tryPromise(() =>
        fetch("http://127.0.0.1:34500/health").then((response) => response.text()),
      ).pipe(Effect.retry({ times: 60, schedule: Schedule.spaced("500 millis") }));
      expect(health).toBe("ok");
      expect(output.join("")).toMatch(/Effect Cluster runner .*: Greeter/);
    }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );
});
