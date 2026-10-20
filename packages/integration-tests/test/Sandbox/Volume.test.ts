import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import VolumeStack, { providers, state } from "./fixtures/volume/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });
const stack = beforeAll(deploy(VolumeStack), { timeout: 1_200_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(VolumeStack), { timeout: 600_000 });

const options = { tags: ["live", "provider:cloudflare"], timeout: 600_000 };

interface Exec {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const call = <A>(op: string, body: Record<string, string> = {}) =>
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
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 6 }),
      );
  });

const exec = (head: string, command: string) => call<Exec>("exec", { head, command });

/** `blockd exec` reports its attach mode on stderr. */
const modeOf = (run: Exec) => /"mode":"(\w+)"/.exec(run.stderr)?.[1];

describe.sequential("Sandbox.Volume on R2, mounted on a Cloudflare Container", () => {
  test(
    "a session forks from the base, and each command sees the last",
    Effect.gen(function* () {
      yield* call("start");
      yield* call("drop", { head: "s1" }).pipe(Effect.ignore);
      yield* call("fork", { to: "s1" });
      const motd = yield* exec("s1", "cat motd");
      expect(motd.exitCode, motd.stderr).toBe(0);
      expect(motd.stdout.trim()).toBe("base");
      console.log(`attach mode on Cloudflare Containers: ${modeOf(motd)}`);

      const write = yield* exec("s1", "echo hi > a.txt && mkdir -p src && seq 1 1000 > src/n.txt");
      expect(write.exitCode, write.stderr).toBe(0);
      const read = yield* exec("s1", "cat a.txt && wc -l < src/n.txt");
      expect(read.stdout.split("\n").map((l) => l.trim())).toEqual(["hi", "1000", ""]);
    }),
    options,
  );

  test(
    "a fork is isolated from its source",
    Effect.gen(function* () {
      yield* call("drop", { head: "s2" }).pipe(Effect.ignore);
      yield* call("fork", { to: "s2", from: "s1" });
      expect((yield* exec("s2", "cat a.txt && echo two > b.txt")).stdout.trim()).toBe("hi");
      expect((yield* exec("s1", "test ! -e b.txt")).exitCode).toBe(0);
      expect((yield* exec("s2", "cat b.txt")).stdout.trim()).toBe("two");
    }),
    options,
  );

  test(
    "history has a snapshot per command, and reset rewinds",
    Effect.gen(function* () {
      const history = yield* call<string[]>("history", { head: "s1" });
      expect(history.length).toBeGreaterThanOrEqual(2);
      // the oldest snapshot is the base: before a.txt existed
      yield* call("reset", { head: "s1", snapshot: history[history.length - 1]! });
      expect((yield* exec("s1", "test ! -e a.txt && cat motd")).stdout.trim()).toBe("base");
    }),
    options,
  );

  test(
    "a dropped head is gone",
    Effect.gen(function* () {
      yield* call("drop", { head: "s2" });
      expect(yield* call("head", { head: "s2" })).toBeNull();
      yield* call("stop");
    }),
    options,
  );
});
