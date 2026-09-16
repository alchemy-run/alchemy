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
  "(a2) the agent as an object over the DO: at(key), methods, typed failures, stop/destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* DriverTestWorker;
          return { url: worker.url };
        }),
      );
      const ledger = (query: string) =>
        getJsonReady(
          `${deployed.url}/ledger?key=acct-1&${query}`,
        ) as Effect.Effect<{
          value?: unknown;
          failure?: { _tag?: string; balance?: number; requested?: number };
          error?: string;
        }>;

      // a viewer on the session's socket — like `/thread/:id`, it never
      // subscribes: live frames only, so the object's `publish` is what
      // it hears
      expect(deployed.url).toMatch(/^http:\/\/localhost:\d+$/);
      const wsBase = String(deployed.url).replace(/^http/, "ws");
      const viewer = yield* Effect.acquireRelease(
        Effect.callback<
          { readonly states: Array<unknown>; readonly socket: WebSocket },
          Error
        >((resume) => {
          const socket = new WebSocket(`${wsBase}/attach/Ledger/acct-1`);
          const states: Array<unknown> = [];
          socket.addEventListener("message", (event) => {
            const frame = JSON.parse(String(event.data)) as {
              type: string;
              state?: unknown;
            };
            if (frame.type === "state") states.push(frame.state);
          });
          socket.addEventListener("open", () =>
            resume(Effect.succeed({ states, socket })),
          );
          socket.addEventListener("error", () =>
            resume(Effect.fail(new Error("viewer socket failed"))),
          );
        }),
        ({ socket }) => Effect.sync(() => socket.close()),
      );

      // first contact admits the object; a METHOD sets its state
      // (owner, opening balance 10) — the one place a constructor
      // argument would have gone
      const opened = yield* ledger("op=open&owner=ada&opening=10");
      expect(opened.error).toBeUndefined();
      const deposit = yield* ledger("op=deposit&amount=5");
      expect(deposit.error).toBeUndefined();
      expect(deposit.value).toBe(15);
      // the deposit PUBLISHED the balance to the attached viewer
      yield* Effect.succeed(viewer.states).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (states) => states.length > 0,
          times: 50,
        }),
      );
      expect(viewer.states).toEqual([{ balance: 15 }]);
      // a later stub for the same key finds the same object
      const statement = yield* ledger("op=statement");
      expect(statement.value).toEqual({
        key: "acct-1",
        owner: "ada",
        balance: 15,
      });
      // a method's typed failure crosses the wire as a FAILURE
      const overdrawn = yield* ledger("op=withdraw&amount=100");
      expect(overdrawn.error).toBeUndefined();
      expect(overdrawn.failure?._tag).toBe("Overdrawn");
      expect(overdrawn.failure?.balance).toBe(15);
      expect(overdrawn.failure?.requested).toBe(100);
      // an unknown method is a DEFECT, naming the methods that exist
      const missing = yield* ledger("op=nope");
      expect(missing.error).toContain("has no method 'nope'");
      expect(missing.error).toContain("deposit");
      // the loop verbs on the same object — the stance reads the state
      const round = yield* ledger("op=dispatch&input=hello");
      expect(round.error).toBeUndefined();
      expect(round.value).toBeDefined();
      // stopped: the loop is settled, the object still answers
      yield* ledger("op=stop");
      const afterStop = yield* ledger("op=statement");
      expect(afterStop.value).toEqual({
        key: "acct-1",
        owner: "ada",
        balance: 15,
      });
      // destroyed: the next contact constructs FRESH, at the initial state
      yield* ledger("op=destroy");
      const fresh = yield* ledger("op=statement");
      expect(fresh.value).toEqual({ key: "acct-1", owner: null, balance: 0 });

      yield* stack.destroy();
    }).pipe(Effect.scoped, logLevel),
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
      // dispatches the Scribe directly and is parked on it while the
      // Scribe's round is parked in a tool that never answers. The
      // org's delete erases BOTH by name regardless of the cascade —
      // the directory, not the supervisor's RAM, is what it trusts
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

/** Poll a session's transcript until `predicate` holds over its
 *  observation types — bounded, so a hang names itself. */
const historyUntil = (
  url: string | undefined,
  agent: string,
  key: string,
  predicate: (types: ReadonlyArray<string>) => boolean,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(
      `${url}/history?agent=${agent}&key=${encodeURIComponent(key)}`,
    );
    return ((yield* res.json) as { types: Array<string> }).types;
  }).pipe(
    Effect.orDie,
    Effect.repeat({
      schedule: Schedule.spaced("500 millis"),
      until: predicate,
      times: 60,
    }),
  );

test.provider(
  "(f) the operator's STOP on a supervisor cascades over a direct handoff: the child's DO is settled, its stall cut",
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

      // alchemy-org's thread→engineer shape across TWO Durable Objects:
      // the Supervisor's own tool dispatches the Scribe directly and is
      // parked on it; the Scribe's round is parked in a tool that never
      // answers
      yield* getJsonReady(
        `${url}/send?agent=Supervisor&key=parent-f&input=${encodeURIComponent(
          "call:handoff:f|call:stall:the suite",
        )}`,
      );
      yield* historyUntil(url, "Scribe", "handoff-scribe-f", (types) =>
        types.includes("tool-call"),
      );

      // the operator aborts the SUPERVISOR's round (the thread's stop
      // button): the handoff's child was registered from inside the
      // round, so the abort settles it — in its own DO
      const aborted = yield* getJsonWithin(
        `${url}/interrupt?agent=Supervisor&key=parent-f`,
        "30 seconds",
      );
      expect(aborted).toEqual({ interrupted: true });

      const parent = yield* historyUntil(url, "Supervisor", "parent-f", (t) =>
        t.includes("aborted"),
      );
      expect(parent).toContain("aborted");
      expect(parent).not.toContain("crashed");
      const child = yield* historyUntil(
        url,
        "Scribe",
        "handoff-scribe-f",
        (types) => types.includes("settled"),
      );
      expect(child).toContain("settled");
      expect(child).not.toContain("crashed");

      // a settled child is not working: a late dispatch answers with
      // the settled outcome instead of queueing behind the stall
      const late = (yield* getJsonWithin(
        `${url}/dispatch?agent=Scribe&key=handoff-scribe-f&input=hello`,
        "30 seconds",
      )) as { answer?: unknown; error?: string };
      expect(late.error).toBeUndefined();
      expect(late.answer).toBeDefined();

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "(g) the operator's STOP on the child answers the supervisor's handoff — its round runs on to a conclusion; RESUME picks the child's work back up with no input",
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

      yield* getJsonReady(
        `${url}/send?agent=Supervisor&key=parent-g&input=${encodeURIComponent(
          "call:handoff:g|call:stall:the suite",
        )}`,
      );
      yield* historyUntil(url, "Scribe", "handoff-scribe-g", (types) =>
        types.includes("tool-call"),
      );

      // the org's agent "stop" switch: the Scribe's session settles in
      // its own DO — its stall is cut — and the Supervisor's parked
      // handoff tool is handed the Stopped outcome
      const stopped = yield* getJsonWithin(
        `${url}/stop?agent=Scribe&key=handoff-scribe-g`,
        "30 seconds",
      );
      expect(stopped).toEqual({ stopped: true });

      const child = yield* historyUntil(
        url,
        "Scribe",
        "handoff-scribe-g",
        (types) => types.includes("settled") && types.includes("tool-result"),
      );
      expect(child).toContain("settled");
      // the stop LANDED the cut stall: its durable `tool-call` row is
      // answered as interrupted, in the record and in the thread
      expect(child.indexOf("tool-result")).toBeGreaterThan(
        child.indexOf("tool-call"),
      );

      // the supervisor's round LANDS: its tool result is a durable row,
      // the model reports, and the session parks — nothing aborted,
      // nothing crashed, nothing still waiting
      const parent = yield* historyUntil(
        url,
        "Supervisor",
        "parent-g",
        (types) => types.includes("tool-result") && types.at(-1) === "parked",
      );
      expect(parent).toContain("tool-result");
      expect(parent.at(-1)).toBe("parked");
      expect(parent).not.toContain("aborted");
      expect(parent).not.toContain("crashed");

      // the org's agent "resume" switch: NO input is sent and nothing
      // is written, yet the Scribe's DO reopens the session AND runs a
      // round over its thread as it stands — the model samples again
      // and, reading its stall answered as interrupted (the fixture's
      // model counts tool results against requests), reports and parks
      const before = child.length;
      const resumed = yield* getJsonWithin(
        `${url}/resume?agent=Scribe&key=handoff-scribe-g`,
        "30 seconds",
      );
      expect(resumed).toEqual({ resumed: true });
      const reopened = yield* historyUntil(
        url,
        "Scribe",
        "handoff-scribe-g",
        (types) =>
          types.length > before && types.slice(before).includes("parked"),
      );
      const tail = reopened.slice(before);
      expect(tail).toContain("resumed");
      expect(tail).toContain("assistant");
      expect(tail).not.toContain("input");
      expect(tail).not.toContain("tool-call");
      expect(tail.indexOf("resumed")).toBeLessThan(tail.indexOf("assistant"));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
