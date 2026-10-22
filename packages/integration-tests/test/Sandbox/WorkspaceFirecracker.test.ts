import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import MicroVMWorkspaceStack, { providers, state } from "./fixtures/workspace-firecracker/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });

interface Result {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly changes: { readonly status: string; readonly paths: ReadonlyArray<string> };
  readonly stopped?: ReadonlyArray<{ readonly command: string }>;
  readonly timings?: Readonly<Record<string, number>>;
}

const options = { tags: ["live", "provider:cloudflare", "provider:aws"], timeout: 900_000 };

// A Cloudflare Worker using a workspace whose commands run in Firecracker
// microVMs, on an EC2 spot host with nested virtualization.
describe.skipIf(!!process.env.FAST).sequential("AWS.Workspace: commands in microVMs", () => {
  const stack = beforeAll(deploy(MicroVMWorkspaceStack), { timeout: 2_400_000 });
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(MicroVMWorkspaceStack), {
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
        );
    });

  test(
    "a command runs in a microVM on the image, and the next one sees what it wrote",
    Effect.gen(function* () {
      // The first request waits for the host to come up and set itself up.
      const first = yield* call<Result>("exec", {
        session: "s1",
        command: "cat motd; uname -r | cut -c1-3; node --version | cut -c1-3; echo one > a.txt",
      }).pipe(Effect.retry({ schedule: Schedule.spaced("15 seconds"), times: 40 }));
      expect(first.exitCode, first.stderr).toBe(0);
      // The guest's own kernel, not the host's.
      expect(first.stdout.trim().split("\n")).toEqual(["base", "6.1", "v24"]);
      expect(first.changes).toEqual({ status: "applied", paths: ["a.txt"] });
      console.log(`first command's timings: ${JSON.stringify(first.timings)}`);
      const second = yield* call<Result>("exec", { session: "s1", command: "cat a.txt" });
      expect(second.stdout.trim()).toBe("one");
      console.log(`a warm command's timings: ${JSON.stringify(second.timings)}`);
    }),
    options,
  );

  test(
    "commands at once each get a microVM, and all of them land",
    Effect.gen(function* () {
      const started = Date.now();
      const results = yield* call<ReadonlyArray<Result>>("fanout", {
        session: "s1",
        commands: JSON.stringify([1, 2, 3, 4].map((i) => `echo ${i} > x-${i}.txt && sleep 2`)),
      });
      console.log(`4 commands of 2 s at once in microVMs: ${Date.now() - started} ms`);
      for (const result of results) console.log(`  ${JSON.stringify(result.timings)}`);
      expect(results.map((r) => r.changes.status)).toEqual([
        "applied",
        "applied",
        "applied",
        "applied",
      ]);
      const read = yield* call<Result>("exec", { session: "s1", command: "cat x-*.txt" });
      expect(read.stdout.trim().split("\n")).toEqual(["1", "2", "3", "4"]);
    }),
    options,
  );

  test(
    "a command that leaves a process running keeps its microVM, and later commands see what it writes",
    Effect.gen(function* () {
      const started = yield* call<Result>("exec", {
        session: "s2",
        command:
          "(setsid sh -c 'for i in 1 2 3 4 5 6; do echo $i >> bg.log; sleep 1; done' < /dev/null > /dev/null 2>&1 &); echo ok",
      });
      expect(started.exitCode, started.stderr).toBe(0);
      yield* Effect.sleep("2 seconds");
      const midway = yield* call<Result>("exec", { session: "s2", command: "wc -l < bg.log" });
      expect(Number(midway.stdout.trim())).toBeGreaterThan(0);
      yield* Effect.sleep("12 seconds");
      const after = yield* call<Result>("exec", { session: "s2", command: "wc -l < bg.log" });
      expect(Number(after.stdout.trim())).toBe(6);
    }),
    options,
  );

  test(
    "opening a session says microVMs have no network yet",
    Effect.gen(function* () {
      const opened = yield* Effect.flip(call("open", { session: "s1", command: "true" }));
      expect(String(opened)).toContain(`isn't supported with isolation "firecracker" yet`);
    }),
    options,
  );
});
