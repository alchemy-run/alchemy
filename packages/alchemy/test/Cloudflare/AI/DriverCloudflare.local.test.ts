/**
 * The Cloudflare driver under `alchemy dev` — the LOCAL placement of
 * the session engine, deployed through the same RPC-sidecar topology
 * the real dev command uses. Two claims, split so a failure names its
 * layer:
 *
 * (a) the BASE driver worker (no container) boots locally and serves a
 *     dispatch round end-to-end;
 * (b) a worker whose session DO carries the PER-SESSION CONTAINER
 *     attachment ({@link Cloudflare.AI.SessionContainerImage} — the
 *     alchemy-org topology) still boots and serves: the attachment
 *     must never wedge the worker's own startup, even while the
 *     container image is built/started lazily.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { SandboxContainerRuntime } from "@/Cloudflare/AI/SandboxContainerRuntime.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import DriverContainerTestWorker from "./fixtures/DriverContainerWorker.ts";
import DriverTestWorker from "./fixtures/DriverWorker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
  body: string;
}> {}

/** GET until 200 (bounded) — a fresh dev worker warms up on first serve. */
const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(new WorkerNotReady({ status: 0, body: "timeout" })),
      }),
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : res.text.pipe(
              Effect.flatMap((body) =>
                Effect.fail(new WorkerNotReady({ status: res.status, body })),
              ),
            ),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(8),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

test.provider(
  "(a) the driver worker serves a dispatch round locally",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DriverTestWorker;
          return { url: worker.url };
        }),
      );
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      const body = (yield* getJsonReady(
        `${deployed.url}/dispatch?input=hello&key=local-a`,
      )) as { answer?: unknown; error?: string };
      expect(body.error).toBeUndefined();
      expect(body.answer).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "(b) a session-container attachment does not wedge the worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DriverContainerTestWorker;
          return { url: worker.url };
        }).pipe(
          // the sandbox image guest: builds the (slim) image and deploys
          // the container application, exactly as alchemy-org's stack does
          Effect.provide(SandboxContainerRuntime),
        ),
      );
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);

      // plain fetch first: the worker must serve even though its session
      // DO class carries a container attachment
      const health = (yield* getJsonReady(`${deployed.url}/health`)) as {
        ok: boolean;
      };
      expect(health.ok).toBe(true);

      // and a full dispatch round (admits a session DO — whose class has
      // the container attached — without any tool touching the sandbox)
      const body = (yield* getJsonReady(
        `${deployed.url}/dispatch?input=hello&key=local-b`,
      )) as { answer?: unknown; error?: string };
      expect(body.error).toBeUndefined();
      expect(body.answer).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "(c) a session tool EXECS on its own container (the org's toolbox path)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DriverContainerTestWorker;
          return { url: worker.url };
        }).pipe(Effect.provide(SandboxContainerRuntime)),
      );

      // the Machinist's probe tool runs on the session's OWN container,
      // started on first use — this is exactly where the org's review
      // sessions stall if the call-time container path is broken
      const body = (yield* getJsonReady(
        `${deployed.url}/exec?input=${encodeURIComponent("call:probe:echo hello-from-container")}&key=local-c`,
      )) as {
        answer?: { stdout?: string; exitCode?: number };
        error?: string;
      };
      expect(body.error).toBeUndefined();
      expect(body.answer?.exitCode).toBe(0);
      expect(body.answer?.stdout).toBe("hello-from-container");

      // NETWORK through the container (the org checkout's shape: git
      // against github.com through the dev egress machinery)
      const network = (yield* getJsonReady(
        `${deployed.url}/exec?input=${encodeURIComponent("call:probe:git ls-remote https://github.com/alchemy-run/test-alchemy.git HEAD")}&key=local-c-net`,
      )) as {
        answer?: { stdout?: string; exitCode?: number };
        error?: string;
      };
      expect(network.error).toBeUndefined();
      expect(network.answer?.exitCode).toBe(0);
      expect(network.answer?.stdout).toContain("HEAD");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

/** GET with a hard deadline — a hang IS the failure, named. */
const getJsonWithin = (url: string, within: Duration.Input) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    return yield* res.json;
  }).pipe(
    Effect.timeoutOrElse({
      duration: within,
      orElse: () =>
        Effect.die(new Error(`${url} did not answer within ${String(within)}`)),
    }),
    Effect.orDie,
  );

test.provider(
  "(d) removing a session mid-delegation cuts its round AND the child's, and answers",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DriverTestWorker;
          return { url: worker.url };
        }),
      );
      const url = deployed.url;

      // the org's shape at delete time: the Supervisor's round is
      // parked inside its dispatch tool, waiting on a child DO whose
      // own round is parked inside a tool handler that never answers
      yield* getJsonReady(
        `${url}/send?agent=Supervisor&key=parent-d&input=${encodeURIComponent(
          "call:session:call:stall:the suite",
        )}`,
      );
      yield* Effect.sleep("3 seconds");

      // the eraser must come back — Sessions.remove settles (cutting
      // the round, cascading to the child) and purges
      const removed = yield* getJsonWithin(
        `${url}/remove?agent=Supervisor&key=parent-d`,
        "30 seconds",
      );
      expect(removed).toEqual({ removed: true });

      // the child (a resumable dispatch is keyed under its parent) was
      // settled by the cascade and its stall cut: a late dispatch
      // answers with the settled outcome at once instead of queueing
      // behind a round that never ends
      const late = (yield* getJsonWithin(
        `${url}/dispatch?agent=Scribe&key=${encodeURIComponent("parent-d/Scribe/s1")}&input=hello`,
        "30 seconds",
      )) as { answer?: unknown; error?: string };
      expect(late.error).toBeUndefined();
      expect(late.answer).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "(e) the org's delete: erasing a charter mid-DIRECT-dispatch, then the session it dispatched",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DriverTestWorker;
          return { url: worker.url };
        }),
      );
      const url = deployed.url;

      // alchemy-org's thread→engineer shape: the Supervisor's OWN tool
      // dispatches the Scribe directly (no registered child, so no
      // cascade), and is parked on it while the Scribe's round is
      // parked in a tool that never answers
      yield* getJsonReady(
        `${url}/send?agent=Supervisor&key=parent-e&input=${encodeURIComponent(
          "call:handoff:call:stall:the suite",
        )}`,
      );
      yield* Effect.sleep("3 seconds");

      // the thread's DELETE: the charter's session first (its round —
      // the handoff mid-flight — is cut), then every session it
      // dispatched, machine spared. Both must answer.
      const removedParent = yield* getJsonWithin(
        `${url}/remove?agent=Supervisor&key=parent-e`,
        "30 seconds",
      );
      expect(removedParent).toEqual({ removed: true });

      const removedChild = yield* getJsonWithin(
        `${url}/remove?agent=Scribe&key=handoff-scribe&machine=false`,
        "30 seconds",
      );
      expect(removedChild).toEqual({ removed: true });

      // both erased: a fresh dispatch to either key admits a NEW
      // session over empty storage (one user message in its thread),
      // not a tombstone and not the stalled round
      const fresh = (yield* getJsonWithin(
        `${url}/dispatch?agent=Scribe&key=handoff-scribe&input=hello`,
        "30 seconds",
      )) as { answer?: string; error?: string };
      expect(fresh.error).toBeUndefined();
      expect(JSON.parse(fresh.answer!)).toMatchObject({ users: 1, tools: 0 });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
