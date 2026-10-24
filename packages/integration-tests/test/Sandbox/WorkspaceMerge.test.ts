import { describe, expect } from "@alchemy.run/test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import MergeWorkspaceStack, { providers, state } from "./fixtures/workspace-merge/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });
const stack = beforeAll(deploy(MergeWorkspaceStack), { timeout: 1_200_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(MergeWorkspaceStack), { timeout: 600_000 });

const options = { tags: ["live", "provider:cloudflare"], timeout: 600_000 };

type Changes =
  | {
      readonly status: "applied";
      readonly snapshot?: string;
      readonly paths: ReadonlyArray<string>;
    }
  | { readonly status: "conflict"; readonly paths: ReadonlyArray<string>; readonly fork?: string };

interface Result {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly changes: Changes;
  readonly stopped?: ReadonlyArray<{ readonly command: string }>;
  readonly timings?: Readonly<Record<string, number>>;
}

/** One line per command: where its time went. */
const logTimings = (label: string, results: ReadonlyArray<Result & { ms: number }>) =>
  Effect.sync(() => {
    for (const result of results) {
      console.log(`${label} ${result.ms} ms: ${JSON.stringify(result.timings ?? {})}`);
    }
  });

const call = <A>(op: string, body: Record<string, unknown>) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(
        HttpClientRequest.post(new URL(op, url)).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
      )
      .pipe(
        Effect.flatMap((r) =>
          r.status !== 200
            ? r.text.pipe(
                Effect.flatMap((text) => Effect.fail(new Error(`${op} ${r.status}: ${text}`))),
              )
            : Effect.map(r.json, (json) => (json as { result: A }).result),
        ),
        Effect.timeout("300 seconds"),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 4 }),
      );
  });

const exec = (session: string, command: string) => call<Result>("exec", { session, command });
const parallel = (session: string, commands: ReadonlyArray<string>) =>
  call<{ results: ReadonlyArray<Result & { ms: number }>; ms: number }>("parallel", {
    session,
    commands,
  });

describe.sequential("Sandbox.Workspace with commands on forks (btrfs, automatic)", () => {
  test(
    "commands of one session run at once on forks, and each one's changes land",
    Effect.gen(function* () {
      yield* call("delete", { session: "p1" }).pipe(Effect.ignore);
      // Cold: the first commands start machines.
      const cold = yield* parallel(
        "p1",
        [1, 2, 3, 4].map((n) => `echo ${n} > f-${n}.txt && sleep 3`),
      );
      for (const result of cold.results) {
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.changes.status).toBe("applied");
      }
      // Warm: the same four again, on machines the pool kept.
      const warm = yield* parallel(
        "p1",
        [1, 2, 3, 4].map((n) => `echo ${n}${n} > g-${n}.txt && sleep 3`),
      );
      for (const result of warm.results) expect(result.changes.status).toBe("applied");
      yield* logTimings("cold", cold.results);
      yield* logTimings("warm", warm.results);
      expect(warm.results[0]!.timings?.claim).toBeTypeOf("number");
      expect(warm.results[0]!.timings?.["blockd.run"]).toBeGreaterThan(2_900);
      console.log(
        `4 commands of 3 s each, at once: cold ${cold.ms} ms, warm ${warm.ms} ms; warm per command: ${warm.results.map((r) => r.ms).join(", ")} ms`,
      );
      // At once, not one after the other: their machine time overlapped.
      const machineTime = warm.results.reduce((sum, r) => sum + (r.timings?.machine ?? 0), 0);
      expect(warm.ms).toBeLessThan(machineTime);
      const read = yield* exec("p1", "cat f-1.txt f-2.txt f-3.txt f-4.txt g-4.txt");
      expect(read.stdout.trim().split("\n")).toEqual(["1", "2", "3", "4", "44"]);
      const noop = yield* exec("p1", "true");
      console.log(`one warm command that changes nothing: ${JSON.stringify(noop.changes)}`);
    }),
    options,
  );

  test(
    "two commands that change one file: one lands, the other is refused whole and kept as a fork",
    Effect.gen(function* () {
      const both = yield* parallel("p1", [
        "sleep 2; echo one > src/shared.txt; echo also-one > one.txt",
        "sleep 2; echo two > src/shared.txt; echo also-two > two.txt",
      ]);
      const applied = both.results.filter((r) => r.changes.status === "applied");
      const refused = both.results.filter((r) => r.changes.status === "conflict");
      expect(applied.length).toBe(1);
      expect(refused.length).toBe(1);
      const conflict = refused[0]!.changes as Extract<Changes, { status: "conflict" }>;
      expect(conflict.paths).toEqual(["src/shared.txt"]);
      expect(conflict.fork).toBeDefined();
      const head = yield* exec("p1", "cat src/shared.txt; ls one.txt two.txt 2>/dev/null");
      const landed = head.stdout.split("\n")[0];
      expect(["one", "two"]).toContain(landed);
      // The refused command's other change didn't land either: all or nothing.
      const loser = landed === "one" ? "two" : "one";
      expect(head.stdout).not.toContain(`${loser}.txt`);
      // Its version is a session of its own.
      const kept = yield* exec(conflict.fork!, `cat src/shared.txt ${loser}.txt`);
      expect(kept.stdout.trim().split("\n")).toEqual([loser, `also-${loser}`]);
    }),
    options,
  );

  test(
    "build output's newest change wins instead of conflicting",
    Effect.gen(function* () {
      const both = yield* parallel("p1", [
        "mkdir -p dist && sleep 2 && echo a > dist/out.js",
        "mkdir -p dist && sleep 2 && echo b > dist/out.js",
      ]);
      for (const result of both.results) expect(result.changes.status).toBe("applied");
      const read = yield* exec("p1", "cat dist/out.js");
      expect(["a", "b"]).toContain(read.stdout.trim());
    }),
    options,
  );

  test(
    "a command that leaves a process running keeps its machine, and later commands see what it writes",
    Effect.gen(function* () {
      yield* call("delete", { session: "h1" }).pipe(Effect.ignore);
      const started = yield* exec(
        "h1",
        "(setsid sh -c 'for i in $(seq 1 12); do echo line$i >> run.log; sleep 1; done' < /dev/null > /dev/null 2>&1 &); echo started",
      );
      expect(started.stdout.trim()).toBe("started");
      expect(started.stopped).toBeUndefined();
      yield* Effect.sleep("3 seconds");
      const midway = yield* exec("h1", "wc -l < run.log");
      const lines = Number(midway.stdout.trim());
      expect(lines).toBeGreaterThan(0);
      expect(lines).toBeLessThan(12);
      // What it wrote reaches the head while it runs: a merge from another session sees it.
      yield* Effect.sleep("14 seconds");
      const finished = yield* exec("h1", "wc -l < run.log");
      expect(Number(finished.stdout.trim())).toBe(12);
      // Its process is done: the host ends, and a fork of the head has the whole file.
      yield* Effect.sleep("8 seconds");
      const after = yield* exec("h1", "wc -l < run.log; echo after > after.txt");
      expect(after.stdout.trim()).toBe("12");
      expect(after.changes.status).toBe("applied");
    }),
    options,
  );

  test(
    "merge brings one session's changes into another, file by file",
    Effect.gen(function* () {
      yield* call("delete", { session: "m1" }).pipe(Effect.ignore);
      yield* call("delete", { session: "m2" }).pipe(Effect.ignore);
      yield* exec("m1", "echo keep > keep.txt");
      yield* call("fork", { session: "m2", from: "m1" });
      yield* exec("m2", "echo theirs > from-fork.txt");
      yield* exec("m1", "echo ours > mine.txt");
      const merged = yield* call<Changes>("merge", { session: "m1", from: "m2" });
      expect(merged.status).toBe("applied");
      expect(merged.paths).toEqual(["from-fork.txt"]);
      const read = yield* exec("m1", "cat from-fork.txt mine.txt keep.txt");
      expect(read.stdout.trim().split("\n")).toEqual(["theirs", "ours", "keep"]);

      yield* exec("m2", "echo a > keep.txt");
      yield* exec("m1", "echo b > keep.txt");
      const clash = yield* call<Changes>("merge", { session: "m1", from: "m2" });
      expect(clash).toEqual({ status: "conflict", paths: ["keep.txt"] });
      expect((yield* exec("m1", "cat keep.txt")).stdout.trim()).toBe("b");
    }),
    options,
  );

  test(
    "an open still mounts the session on one machine",
    Effect.gen(function* () {
      const opened = yield* call<{ stdout: string }>("open", {
        session: "m1",
        command: "cat from-fork.txt && df -T . | tail -1",
      });
      expect(opened.stdout).toContain("theirs");
      expect(opened.stdout).toContain("btrfs");
    }),
    options,
  );
});
