import * as Archil from "@/Archil";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ArchilWorkspaceWorker from "./fixtures/workspace-worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), Archil.providers()),
});

const hasArchil = !!process.env.ARCHIL_API_KEY;

class NotReady extends Data.TaggedError("NotReady")<{ body: string }> {}

/**
 * Parse a route as JSON, retrying through workers.dev placeholder responses
 * (which serve 200 HTML before the deploy propagates) by asserting on the
 * parsed shape rather than the status code.
 */
const fetchJson = <A>(url: string, ready: (value: A) => boolean) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    const text = yield* res.text;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as A,
      catch: () => new NotReady({ body: text.slice(0, 200) }),
    });
    if (!ready(parsed)) {
      return yield* new NotReady({ body: text.slice(0, 200) });
    }
    return parsed;
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("1 second", 1.5),
      times: 10,
    }),
  );

const isExec = (v: Archil.ExecResult) => typeof v.exitCode === "number";

test.provider.skipIf(!hasArchil)(
  "each Durable Object instance owns its own Archil disk",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { url } = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* ArchilWorkspaceWorker;
          return { url: worker.url.as<string>() };
        }),
      );

      // Two users → two DO instances → two disks, provisioned on first touch.
      // Each appends one line to its own log, so the line counts stay
      // independent no matter how the requests interleave.
      const alice = yield* fetchJson<Archil.ExecResult>(
        `${url}/run?user=alice`,
        isExec,
      );
      expect(alice.exitCode).toBe(0);
      expect(alice.stdout.trim()).toBe("1");

      const bob = yield* fetchJson<Archil.ExecResult>(
        `${url}/run?user=bob`,
        isExec,
      );
      expect(bob.exitCode).toBe(0);
      expect(bob.stdout.trim()).toBe("1");

      // Alice writes again — her disk advances, Bob's is untouched.
      const aliceAgain = yield* fetchJson<Archil.ExecResult>(
        `${url}/run?user=alice`,
        isExec,
      );
      expect(aliceAgain.stdout.trim()).toBe("2");

      // The shared deploy-time disk is reachable from inside the DO through
      // the statically-bound `Archil.Exec` capability.
      const template = yield* fetchJson<Archil.ExecResult>(
        `${url}/template?user=alice`,
        isExec,
      );
      expect(template.exitCode).toBe(0);

      // Per-instance search sees only that instance's own writes.
      const search = yield* fetchJson<Archil.GrepResult>(
        `${url}/search?user=alice`,
        (r) => Array.isArray(r.matches) && r.matches.length > 0,
      );
      expect(search.matches.some((m) => m.file.includes("log.txt"))).toBe(true);

      // Runtime-created disks are application data, not stack state, so the
      // workspaces must be torn down explicitly or they outlive the stack.
      for (const user of ["alice", "bob"]) {
        const destroyed = yield* fetchJson<{ destroyed: boolean }>(
          `${url}/destroy?user=${user}`,
          (v) => v.destroyed === true,
        );
        expect(destroyed.destroyed).toBe(true);
      }

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
