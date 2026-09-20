import * as machines from "@distilled.cloud/fly-io/machines";
import * as Alchemy from "@/index";
import * as Fly from "@/Fly";
import { localState, makeLocalState } from "@/State/LocalState";
import * as Test from "@/Test/Alchemy";
import * as TestCore from "@/Test/Core";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import {
  assertAppGone,
  assertCommitted,
  checks,
} from "./fixtures/bluegreen.ts";
import {
  delayedResourceWrite,
  ResourceRow,
} from "./fixtures/state-persistence.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

const stackName = "Fly-BlueGreenStatePersistence-delayed-durable-write";
const options = {
  providers: Fly.providers(),
  dev: false,
  sidecar: false,
  stage: undefined,
};
const { test } = Test.make(options);

const actor = (state = localState(), endpoint?: string) => {
  const providers = throughProxy(() => endpoint);
  const stack = (version: string) =>
    Alchemy.Stack(
      stackName,
      { providers, state },
      Effect.gen(function* () {
        const app = yield* Fly.App("Site");
        return yield* Fly.Machine("Worker", {
          app,
          image: "nginx:alpine",
          env: { VERSION: version },
          checks,
          deploy: { strategy: "bluegreen", healthTimeout: "60 seconds" },
          shutdown: { signal: "SIGQUIT", timeout: "5 seconds" },
        });
      }),
    );
  return {
    state,
    // Private execution scopes avoid Test.make's file-shared destroy scope.
    deploy: (version: string) => TestCore.deploy(options, stack(version)),
    destroy: () => TestCore.destroy(options, stack("three")),
  };
};

test(
  "F11 delayed durable LocalState rename cannot authorize deletion of the live successor",
  TestCore.withProviders(
    Effect.gen(function* () {
      const target = { stack: stackName, stage: Test.resolveStage(options) };
      const readWorker = () =>
        Effect.gen(function* () {
          const state = yield* makeLocalState();
          return yield* state.get({ ...target, fqn: "Worker" }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ResourceRow)),
            Effect.catchTag("SchemaError", () =>
              Effect.fail(new Error("Missing or invalid durable Worker row")),
            ),
          );
        });
      const assertEmptyState = () =>
        Effect.gen(function* () {
          const state = yield* makeLocalState();
          expect(yield* state.list(target)).toEqual([]);
          expect(
            (yield* state.get({ ...target, fqn: "Worker" })) === undefined,
          ).toBe(true);
          expect(
            (yield* state.get({ ...target, fqn: "Site" })) === undefined,
          ).toBe(true);
          expect((yield* state.getOutput(target)) === undefined).toBe(true);
          expect(yield* state.listStages(target.stack)).not.toContain(
            target.stage,
          );
        });
      yield* actor().destroy();
      yield* assertEmptyState();
      let appName: string | undefined;
      const cleanup = Effect.gen(function* () {
        yield* actor().destroy();
        if (appName !== undefined) {
          yield* assertAppGone(appName);
          const remainingMachines = yield* machines
            .listMachines({ app_name: appName })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
          const remainingVolumes = yield* machines
            .listVolumes({ app_name: appName })
            .pipe(Effect.catchTag("NotFound", () => Effect.succeed([])));
          expect(
            remainingMachines
              .filter((machine) => machine.state !== "destroyed")
              .map((machine) => machine.id),
          ).toEqual([]);
          expect(remainingVolumes.map((volume) => volume.id)).toEqual([]);
        }
        yield* assertEmptyState();
      });
      yield* Effect.gen(function* () {
        const initial = yield* actor().deploy("one");
        yield* Effect.sync(() => {
          appName = initial.appName;
        });
        const initialRow = yield* readWorker();
        expect(initialRow.status).toBe("created");
        expect(initialRow.attr?.machineIds).toEqual(initial.machineIds);
        const gate = yield* delayedResourceWrite({ ...target, fqn: "Worker" });
        const actorA = actor(gate.state);
        const actorB = actor();
        expect(actorA.state).not.toBe(actorB.state);
        yield* Effect.gen(function* () {
          const delayed = yield* actorA.deploy("two").pipe(Effect.forkScoped);
          yield* Effect.gen(function* () {
            const held = yield* gate.wait.pipe(
              Effect.raceFirst(
                Fiber.join(delayed).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      new Error(
                        "Actor A finished without holding its final rename",
                      ),
                    ),
                  ),
                ),
              ),
            );
            expect(held.status).toBe("updated");
            expect(held.instanceId).toBe(initialRow.instanceId);
            expect(held.attr?.machineIds).toHaveLength(1);
            expect(held.attr?.machineId).not.toBe(initial.machineId);
            const heldIds = [...held.attr!.machineIds];
            const prepared = yield* assertCommitted(initial.appName, heldIds);
            expect(prepared[0]?.config?.env?.VERSION).toBe("two");
            expect(prepared[0]?.config?.metadata?.["alchemy.instance"]).toBe(
              held.instanceId,
            );
            expect(prepared[0]?.config?.metadata?.["alchemy.fqn"]).toBe(
              "Worker",
            );
            const beforeRename = yield* readWorker();
            expect(beforeRename.status).toBe("updating");
            expect(beforeRename.attr?.machineIds).not.toEqual(heldIds);

            // B observes A's completed rollout while A's terminal row is still a temp file.
            const newer = yield* actorB.deploy("three");
            expect(newer.appName).toBe(initial.appName);
            expect(newer.machineIds).toHaveLength(1);
            expect(newer.machineId).not.toBe(held.attr?.machineId);
            const newerRow = yield* readWorker();
            expect(newerRow.status).toBe("updated");
            expect(newerRow.instanceId).toBe(held.instanceId);
            expect(newerRow.attr?.machineIds).toEqual(newer.machineIds);
            const successor = yield* assertCommitted(
              newer.appName,
              newer.machineIds,
            );
            const successorMetadata = successor[0]!.config!.metadata!;
            expect(successor[0]?.config?.env?.VERSION).toBe("three");
            expect(successorMetadata["alchemy.instance"]).toBe(held.instanceId);
            expect(successorMetadata["alchemy.fqn"]).toBe("Worker");
            expect(successorMetadata["alchemy.generation"]).not.toBe(
              prepared[0]?.config?.metadata?.["alchemy.generation"],
            );
            expect(
              Number(successorMetadata["alchemy.sequence"]),
            ).toBeGreaterThan(
              Number(prepared[0]?.config?.metadata?.["alchemy.sequence"]),
            );

            yield* gate.release;
            const late = yield* Fiber.join(delayed).pipe(
              Effect.timeout("600 seconds"),
            );
            expect(late.machineIds).toEqual(heldIds);
            expect((yield* gate.written).attr?.machineIds).toEqual(heldIds);
            const stale = yield* readWorker();
            // This controlled late rename wins on disk, not in the cloud; there is no fence.
            expect(stale.status).toBe("updated");
            expect(stale.instanceId).toBe(held.instanceId);
            expect(stale.attr?.machineIds).toEqual(heldIds);
            yield* assertCommitted(newer.appName, newer.machineIds);

            const proxy = yield* transportProxy();
            const actorC = actor(localState(), proxy.url);
            expect(actorC.state).not.toBe(actorA.state);
            expect(actorC.state).not.toBe(actorB.state);
            const recovered = yield* actorC.deploy("three");
            expect(
              proxy.events.some(
                (event) =>
                  event.stage === "completed" &&
                  event.method === "GET" &&
                  event.path === `/v1/apps/${newer.appName}/machines` &&
                  event.status === 200,
              ),
            ).toBe(true);
            expect(
              proxy.events.filter(
                (event) =>
                  event.stage === "request" &&
                  newer.machineIds.includes(event.machineId ?? "") &&
                  (event.path.endsWith("/cordon") ||
                    event.path.endsWith("/stop") ||
                    (event.method === "DELETE" &&
                      !event.path.endsWith("/lease"))),
              ),
            ).toEqual([]);
            const preserved = yield* assertCommitted(
              newer.appName,
              newer.machineIds,
            );
            expect(preserved[0]?.config?.metadata?.["alchemy.instance"]).toBe(
              successorMetadata["alchemy.instance"],
            );
            expect(preserved[0]?.config?.metadata?.["alchemy.generation"]).toBe(
              successorMetadata["alchemy.generation"],
            );
            const recoveredRow = yield* readWorker();
            expect(recoveredRow.instanceId).toBe(held.instanceId);
            expect(recovered.machineIds).toEqual(newer.machineIds);
            expect(recoveredRow.status).toBe("updated");
            expect(recoveredRow.attr?.machineIds).toEqual(newer.machineIds);
          }).pipe(
            Effect.ensuring(
              gate.release.pipe(
                Effect.andThen(
                  Fiber.await(delayed).pipe(
                    Effect.timeout("600 seconds"),
                    Effect.orDie,
                  ),
                ),
              ),
            ),
          );
        }).pipe(Effect.scoped);
      }).pipe(Effect.ensuring(cleanup.pipe(Effect.orDie)));
    }).pipe(Effect.scoped),
    options,
    stackName,
  ),
  { timeout: 1_800_000, retry: 0 },
);
