import type { ApplyEvent } from "@/Cli/Event.ts";
import {
  InMemoryService,
  makeDeploymentSession,
  makeLocalState,
  StateStoreError,
  type DeploymentEvent,
  type ResourceState,
  type StateService,
} from "@/State";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

const resource = (fqn: string, status: "created" | "updating" = "created") =>
  ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status,
    downstream: [],
    bindings: [],
    props: {},
    attr: {},
  }) as ResourceState;

const applyEvent = (n: number): ApplyEvent => ({
  kind: "status-change",
  id: `res-${n}`,
  fqn: `ns/res-${n}`,
  type: "test:resource",
  status: "creating",
  ts: n,
});

const meta = { command: "deploy" as const, initiator: { user: "test" } };

/** Unique (stack, stage) per case so cases never interfere. */
const ids = (name: string) => ({ stack: "deployment-session", stage: name });

describe("DeploymentSession", () => {
  it.effect("no-deployments store → no-op session, passthrough works", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("no-deployments");
      const full = yield* InMemoryService();
      // A third-party store without deployment history support.
      const store: StateService = { ...full, deployments: undefined };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store,
            stack,
            stage,
            meta,
          });
          expect(session.version).toBeUndefined();
          expect(session.state).toBe(store);

          // journaling is a total no-op, never an error
          yield* session.emit(applyEvent(1));

          // state passthrough still works
          const value = resource("res-a");
          yield* session.state.set({ stack, stage, fqn: value.fqn, value });
          expect(yield* store.get({ stack, stage, fqn: value.fqn })).toEqual(
            value,
          );

          yield* session.end("succeeded");
        }),
      );
    }),
  );

  it.effect(
    "journals deployment-start + emits + deployment-end with contiguous seq",
    () =>
      Effect.gen(function* () {
        const { stack, stage } = ids("journal");
        const store = yield* InMemoryService();

        yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeDeploymentSession({
              store,
              stack,
              stage,
              meta,
            });
            expect(session.version).toBe(1);
            yield* session.emit(applyEvent(1));
            yield* session.emit(applyEvent(2));
            yield* session.emit(applyEvent(3));
            yield* session.end("succeeded", { counts: { create: 3 } });
          }),
        );

        const record = yield* store.deployments!.get({
          stack,
          stage,
          version: 1,
        });
        expect(record?.outcome).toBe("succeeded");
        expect(record?.summary).toEqual({ counts: { create: 3 } });

        const events = yield* store.deployments!.readEvents({
          stack,
          stage,
          version: 1,
        });
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
        for (const e of events) {
          expect(typeof e.ts).toBe("number");
        }
        expect(events[0].payload).toEqual({
          kind: "deployment-start",
          command: "deploy",
        });
        expect((events[1].payload as ApplyEvent).kind).toBe("status-change");
        expect(events[1].fqn).toBe("ns/res-1");
        // journal envelope ts mirrors the ApplyEvent's emission ts
        expect(events[1].ts).toBe(1);
        expect(events[4].payload).toEqual({
          kind: "deployment-end",
          outcome: "succeeded",
          summary: { counts: { create: 3 } },
        });
      }),
  );

  it.effect("facade set/delete journal state events AND write head state", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("facade");
      const store = yield* InMemoryService();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store,
            stack,
            stage,
            meta,
          });
          const first = resource("res-a", "created");
          yield* session.state.set({
            stack,
            stage,
            fqn: first.fqn,
            value: first,
          });
          const second = resource("res-a", "updating");
          yield* session.state.set({
            stack,
            stage,
            fqn: second.fqn,
            value: second,
          });
          // head state is written through to the real store
          expect(
            (yield* store.get({ stack, stage, fqn: "res-a" }))?.status,
          ).toBe("updating");

          yield* session.state.delete({ stack, stage, fqn: "res-a" });
          expect(
            yield* store.get({ stack, stage, fqn: "res-a" }),
          ).toBeUndefined();

          yield* session.state.setOutput({ stack, stage, value: { a: 1 } });
          expect(yield* store.getOutput({ stack, stage })).toEqual({ a: 1 });

          yield* session.end("succeeded");
        }),
      );

      const events = yield* store.deployments!.readEvents({
        stack,
        stage,
        version: 1,
      });
      const payloads = events.map((e) => e.payload) as {
        kind: string;
        [k: string]: unknown;
      }[];
      expect(payloads.map((p) => p.kind)).toEqual([
        "deployment-start",
        "state-set",
        "state-set",
        "state-delete",
        "output-set",
        "deployment-end",
      ]);
      // first write: greenfield, no before image
      expect(payloads[1]).toEqual({
        kind: "state-set",
        fqn: "res-a",
        status: "created",
      });
      // second write carries a status-only before image, never full bodies
      expect(payloads[2]).toEqual({
        kind: "state-set",
        fqn: "res-a",
        status: "updating",
        before: { status: "created" },
      });
      expect(payloads[3]).toEqual({
        kind: "state-delete",
        fqn: "res-a",
        before: { status: "updating" },
      });
      expect(payloads[4]).toEqual({ kind: "output-set" });
      // envelope fqn is stamped for state events
      expect(events[1].fqn).toBe("res-a");
      expect(events[3].fqn).toBe("res-a");
    }),
  );

  it.effect("end is idempotent (first outcome wins, one deployment-end)", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("end-idempotent");
      const store = yield* InMemoryService();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store,
            stack,
            stage,
            meta,
          });
          yield* session.end("failed", { error: "boom" });
          yield* session.end("succeeded");
          // post-end emits are dropped, not errors
          yield* session.emit(applyEvent(9));
        }),
      );

      const record = yield* store.deployments!.get({
        stack,
        stage,
        version: 1,
      });
      expect(record?.outcome).toBe("failed");
      expect(record?.summary).toEqual({ error: "boom" });

      const events = yield* store.deployments!.readEvents({
        stack,
        stage,
        version: 1,
      });
      const kinds = events.map((e) => (e.payload as { kind: string }).kind);
      expect(kinds).toEqual(["deployment-start", "deployment-end"]);
    }),
  );

  it.effect("scope close without end → record outcome interrupted", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("interrupted");
      const store = yield* InMemoryService();

      const scope = yield* Scope.make();
      const session = yield* Scope.provide(
        makeDeploymentSession({ store, stack, stage, meta }),
        scope,
      );
      yield* session.emit(applyEvent(1));
      // no end() — the crash/interrupt path
      yield* Scope.close(scope, Exit.void);

      const record = yield* store.deployments!.get({
        stack,
        stage,
        version: 1,
      });
      expect(record?.outcome).toBe("interrupted");

      const events = yield* store.deployments!.readEvents({
        stack,
        stage,
        version: 1,
      });
      const kinds = events.map((e) => (e.payload as { kind: string }).kind);
      expect(kinds).toEqual([
        "deployment-start",
        "status-change",
        "deployment-end",
      ]);
      expect(events.at(-1)?.payload).toEqual({
        kind: "deployment-end",
        outcome: "interrupted",
      });
    }),
  );

  it.effect("second concurrent session fails with DeploymentInProgress", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("conflict");
      const store = yield* InMemoryService();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store,
            stack,
            stage,
            meta,
          });
          expect(session.version).toBe(1);

          const result = yield* Effect.result(
            Effect.scoped(makeDeploymentSession({ store, stack, stage, meta })),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("DeploymentInProgress");
          }
          yield* session.end("succeeded");
        }),
      );
    }),
  );

  it.effect("size threshold flushes without time passing or end()", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("threshold");
      const store = yield* InMemoryService();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store,
            stack,
            stage,
            meta,
          });
          // deployment-start (seq 1) + 49 emits = 50 buffered → flush
          for (let n = 1; n <= 49; n++) {
            yield* session.emit(applyEvent(n));
          }
          const events = yield* store.deployments!.readEvents({
            stack,
            stage,
            version: 1,
          });
          expect(events.length).toBe(50);
          yield* session.end("succeeded");
        }),
      );
    }),
  );

  it.effect("interval flusher drains the buffer under TestClock", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("interval");
      const store = yield* InMemoryService();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store,
            stack,
            stage,
            meta,
          });
          yield* session.emit(applyEvent(1));

          // nothing flushed yet (below the size threshold, no time passed)
          expect(
            (yield* store.deployments!.readEvents({
              stack,
              stage,
              version: 1,
            })).length,
          ).toBe(0);

          yield* TestClock.adjust("1 second");

          const events = yield* store.deployments!.readEvents({
            stack,
            stage,
            version: 1,
          });
          expect(events.map((e) => e.seq)).toEqual([1, 2]);
          yield* session.end("succeeded");
        }),
      );
    }),
  );

  it.effect("heartbeat fiber refreshes the open marker", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("heartbeat");
      const store = yield* InMemoryService();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store,
            stack,
            stage,
            meta,
          });
          expect(session.version).toBe(1);
          const before = yield* store.deployments!.get({
            stack,
            stage,
            version: 1,
          });
          yield* TestClock.adjust("10 seconds");
          const after = yield* store.deployments!.get({
            stack,
            stage,
            version: 1,
          });
          expect(after!.heartbeatAt).toBeGreaterThan(before!.heartbeatAt);
          yield* session.end("succeeded");
        }),
      );
    }),
  );

  it.effect("journal append failures never fail deploy-visible effects", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("append-fails");
      const store = yield* InMemoryService();
      const failing: StateService = {
        ...store,
        deployments: {
          ...store.deployments!,
          appendEvents: () =>
            Effect.fail(new StateStoreError({ message: "journal down" })),
        },
      };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store: failing,
            stack,
            stage,
            meta,
          });
          // emits (including the threshold-triggered flush) succeed
          for (let n = 1; n <= 60; n++) {
            yield* session.emit(applyEvent(n));
          }
          // facade writes still succeed and hit head state
          const value = resource("res-a");
          yield* session.state.set({ stack, stage, fqn: value.fqn, value });
          expect(
            yield* store.get({ stack, stage, fqn: "res-a" }),
          ).toBeDefined();
          yield* session.end("succeeded");
        }),
      );

      const record = yield* store.deployments!.get({
        stack,
        stage,
        version: 1,
      });
      expect(record?.outcome).toBe("succeeded");
      // nothing was journaled — and nothing failed because of it
      const events = yield* store.deployments!.readEvents({
        stack,
        stage,
        version: 1,
      });
      expect(events.length).toBe(0);
    }),
  );

  it.effect("facade tee works over the local FS store", () =>
    Effect.gen(function* () {
      const { stack, stage } = ids("local-fs");
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectory({
        prefix: "alchemy-deployment-session-",
      });
      const store = yield* makeLocalState({ rootDir: root });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeDeploymentSession({
            store,
            stack,
            stage,
            meta,
          });
          expect(session.version).toBe(1);
          const value = resource("res-a");
          yield* session.state.set({ stack, stage, fqn: value.fqn, value });
          yield* session.emit(applyEvent(1));
          yield* session.end("succeeded");
        }),
      );

      // head row written
      expect(yield* store.get({ stack, stage, fqn: "res-a" })).toBeDefined();
      // journal persisted
      const record = yield* store.deployments!.get({
        stack,
        stage,
        version: 1,
      });
      expect(record?.outcome).toBe("succeeded");
      const events: readonly DeploymentEvent[] =
        yield* store.deployments!.readEvents({ stack, stage, version: 1 });
      const kinds = events.map((e) => (e.payload as { kind: string }).kind);
      expect(kinds).toEqual([
        "deployment-start",
        "state-set",
        "status-change",
        "deployment-end",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
