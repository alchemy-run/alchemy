import { describe, expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import WorkspaceStack, { providers, state } from "./fixtures/workspace/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers, state });
const stack = beforeAll(deploy(WorkspaceStack), { timeout: 1_200_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(WorkspaceStack), { timeout: 600_000 });

const options = { tags: ["live", "provider:cloudflare"], timeout: 600_000 };

interface Exec {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

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
        Effect.timeout("300 seconds"),
        Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 4 }),
      );
  });

const exec = (session: string, command: string) => call<Exec>("exec", { session, command });
const history = (session: string) => call<ReadonlyArray<string>>("history", { session });

describe.sequential("Sandbox.Workspace on Cloudflare Containers", () => {
  test(
    "an open runs commands at once on one mount, and the next open sees them",
    Effect.gen(function* () {
      yield* call("delete", { session: "s1" }).pipe(Effect.ignore);
      const both = yield* call<Exec>("parallel", { session: "s1" });
      expect(both.exitCode, both.stderr).toBe(0);
      expect(both.stdout.split("\n").slice(0, 3)).toEqual(["a", "b", "base"]);
      const after = yield* history("s1");

      const again = yield* exec("s1", "cat a.txt && df -T . | tail -1");
      expect(again.exitCode, again.stderr).toBe(0);
      expect(again.stdout).toContain("a");
      console.log(`mounted as: ${again.stdout.split("\n")[1]}`);
      expect((yield* history("s1")).length).toBe(after.length + 1);
    }),
    options,
  );

  test(
    "an open that fails still snapshots what it wrote",
    Effect.gen(function* () {
      expect(yield* call<string>("fail", { session: "s1" })).toBe("failed");
      const read = yield* exec("s1", "cat failed.txt");
      expect(read.stdout.trim()).toBe("written-before-failing");
    }),
    options,
  );

  test(
    "overlapping opens share one mount and one snapshot",
    Effect.gen(function* () {
      const before = (yield* history("s1")).length;
      yield* call("overlap", { session: "s1" });
      expect((yield* history("s1")).length).toBe(before + 1);
      const read = yield* exec("s1", "cat overlap-1.txt overlap-2.txt");
      expect(read.stdout.split("\n").slice(0, 2)).toEqual(["1", "2"]);
    }),
    options,
  );

  test(
    "a fork is isolated, and undo goes back one open",
    Effect.gen(function* () {
      yield* call("delete", { session: "s2" }).pipe(Effect.ignore);
      yield* call("fork", { session: "s2", from: "s1" });
      yield* exec("s2", "echo fork > only-in-fork.txt");
      const source = yield* exec("s1", "ls only-in-fork.txt");
      expect(source.exitCode).not.toBe(0);

      yield* exec("s2", "echo undone > undone.txt");
      yield* call("undo", { session: "s2" });
      const undone = yield* exec("s2", "cat only-in-fork.txt && ! ls undone.txt");
      expect(undone.exitCode, undone.stdout + undone.stderr).toBe(0);
    }),
    options,
  );

  test(
    "a deleted session starts again from the base",
    Effect.gen(function* () {
      yield* call("delete", { session: "s2" });
      const fresh = yield* exec("s2", "ls");
      expect(fresh.stdout).toContain("motd");
      expect(fresh.stdout).not.toContain("only-in-fork.txt");
    }),
    options,
  );
});
