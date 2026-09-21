import {
  ApplicationActivation,
  readApplication,
  reconcileApplication,
  type ApplicationResourceProps,
} from "@/Celld/Application.ts";
import {
  prepareDeployment,
  readPublicationReceipt,
  stageDeployment,
  APPLICATION_LOCK_KEY,
  APPLICATION_RECEIPT_KEY,
  type PreparedDeployment,
} from "@/Celld/Deployment.ts";
import {
  DeploymentError,
  decode,
  digest,
  encode,
} from "@/Celld/Deployment/Objects.ts";
import {
  APPLICATION_GRAPH_METADATA,
  prepareApplicationGraph,
} from "@/Celld/ApplicationGraph.ts";
import * as Schema from "effect/Schema";
import { FleetStorage } from "@/Celld/FleetStorage.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { makeStore } from "./DeploymentStore.ts";

const owner = {
  stack: "Test",
  stage: "test",
  fqn: "Application",
  instanceId: "one",
};
const connection = {
  fleetId: "Fleet",
  fleetUrl: "http://fleet",
  bucket: { uri: "s3://application-test" },
};
const prepare = (
  content = "first",
  crons: readonly string[] = [],
  scriptName = "root",
) =>
  prepareDeployment({
    scriptName,
    mainModule: "index.js",
    modules: [
      {
        name: "index.js",
        content: `export default { fetch() { return new Response(${JSON.stringify(content)}); } };`,
      },
    ],
    metadata: { main_module: "index.js", bindings: [] },
    doClasses: [],
    sqliteClasses: [],
    crons,
  });
const propsFor = (root: PreparedDeployment): ApplicationResourceProps => ({
  ...connection,
  entrypoint: {
    workerName: root.scriptName,
    fleetId: connection.fleetId,
    stagedManifestKey: root.candidate.key,
    exposed: true,
    url: "https://application.test",
  },
  workers: [],
});
const setup = Effect.gen(function* () {
  const fake = yield* makeStore;
  const calls: { count: number; fail: boolean; after?: () => void } = {
    count: 0,
    fail: false,
  };
  const layer = Layer.mergeAll(
    Layer.succeed(FleetStorage, () => Effect.succeed(fake.store)),
    Layer.succeed(ApplicationActivation, {
      activate: (_connection, root, workers, revision) =>
        Effect.gen(function* () {
          const lockObject = yield* fake.store.get(APPLICATION_LOCK_KEY);
          expect(lockObject).toBeDefined();
          const lock = yield* decode(
            Schema.Record(Schema.String, Schema.Unknown),
            lockObject!.body,
          );
          const receipt = (yield* readPublicationReceipt(fake.store))!;
          expect(lock.owner).toEqual(owner);
          expect(lock.transactionId).toBe(receipt.transactionId);
          expect(receipt.revision).toBe(revision);
          expect(receipt.root).toEqual(root.pointer);
          expect(receipt.workers).toEqual(
            workers.map((worker) => worker.pointer),
          );
          expect(lock.fingerprint).toBe(
            yield* digest(
              yield* encode({
                owner,
                root: root.pointer,
                manifests: [root, ...workers].map((worker) => worker.manifest),
                priorRevision: lock.priorRevision ?? null,
                adopt: false,
              }),
            ),
          );
          expect(revision).toBe(
            yield* digest(
              yield* encode({
                fingerprint: lock.fingerprint,
                transactionId: lock.transactionId,
              }),
            ),
          );
          expect(root.manifest.raw_metadata).toEqual(
            expect.objectContaining({
              [APPLICATION_GRAPH_METADATA]: expect.objectContaining({
                schemaVersion: 1,
              }),
            }),
          );
          calls.count += 1;
          if (calls.fail)
            return yield* Effect.fail(
              new DeploymentError({
                reason: "unsupported",
                message: "Injected activation failure.",
              }),
            );
          yield* Effect.sync(() => calls.after?.());
        }).pipe(
          Effect.catchTag("Celld.FleetStorageError", (cause) =>
            Effect.fail(
              new DeploymentError({
                reason: "invalid-record",
                message: "Cannot inspect activation fixture storage.",
                cause,
              }),
            ),
          ),
        ),
    }),
  );
  return { ...fake, calls, layer };
});

describe("Celld Application lifecycle", () => {
  test.effect(
    "reads an interrupted pre-publication row without blocking dependency cleanup",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        const root = yield* prepare();
        const props = { ...propsFor(root), fleetUrl: undefined };
        expect(
          yield* readApplication(props, owner).pipe(Effect.provide(env.layer)),
        ).toBeUndefined();
        expect(env.calls.count).toBe(0);
        expect(env.objects.size).toBe(0);
        const reconcile = yield* reconcileApplication(props, owner).pipe(
          Effect.provide(env.layer),
          Effect.result,
        );
        expect(Result.isFailure(reconcile) && reconcile.failure._tag).toBe(
          "Celld.ResourceCatalogError",
        );
      }),
  );
  test.effect(
    "publishes the transformed root and preserves source identities across secondary changes",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const root = yield* prepare();
          const worker = yield* prepare("jobs-first", [], "jobs");
          yield* stageDeployment(env.store, root);
          yield* stageDeployment(env.store, worker);
          const props = {
            ...propsFor(root),
            workers: [{ ...propsFor(worker).entrypoint, exposed: false }],
          };
          const expected = yield* prepareApplicationGraph(root, [worker]);
          const initial = yield* reconcileApplication(props, owner);
          const first = (yield* readPublicationReceipt(env.store))!;
          expect(first.root).toEqual(expected.root.pointer);
          expect(first.root.version).not.toBe(root.version);
          expect(initial.candidates).toEqual([
            root.candidate.key,
            worker.candidate.key,
          ]);
          expect(expected.root.manifest.raw_metadata).toEqual(
            expect.objectContaining({
              [APPLICATION_GRAPH_METADATA]: {
                schemaVersion: 1,
                revision: expected.revision,
                candidates: [root, worker].map((source) => ({
                  scriptName: source.scriptName,
                  key: source.candidate.key,
                })),
              },
              bindings: [
                {
                  type: "service",
                  name: "__ALCHEMY_APP_WORKER_0",
                  service: "jobs",
                },
              ],
            }),
          );
          const next = yield* prepare("jobs-second", [], "jobs");
          yield* stageDeployment(env.store, next);
          const updated = yield* reconcileApplication(
            {
              ...props,
              workers: [{ ...propsFor(next).entrypoint, exposed: false }],
            },
            owner,
          );
          expect(updated.revision).not.toBe(initial.revision);
          expect(
            (yield* readPublicationReceipt(env.store))!.root.version,
          ).not.toBe(first.root.version);
          expect(updated.candidates).toEqual([
            root.candidate.key,
            next.candidate.key,
          ]);
          expect(env.calls.count).toBe(2);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  test.effect(
    "resumes failed first activation under the same transaction when read observes its receipt",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const root = yield* prepare();
          yield* stageDeployment(env.store, root);
          env.calls.fail = true;
          expect(
            Result.isFailure(
              yield* Effect.result(reconcileApplication(propsFor(root), owner)),
            ),
          ).toBe(true);
          const receipt = (yield* readPublicationReceipt(env.store))!;
          const lock = env.objects.get(APPLICATION_LOCK_KEY)!;
          const writes = env.writes.length;
          env.calls.fail = false;
          expect(
            (yield* readApplication(propsFor(root), owner))!.revision,
          ).toBe(receipt.revision);
          expect(env.writes.length).toBe(writes);
          expect(lock).toBeDefined();
          expect(env.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
          expect(env.calls.count).toBe(2);
        }).pipe(Effect.provide(env.layer));
      }),
  );
  test.effect(
    "does not return readiness if native pointers change during activation",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const root = yield* prepare();
          yield* stageDeployment(env.store, root);
          env.calls.after = () => {
            env.objects.delete("deploy/current.json");
          };
          expect(
            Result.isFailure(
              yield* Effect.result(reconcileApplication(propsFor(root), owner)),
            ),
          ).toBe(true);
          expect(env.calls.count).toBe(1);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  test.effect(
    "resumes an owned partial publication despite drift from the previous receipt",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const first = yield* prepare();
          yield* stageDeployment(env.store, first);
          const initial = yield* reconcileApplication(propsFor(first), owner);
          const second = yield* prepare("second");
          yield* stageDeployment(env.store, second);
          env.failBefore.add("deploy/current.json");
          const interrupted = yield* Effect.result(
            reconcileApplication(propsFor(second), owner),
          );
          expect(Result.isFailure(interrupted)).toBe(true);
          expect((yield* readPublicationReceipt(env.store))!.revision).toBe(
            initial.revision,
          );
          expect(env.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
          expect(
            yield* readApplication(propsFor(second), owner),
          ).toBeUndefined();
          expect(
            yield* readApplication(propsFor(first), owner),
          ).toBeUndefined();
          const resumed = yield* reconcileApplication(propsFor(second), owner);
          expect(resumed.revision).not.toBe(initial.revision);
          expect(env.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
          expect(env.calls.count).toBe(2);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  test.effect(
    "resumes a cron-only graph change interrupted before pointer acknowledgement",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const first = yield* prepare();
          yield* stageDeployment(env.store, first);
          const initial = yield* reconcileApplication(propsFor(first), owner);
          const next = yield* prepare("first", ["*/5 * * * *"]);
          yield* stageDeployment(env.store, next);
          expect(next.version).toBe(first.version);
          const transaction = yield* digest(
            yield* encode({
              owner,
              candidates: [next.candidate.key],
              priorRevision: initial.revision,
            }),
          );
          env.race.set("deploy/root/current.json", () => {
            env.failBefore.add(
              `alchemy/application/v1/transactions/${transaction}.json`,
            );
          });
          expect(
            Result.isFailure(
              yield* Effect.result(reconcileApplication(propsFor(next), owner)),
            ),
          ).toBe(true);
          const resumed = yield* reconcileApplication(propsFor(next), owner);
          expect(resumed.revision).not.toBe(initial.revision);
          expect(env.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  test.effect(
    "uses the journal's prior revision after the new receipt already committed",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const first = yield* prepare();
          yield* stageDeployment(env.store, first);
          const initial = yield* reconcileApplication(propsFor(first), owner);
          const next = yield* prepare("next");
          yield* stageDeployment(env.store, next);
          const transaction = yield* digest(
            yield* encode({
              owner,
              candidates: [next.candidate.key],
              priorRevision: initial.revision,
            }),
          );
          env.race.set(APPLICATION_RECEIPT_KEY, () => {
            env.failBefore.add(
              `alchemy/application/v1/transactions/${transaction}.json`,
            );
          });
          expect(
            Result.isFailure(
              yield* Effect.result(reconcileApplication(propsFor(next), owner)),
            ),
          ).toBe(true);
          const committed = (yield* readPublicationReceipt(env.store))!;
          expect(committed.revision).not.toBe(initial.revision);
          const resumed = yield* readApplication(propsFor(next), owner);
          expect(resumed!.revision).toBe(committed.revision);
          expect(
            (yield* reconcileApplication(propsFor(next), owner)).revision,
          ).toBe(committed.revision);
          expect(env.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  test.effect(
    "a graph no-op still activates and saved publication output is not readiness evidence",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const root = yield* prepare();
          yield* stageDeployment(env.store, root);
          const props = propsFor(root);
          const initial = yield* reconcileApplication(props, owner);
          const writes = env.writes.length;
          expect(yield* reconcileApplication(props, owner)).toEqual(initial);
          expect(env.writes.slice(writes)).toEqual([APPLICATION_LOCK_KEY]);
          expect(env.calls.count).toBe(2);
          env.calls.fail = true;
          expect(
            Result.isFailure(
              yield* Effect.result(readApplication(props, owner)),
            ),
          ).toBe(true);
          expect(
            Result.isFailure(
              yield* Effect.result(reconcileApplication(props, owner)),
            ),
          ).toBe(true);
          expect(env.writes.slice(writes)).toEqual([
            APPLICATION_LOCK_KEY,
            APPLICATION_LOCK_KEY,
          ]);
          expect(env.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
          const failedReceipt = (yield* readPublicationReceipt(env.store))!;
          env.calls.fail = false;
          expect(yield* readApplication(props, owner)).toEqual(initial);
          expect(
            (yield* readPublicationReceipt(env.store))!.transactionId,
          ).toBe(failedReceipt.transactionId);
          expect(env.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  test.effect(
    "cross-fleet members and non-root exposure fail before publication writes",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const root = yield* prepare();
          const props = propsFor(root);
          const foreign = {
            ...props,
            entrypoint: { ...props.entrypoint, fleetId: "OtherFleet" },
          };
          expect(
            Result.isFailure(
              yield* Effect.result(reconcileApplication(foreign, owner)),
            ),
          ).toBe(true);
          const exposed = {
            ...props,
            workers: [
              {
                ...props.entrypoint,
                workerName: "secondary",
                stagedManifestKey: "not-read",
                exposed: true,
              },
            ],
          };
          expect(
            Result.isFailure(
              yield* Effect.result(reconcileApplication(exposed, owner)),
            ),
          ).toBe(true);
          expect(env.writes).toEqual([]);
          expect(env.calls.count).toBe(0);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  test.effect(
    "refuses changed candidates while an earlier operation holds the lock",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const root = yield* prepare();
          yield* stageDeployment(env.store, root);
          env.failBefore.add("deploy/current.json");
          expect(
            Result.isFailure(
              yield* Effect.result(reconcileApplication(propsFor(root), owner)),
            ),
          ).toBe(true);
          const changed = yield* prepare("different operation");
          yield* stageDeployment(env.store, changed);
          const writes = env.writes.length;
          expect(
            Result.isFailure(
              yield* Effect.result(
                reconcileApplication(propsFor(changed), owner),
              ),
            ),
          ).toBe(true);
          expect(env.writes.length).toBe(writes);
          yield* reconcileApplication(propsFor(root), owner);
          expect(env.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        }).pipe(Effect.provide(env.layer));
      }),
  );

  test.effect(
    "rejects a Worker reference whose name differs from its candidate",
    () =>
      Effect.gen(function* () {
        const env = yield* setup;
        yield* Effect.gen(function* () {
          const root = yield* prepare();
          yield* stageDeployment(env.store, root);
          const props = propsFor(root);
          expect(
            Result.isFailure(
              yield* Effect.result(
                reconcileApplication(
                  {
                    ...props,
                    entrypoint: { ...props.entrypoint, workerName: "imposter" },
                  },
                  owner,
                ),
              ),
            ),
          ).toBe(true);
          expect(env.objects.has("deploy/current.json")).toBe(false);
        }).pipe(Effect.provide(env.layer));
      }),
  );
});
