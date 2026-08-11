/**
 * Engine ⇄ deployment-journal integration: every deploy/destroy driven
 * through `apply()` opens a DeploymentSession against the state store's
 * `deployments` API, tees all apply events into the journal, journals every
 * engine state write, and closes the version with the run's outcome.
 */
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import { apply, canTakeOverDeployment, isProcessAlive } from "@/Apply";
import { provideFreshArtifactStore } from "@/Artifacts";
import * as Plan from "@/Plan";
import { make as makeStack } from "@/Stack";
import { Stage } from "@/Stage";
import {
  InMemoryService,
  localState,
  State,
  StateStoreError,
  type DeploymentEvent,
  type StateService,
} from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import {
  TestLayers,
  TestResource,
  TestResourceHooks,
} from "../test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

class JournalTestFailure extends Data.TaggedError("JournalTestFailure")<{
  message: string;
}> {}

const kindsOf = (events: readonly DeploymentEvent[]) =>
  events.map((e) => (e.payload as { kind: string }).kind);

const payloadsOf = <T = Record<string, unknown>>(
  events: readonly DeploymentEvent[],
  kind: string,
): T[] =>
  events
    .map((e) => e.payload as { kind: string })
    .filter((p) => p.kind === kind) as T[];

/** The scratch's own in-memory store (shared with the deploys). */
const getStore = Effect.gen(function* () {
  const store = yield* yield* State;
  expect(store.deployments).toBeDefined();
  return store;
});

describe("engine deployment journaling", () => {
  test.provider("deploy journals version 1 with a full event trail", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }),
      );

      const store = yield* getStore;
      const list = yield* store.deployments!.list({
        stack: stack.name,
        stage: "test",
      });
      expect(list).toHaveLength(1);
      expect(list[0].version).toBe(1);
      expect(list[0].outcome).toBe("succeeded");
      expect(list[0].meta.command).toBe("deploy");
      expect(list[0].meta.initiator?.pid).toBe(process.pid);
      expect(typeof list[0].meta.initiator?.host).toBe("string");
      expect(typeof list[0].meta.alchemyVersion).toBe("string");
      expect(list[0].summary?.counts).toMatchObject({ create: 2 });

      const events = yield* store.deployments!.readEvents({
        stack: stack.name,
        stage: "test",
        version: 1,
      });

      // seq is contiguous from 1 and every event carries an emission ts
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      for (const e of events) {
        expect(typeof e.ts).toBe("number");
      }

      const kinds = kindsOf(events);
      expect(kinds[0]).toBe("deployment-start");
      expect(kinds.at(-1)).toBe("deployment-end");
      expect(kinds).toContain("status-change");
      expect(kinds).toContain("state-set");
      expect(kinds).toContain("output-set");

      // one create op-start/op-end pair per resource, correlated by opId
      const starts = payloadsOf<{
        opId: string;
        op: string;
        id: string;
        fqn?: string;
      }>(events, "op-start");
      const ends = payloadsOf<{ opId: string; outcome: string }>(
        events,
        "op-end",
      );
      const creates = starts.filter((s) => s.op === "create");
      expect(creates).toHaveLength(2);
      expect(new Set(creates.map((s) => s.fqn))).toEqual(new Set(["A", "B"]));
      for (const start of starts) {
        const end = ends.find((e) => e.opId === start.opId);
        expect(end).toBeDefined();
        expect(end!.outcome).toBe("ok");
      }

      const endPayload = payloadsOf<{
        outcome: string;
        summary?: { counts?: Record<string, number> };
      }>(events, "deployment-end")[0];
      expect(endPayload.outcome).toBe("succeeded");
    }),
  );

  test.provider("second deploy allocates version 2", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(TestResource("A", { string: "v1" }));
      yield* stack.deploy(TestResource("A", { string: "v2" }));

      const store = yield* getStore;
      const list = yield* store.deployments!.list({
        stack: stack.name,
        stage: "test",
      });
      // newest first
      expect(list.map((r) => r.version)).toEqual([2, 1]);
      expect(list[0].outcome).toBe("succeeded");
      expect(list[0].summary?.counts).toMatchObject({ update: 1 });

      const events = yield* store.deployments!.readEvents({
        stack: stack.name,
        stage: "test",
        version: 2,
      });
      const updates = payloadsOf<{ op: string }>(events, "op-start").filter(
        (s) => s.op === "update",
      );
      expect(updates.length).toBeGreaterThanOrEqual(1);
    }),
  );

  test.provider("destroy journals a destroy-command version", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(TestResource("A", { string: "a" }));
      yield* stack.destroy();

      const store = yield* getStore;
      const list = yield* store.deployments!.list({
        stack: stack.name,
        stage: "test",
      });
      expect(list.map((r) => r.version)).toEqual([2, 1]);
      expect(list[0].meta.command).toBe("destroy");
      expect(list[0].outcome).toBe("succeeded");

      const events = yield* store.deployments!.readEvents({
        stack: stack.name,
        stage: "test",
        version: 2,
      });
      const kinds = kindsOf(events);
      expect(kinds[0]).toBe("deployment-start");
      expect(kinds.at(-1)).toBe("deployment-end");
      expect(kinds).toContain("state-delete");
      const deletes = payloadsOf<{ op: string; opId: string }>(
        events,
        "op-start",
      ).filter((s) => s.op === "delete");
      expect(deletes).toHaveLength(1);
      const ends = payloadsOf<{ opId: string; outcome: string }>(
        events,
        "op-end",
      );
      expect(ends.find((e) => e.opId === deletes[0].opId)?.outcome).toBe("ok");
      expect(
        payloadsOf<{ command: string }>(events, "deployment-start")[0].command,
      ).toBe("destroy");
    }),
  );

  test.provider(
    "failed deploy records outcome failed with an error digest",
    (stack) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          stack.deploy(TestResource("A", { string: "a" })).pipe(
            Effect.provide(
              Layer.succeed(TestResourceHooks, {
                create: () =>
                  Effect.fail(
                    new JournalTestFailure({ message: "create exploded" }),
                  ),
              }),
            ),
          ),
        );
        expect(Result.isFailure(result)).toBe(true);

        const store = yield* getStore;
        const record = yield* store.deployments!.get({
          stack: stack.name,
          stage: "test",
          version: 1,
        });
        expect(record?.outcome).toBe("failed");
        expect(record?.summary?.error).toContain("JournalTestFailure");

        const events = yield* store.deployments!.readEvents({
          stack: stack.name,
          stage: "test",
          version: 1,
        });
        const ends = payloadsOf<{ outcome: string; error?: string }>(
          events,
          "op-end",
        );
        const failed = ends.filter((e) => e.outcome === "fail");
        expect(failed).toHaveLength(1);
        expect(failed[0].error).toContain("JournalTestFailure");
        const endPayload = payloadsOf<{ outcome: string }>(
          events,
          "deployment-end",
        )[0];
        expect(endPayload.outcome).toBe("failed");
      }),
  );

  test.provider(
    "a live open deployment blocks a second deploy with DeploymentInProgress",
    (stack) =>
      Effect.gen(function* () {
        const store = yield* getStore;
        const held = yield* store.deployments!.begin({
          stack: stack.name,
          stage: "test",
          meta: { command: "deploy", initiator: { user: "other" } },
        });

        const result = yield* Effect.result(
          stack.deploy(TestResource("A", { string: "a" })),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect((result.failure as { _tag?: string })._tag).toBe(
            "DeploymentInProgress",
          );
        }

        // the blocked attempt never allocated a version
        const list = yield* store.deployments!.list({
          stack: stack.name,
          stage: "test",
        });
        expect(list).toHaveLength(1);
        expect(list[0].version).toBe(held.version);

        // release the lease so the harness teardown destroy can run
        yield* store.deployments!.end({
          stack: stack.name,
          stage: "test",
          version: held.version,
          token: held.token,
          outcome: "succeeded",
        });

        // with the lease released the deploy goes through and journals v2
        yield* stack.deploy(TestResource("A", { string: "a" }));
        const after = yield* store.deployments!.list({
          stack: stack.name,
          stage: "test",
        });
        expect(after.map((r) => r.version)).toEqual([2, 1]);
        expect(after[0].outcome).toBe("succeeded");
      }),
  );

  test.provider(
    "a live open held by a dead same-host process is taken over (supersede)",
    (stack) =>
      Effect.gen(function* () {
        const store = yield* getStore;

        // A pid that provably existed on this host and is now gone: spawn
        // a short-lived child and wait for it to exit.
        const deadPid = yield* Effect.sync(
          () => spawnSync(process.execPath, ["--version"]).pid,
        );
        expect(typeof deadPid).toBe("number");

        const held = yield* store.deployments!.begin({
          stack: stack.name,
          stage: "test",
          meta: {
            command: "deploy",
            initiator: {
              user: "crashed-cli",
              host: os.hostname(),
              pid: deadPid,
            },
          },
        });

        // The holder's heartbeat is fresh, but its process is dead on THIS
        // host — the deploy takes over instead of failing.
        yield* stack.deploy(TestResource("A", { string: "a" }));

        const list = yield* store.deployments!.list({
          stack: stack.name,
          stage: "test",
        });
        expect(list.map((r) => r.version)).toEqual([
          held.version + 1,
          held.version,
        ]);
        expect(list[0].outcome).toBe("succeeded");
        // The dead holder's version was reconciled to abandoned.
        expect(list[1].outcome).toBe("abandoned");
      }),
  );

  test(
    "takeover predicate: only same-host dead pids qualify",
    Effect.gen(function* () {
      const holder = (initiator?: {
        user?: string;
        host?: string;
        pid?: number;
      }) => ({
        stack: "s",
        stage: "t",
        version: 1,
        meta: { command: "deploy" as const, initiator },
        startedAt: 0,
        heartbeatAt: 0,
      });
      const self = { host: "this-host", pid: 100 };
      const dead = () => false;
      const alive = () => true;

      // same host + dead pid → takeover
      expect(
        canTakeOverDeployment(
          holder({ host: "this-host", pid: 7 }),
          self,
          dead,
        ),
      ).toBe(true);
      // same host + live pid → no
      expect(
        canTakeOverDeployment(
          holder({ host: "this-host", pid: 7 }),
          self,
          alive,
        ),
      ).toBe(false);
      // different host → never (the pid check is meaningless there)
      expect(
        canTakeOverDeployment(
          holder({ host: "other-host", pid: 7 }),
          self,
          dead,
        ),
      ).toBe(false);
      // missing host or pid → never
      expect(canTakeOverDeployment(holder({ pid: 7 }), self, dead)).toBe(false);
      expect(
        canTakeOverDeployment(holder({ host: "this-host" }), self, dead),
      ).toBe(false);
      expect(canTakeOverDeployment(holder(undefined), self, dead)).toBe(false);
      // our own pid → never (we cannot supersede ourselves)
      expect(
        canTakeOverDeployment(
          holder({ host: "this-host", pid: 100 }),
          self,
          dead,
        ),
      ).toBe(false);

      // the real liveness check recognizes our own process as alive
      expect(isProcessAlive(process.pid)).toBe(true);
    }),
  );

  test.provider(
    "a deploy superseded mid-flight is fenced on its next state write",
    (stack) =>
      Effect.gen(function* () {
        const store = yield* getStore;
        const usurper = yield* Ref.make<
          { version: number; token: string } | undefined
        >(undefined);

        // The create hook plays the usurper: while the deploy (v1) is
        // mid-operation, a second deployment begins with supersede: 1 —
        // exactly what a same-host takeover of a "dead" holder does. The
        // deploy's own post-create state write carries fence: 1, sees
        // that v2 exists, and MUST be rejected, failing the zombie apply.
        const result = yield* Effect.result(
          stack.deploy(TestResource("A", { string: "a" })).pipe(
            Effect.provide(
              Layer.succeed(TestResourceHooks, {
                create: () =>
                  store
                    .deployments!.begin({
                      stack: stack.name,
                      stage: "test",
                      meta: {
                        command: "deploy",
                        initiator: { user: "usurper" },
                      },
                      supersede: 1,
                    })
                    .pipe(
                      Effect.flatMap((held) => Ref.set(usurper, held)),
                      Effect.orDie,
                    ),
              }),
            ),
          ),
        );

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          const failure = result.failure as { _tag?: string; message?: string };
          expect(failure._tag).toBe("StateStoreError");
          expect(String(failure.message)).toContain("fenced");
        }

        // The zombie's write never landed: A is not in "created" state.
        const state = yield* store.get({
          stack: stack.name,
          stage: "test",
          fqn: "A",
        });
        expect((state as { status?: string } | undefined)?.status).not.toBe(
          "created",
        );

        // v1 was reconciled to abandoned by the takeover; v2 is the
        // usurper's live open.
        const list = yield* store.deployments!.list({
          stack: stack.name,
          stage: "test",
        });
        expect(list.map((r) => r.version)).toEqual([2, 1]);
        expect(["abandoned", "completed-late", "failed"]).toContain(
          list[1].outcome,
        );

        // Close the usurper's lease so the harness teardown destroy can run.
        const held = yield* Ref.get(usurper);
        expect(held).toBeDefined();
        yield* store.deployments!.end({
          stack: stack.name,
          stage: "test",
          version: held!.version,
          token: held!.token,
          outcome: "succeeded",
        });
      }),
  );

  test(
    "a StateStoreError from begin fails the deploy (fail-closed: no lock, no mutation)",
    Effect.gen(function* () {
      const store = yield* InMemoryService();
      const failing: StateService = {
        ...store,
        deployments: {
          ...store.deployments!,
          begin: () =>
            Effect.fail(
              new StateStoreError({ message: "journal store unreachable" }),
            ),
        },
      };

      const stackName = "engine-journal-fail-closed";
      const result = yield* Effect.result(
        TestResource("A", { string: "a" }).pipe(
          makeStack({
            name: stackName,
            providers: TestLayers(),
            state: Layer.succeed(State, Effect.succeed(failing)),
          } as any) as any,
          Effect.flatMap((compiled: any) =>
            Plan.make(compiled).pipe(
              Effect.flatMap((plan) => apply(plan)),
              Effect.provide(compiled.services),
            ),
          ),
          Effect.provide(Layer.succeed(Stage, "test")),
          provideFreshArtifactStore,
        ) as unknown as Effect.Effect<unknown, unknown>,
      );

      // begin is the mutual-exclusion gate — its failure aborts the apply.
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect((result.failure as { _tag?: string })._tag).toBe(
          "StateStoreError",
        );
      }

      // Fail-closed: nothing was deployed and no version was allocated.
      expect(
        yield* store.get({ stack: stackName, stage: "test", fqn: "A" }),
      ).toBeUndefined();
      expect(
        yield* store.deployments!.list({ stack: stackName, stage: "test" }),
      ).toHaveLength(0);
    }),
  );

  test(
    "local-fs deploy persists .deployments record + events.jsonl on disk",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-engine-journal-",
      });

      const stackName = "engine-journal-local";
      yield* TestResource("A", { string: "a" }).pipe(
        makeStack({
          name: stackName,
          providers: TestLayers(),
          state: localState({ rootDir: root }),
        } as any) as any,
        Effect.flatMap((compiled: any) =>
          Plan.make(compiled).pipe(
            Effect.flatMap((plan) => apply(plan)),
            Effect.provide(compiled.services),
          ),
        ),
        Effect.provide(Layer.succeed(Stage, "test")),
        provideFreshArtifactStore,
      ) as unknown as Effect.Effect<void>;

      const dir = path.join(
        root,
        ".alchemy",
        "state",
        stackName,
        "test",
        ".deployments",
      );
      const recordPath = path.join(dir, "1.record.json");
      const eventsPath = path.join(dir, "1.events.jsonl");
      expect(yield* fs.exists(recordPath)).toBe(true);
      expect(yield* fs.exists(eventsPath)).toBe(true);

      const record = JSON.parse(yield* fs.readFileString(recordPath));
      expect(record.version).toBe(1);
      expect(record.outcome).toBe("succeeded");
      expect(record.meta.command).toBe("deploy");

      const lines = (yield* fs.readFileString(eventsPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as DeploymentEvent);
      expect(lines.map((e) => e.seq)).toEqual(lines.map((_, i) => i + 1));
      const kinds = kindsOf(lines);
      expect(kinds[0]).toBe("deployment-start");
      expect(kinds.at(-1)).toBe("deployment-end");
      expect(kinds).toContain("op-start");
      expect(kinds).toContain("op-end");
      expect(kinds).toContain("state-set");
    }),
    { timeout: 30_000 },
  );
});
