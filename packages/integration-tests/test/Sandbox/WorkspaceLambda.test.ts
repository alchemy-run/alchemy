import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import LambdaWorkspaceStack, { providers, state } from "./fixtures/workspace-lambda/stack.ts";

// Lambda MicroVMs are in preview: run with LAMBDA_TEST_MICROVM=1 on an account that has them.
const skip = !process.env.LAMBDA_TEST_MICROVM;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });

interface Exec {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const options = { tags: ["live", "provider:cloudflare", "provider:aws"], timeout: 900_000 };

describe.skipIf(skip).sequential("Sandbox.Workspace with Lambda MicroVM machines", () => {
  const stack = beforeAll(deploy(LambdaWorkspaceStack), { timeout: 1_800_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(LambdaWorkspaceStack), {
    timeout: 1_500_000,
  });

  const call = <A>(op: string, body: Record<string, string>) =>
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
          Effect.timeout("600 seconds"),
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 4 }),
        );
    });

  test(
    "a session on a MicroVM mounts, runs commands at once, and keeps what they wrote",
    Effect.gen(function* () {
      yield* call("delete", { session: "m1" }).pipe(Effect.ignore);
      const both = yield* call<Exec>("parallel", { session: "m1" });
      expect(both.exitCode, both.stderr).toBe(0);
      expect(both.stdout.split("\n").slice(0, 3)).toEqual(["a", "b", "base"]);
      const again = yield* call<Exec>("open", {
        session: "m1",
        command: "cat a.txt && df -T . | tail -1",
      });
      expect(again.exitCode, again.stderr).toBe(0);
      console.log(`mounted on a MicroVM as: ${again.stdout.split("\n")[1]}`);
      expect((yield* call<ReadonlyArray<string>>("history", { session: "m1" })).length).toBe(3);
    }),
    options,
  );

  test(
    "fsync on a MicroVM, with the journal in the session's Durable Object (timed)",
    Effect.gen(function* () {
      const script = [
        "const fs = require('fs');",
        "const times = [];",
        "for (let i = 0; i < 10; i++) {",
        "  const fd = fs.openSync('fsync.bin', 'w');",
        "  fs.writeSync(fd, Buffer.alloc(4096, i));",
        "  const t = process.hrtime.bigint(); fs.fsyncSync(fd); times.push(Number(process.hrtime.bigint() - t) / 1e6);",
        "  fs.closeSync(fd);",
        "}",
        "times.sort((a, b) => a - b);",
        "console.log(JSON.stringify({ p50: times[5], p90: times[9] }));",
      ].join(" ");
      // In an open: a command on a fork has nothing to make durable.
      const run = yield* call<Exec>("open", {
        session: "m1",
        command: `node -e ${JSON.stringify(script)}`,
      });
      expect(run.exitCode, run.stderr).toBe(0);
      console.log(`fsync on a Lambda MicroVM (ms): ${run.stdout.trim()}`);
    }),
    options,
  );

  interface Forked extends Exec {
    readonly changes: {
      readonly status: string;
      readonly paths: ReadonlyArray<string>;
      readonly fork?: string;
    };
    readonly stopped?: ReadonlyArray<{ readonly command: string }>;
  }

  test(
    "commands on forks of one session run at once on ext4, and the ones that collide are refused",
    Effect.gen(function* () {
      const started = Date.now();
      const results = yield* call<ReadonlyArray<Forked>>("fanout", {
        session: "m1",
        commands: JSON.stringify([
          "echo 1 > x-1.txt && sleep 2",
          "echo 2 > x-2.txt && sleep 2",
          "sleep 2 && echo left > same.txt",
          "sleep 2 && echo right > same.txt",
        ]),
      });
      console.log(`4 commands on forks of one session on MicroVMs: ${Date.now() - started} ms`);
      expect(results.slice(0, 2).map((r) => r.changes.status)).toEqual(["applied", "applied"]);
      const same = results
        .slice(2)
        .map((r) => r.changes.status)
        .sort();
      expect(same).toEqual(["applied", "conflict"]);
      const read = yield* call<Exec>("exec", {
        session: "m1",
        command: "cat x-1.txt x-2.txt same.txt",
      });
      expect(read.stdout.trim().split("\n").slice(0, 2)).toEqual(["1", "2"]);
    }),
    options,
  );

  test(
    "a command that leaves a process running keeps its MicroVM for the session's next commands",
    Effect.gen(function* () {
      yield* call("delete", { session: "m2" }).pipe(Effect.ignore);
      const started = yield* call<Forked>("exec", {
        session: "m2",
        command:
          "(setsid sh -c 'for i in 1 2 3 4 5 6; do echo $i >> bg.log; sleep 1; done' < /dev/null > /dev/null 2>&1 &); echo ok",
      });
      expect(started.stopped).toBeUndefined();
      yield* Effect.sleep("2 seconds");
      const midway = yield* call<Exec>("exec", { session: "m2", command: "wc -l < bg.log" });
      expect(Number(midway.stdout.trim())).toBeGreaterThan(0);
      yield* Effect.sleep("15 seconds");
      const after = yield* call<Exec>("exec", { session: "m2", command: "wc -l < bg.log" });
      expect(after.stdout.trim()).toBe("6");
    }),
    options,
  );
});
