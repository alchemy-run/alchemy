import * as Node from "@distilled.cloud/celld/node";
import {
  APPLICATION_CLAIM_KEY,
  APPLICATION_LOCK_KEY,
  APPLICATION_RECEIPT_KEY,
  prepareDeployment,
  publishApplication,
  readPublicationReceipt,
  stageAssetBlobs,
  stageDeployment,
  type PrepareDeploymentInput,
} from "@/Celld/Deployment.ts";
import { decode, encode } from "@/Celld/Deployment/Objects.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { makeStore } from "./DeploymentStore.ts";
import { prepareV05PublicationFixture } from "./fixtures/deployment-v05.ts";

const source = 'export default { fetch() { return new Response("ok"); } };\n';
const input: PrepareDeploymentInput = {
  scriptName: "app",
  mainModule: "index.js",
  modules: [{ name: "index.js", content: source }],
  metadata: { main_module: "index.js", bindings: [] },
  doClasses: [],
  sqliteClasses: [],
};
const owner = {
  stack: "Test",
  stage: "test",
  fqn: "App",
  instanceId: "instance-1",
};
const consumer = {
  queue: "jobs",
  max_batch_size: 10,
  max_batch_timeout: 5,
  max_retries: 3,
};

const expectFailure = <A, E>(result: Result.Result<A, E>) => {
  expect(Result.isFailure(result)).toBe(true);
};

describe("Celld immutable deployment", () => {
  test.effect(
    "matches the native module hash fixture and ignores module ordering",
    () =>
      Effect.gen(function* () {
        const prepared = yield* prepareDeployment(input);
        expect(prepared.version).toBe("0b6fc3a2f3c66b17");
        const two = [...input.modules, { name: "a.txt", content: "second" }];
        const a = yield* prepareDeployment({ ...input, modules: two });
        const b = yield* prepareDeployment({
          ...input,
          modules: [...two].reverse(),
        });
        expect(a.version).toBe(b.version);
        expect(
          (yield* prepareDeployment({
            ...input,
            metadata: { ...input.metadata, value: "changed" },
          })).version,
        ).not.toBe(prepared.version);
      }),
  );

  test.effect(
    "matches the native asset-index hash fixture and requires blobs before prefix staging",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const sha256 =
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
        const body = yield* Effect.sync(() =>
          new TextEncoder().encode("hello"),
        );
        const prepared = yield* prepareDeployment({
          ...input,
          assets: {
            index: {
              schema_version: 1,
              entries: {
                "/hello.txt": { sha256, bytes: 5, content_type: "text/plain" },
              },
              config: {},
            },
            blobs: [{ sha256, body }],
          },
        });
        expect(prepared.version).toBe("9908aa8e3f567130");
        expectFailure(
          yield* Effect.result(stageDeployment(fake.store, prepared)),
        );
        yield* stageAssetBlobs(fake.store, prepared);
        yield* stageDeployment(fake.store, prepared);
        expect(fake.objects.has(`${prepared.prefix}/assets.json`)).toBe(true);
        expect(fake.objects.has("deploy/current.json")).toBe(false);
      }),
  );

  test.effect(
    "rejects unsafe scripts, paths, duplicates, reserved classes and missing entrypoints",
    () =>
      Effect.gen(function* () {
        for (const scriptName of [
          "../bad",
          "UPPER",
          "bad-",
          "queues",
          "images",
        ])
          expectFailure(
            yield* Effect.result(prepareDeployment({ ...input, scriptName })),
          );
        for (const name of [
          "../index.js",
          "/index.js",
          "a//index.js",
          "a\\index.js",
          "manifest.json",
          "assets.json",
          "a%2fb.js",
        ])
          expectFailure(
            yield* Effect.result(
              prepareDeployment({
                ...input,
                mainModule: name,
                modules: [{ name, content: source }],
              }),
            ),
          );
        expectFailure(
          yield* Effect.result(
            prepareDeployment({
              ...input,
              modules: [...input.modules, ...input.modules],
            }),
          ),
        );
        expectFailure(
          yield* Effect.result(prepareDeployment({ ...input, modules: [] })),
        );
        expectFailure(
          yield* Effect.result(
            prepareDeployment({ ...input, doClasses: ["__Queue"] }),
          ),
        );
      }),
  );

  test.effect(
    "validates the native cron grammar and refuses unverified container publication",
    () =>
      Effect.gen(function* () {
        for (const cron of [
          "60 * * * *",
          "*/60 * * * *",
          "0 24 * * *",
          "0 0 * * 0",
          "0 0 * NOV-FEB *",
          "0 0 L-0 * *",
          "0 0 * * MON#6",
          "0 0 ? * *",
        ])
          expectFailure(
            yield* Effect.result(
              prepareDeployment({ ...input, crons: [cron] }),
            ),
          );
        for (const cron of [
          "0 0 L * *",
          "0 0 LW * *",
          "0 0 L-3W * *",
          "0 0 * * MON#2",
          "0 0 * * FRIL",
          "*/15 1-5 * JAN-MAR MON-FRI",
        ])
          expect(
            (yield* prepareDeployment({ ...input, crons: [cron] })).manifest
              .crons,
          ).toEqual([cron]);
        expectFailure(
          yield* Effect.result(
            prepareDeployment({
              ...input,
              containers: [
                { class_name: "Container", image: "celld-image:unverified" },
              ],
            }),
          ),
        );
        expectFailure(
          yield* Effect.result(
            prepareDeployment({
              ...input,
              metadata: {
                bindings: [{ type: "kv_namespace", name: "KV", id: "ns" }],
              },
            }),
          ),
        );
      }),
  );

  test.effect(
    "derives native system classes, features and queue policy identity",
    () =>
      Effect.gen(function* () {
        const prepared = yield* prepareDeployment({
          ...input,
          metadata: {
            bindings: [
              { type: "d1", name: "DB", database_name: "db" },
              { type: "kv", name: "KV", id: "ns" },
              {
                type: "workflow",
                name: "FLOW",
                workflow_name: "flow",
                class_name: "Flow",
              },
            ],
          },
          queueConsumers: [consumer],
        });
        expect(prepared.manifest.do_classes).toEqual([
          "__D1Database",
          "__KvNamespace",
          "__Queue",
          "__Workflow.app",
        ]);
        expect(prepared.manifest.required_features).toEqual([
          "d1-v1",
          "workflows-v1",
          "kv-v1",
          "queues-v1",
        ]);
        const changed = yield* prepareDeployment({
          ...input,
          queueConsumers: [{ ...consumer, max_retries: 5 }],
        });
        expect(changed.version).not.toBe(
          (yield* prepareDeployment({ ...input, queueConsumers: [consumer] }))
            .version,
        );
      }),
  );

  test.effect(
    "stages no live selectors and rejects same-version incompatible manifests",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        yield* stageDeployment(fake.store, prepared);
        expect(
          fake.writes.every(
            (key) =>
              key.startsWith(prepared.prefix + "/") ||
              key === prepared.candidate.key,
          ),
        ).toBe(true);
        yield* stageDeployment(fake.store, prepared);
        const collision = yield* prepareDeployment({
          ...input,
          doClasses: ["Other"],
        });
        expect(collision.version).toBe(prepared.version);
        expectFailure(
          yield* Effect.result(stageDeployment(fake.store, collision)),
        );
      }),
  );

  test.effect(
    "observes lost immutable write responses and never overwrites a conditional race",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        fake.loseResponse.add(prepared.objects[0]!.key);
        yield* stageDeployment(fake.store, prepared);
        const other = yield* prepareDeployment({
          ...input,
          scriptName: "other",
        });
        const body = yield* encode({ foreign: true });
        fake.race.set(other.objects[0]!.key, () =>
          fake.objects.set(other.objects[0]!.key, { body, etag: "foreign" }),
        );
        expectFailure(yield* Effect.result(stageDeployment(fake.store, other)));
        expect(fake.objects.get(other.objects[0]!.key)?.etag).toBe("foreign");
      }),
  );
});

describe("Celld Application publication", () => {
  test.effect(
    "revalidates publication under the lock after an unlocked preflight",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        const body = yield* encode(prepared.pointer);
        yield* Effect.sync(() =>
          fake.race.set(APPLICATION_LOCK_KEY, () =>
            fake.objects.set("deploy/current.json", { body, etag: "foreign" }),
          ),
        );
        const result = yield* Effect.result(
          publishApplication(fake.store, {
            rootPreparedDeployment: prepared,
            workers: [],
            owner,
            transactionId: "preflight-race",
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result))
          expect(result.failure.reason).toBe("ownership");
        expect(fake.objects.get("deploy/current.json")?.etag).toBe("foreign");
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
        expect(fake.objects.has(APPLICATION_RECEIPT_KEY)).toBe(false);
        expect(
          fake.objects.has(
            "alchemy/application/v1/transactions/preflight-race.json",
          ),
        ).toBe(false);
      }),
  );

  test.effect(
    "retains a newly acquired lock when journal persistence fails and resumes only its transaction",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        const options = {
          rootPreparedDeployment: prepared,
          workers: [],
          owner,
          transactionId: "journal-start",
        };
        const journalKey =
          "alchemy/application/v1/transactions/journal-start.json";
        yield* Effect.sync(() => fake.failBefore.add(journalKey));
        expectFailure(
          yield* Effect.result(publishApplication(fake.store, options)),
        );
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
        expect(fake.objects.has(journalKey)).toBe(false);
        expect(fake.objects.has("deploy/current.json")).toBe(false);
        expectFailure(
          yield* Effect.result(
            publishApplication(fake.store, {
              ...options,
              transactionId: "other",
            }),
          ),
        );
        const resumed = yield* publishApplication(fake.store, options);
        expect(resumed.receipt.root).toEqual(prepared.pointer);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
      }),
  );

  test.effect(
    "retains the publisher lock on callback failure and replays the committed transaction",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const root = yield* prepareDeployment(input);
        const options = {
          rootPreparedDeployment: root,
          workers: [],
          owner,
          transactionId: "activation-retry",
        };
        const failed = yield* Effect.result(
          publishApplication(fake.store, options, (publication) =>
            Effect.gen(function* () {
              expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
              expect(yield* readPublicationReceipt(fake.store)).toEqual(
                publication.receipt,
              );
              return yield* Effect.fail("activation interrupted");
            }),
          ),
        );
        expect(Result.isFailure(failed)).toBe(true);
        const receipt = (yield* readPublicationReceipt(fake.store))!;
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
        const writes = fake.writes.length;
        const resumed = yield* publishApplication(
          fake.store,
          options,
          (publication) =>
            Effect.gen(function* () {
              expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
              expect(publication.receipt).toEqual(receipt);
            }),
        );
        expect(resumed.receipt).toEqual(receipt);
        expect(fake.writes.length).toBe(writes);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
      }),
  );

  test.effect(
    "refuses receipt or lock drift during the publication callback",
    () =>
      Effect.gen(function* () {
        for (const changed of ["receipt", "receipt-rewrite", "lock"] as const) {
          const fake = yield* makeStore;
          const root = yield* prepareDeployment(input);
          const result = yield* Effect.result(
            publishApplication(
              fake.store,
              {
                rootPreparedDeployment: root,
                workers: [],
                owner,
                transactionId: `activation-${changed}`,
              },
              (publication) =>
                Effect.gen(function* () {
                  if (changed === "receipt") {
                    yield* fake.store.put(
                      APPLICATION_RECEIPT_KEY,
                      yield* encode({
                        ...publication.receipt,
                        transactionId: "foreign-operation",
                      }),
                    );
                  } else if (changed === "receipt-rewrite") {
                    yield* fake.store.put(
                      APPLICATION_RECEIPT_KEY,
                      yield* encode(publication.receipt),
                    );
                  } else {
                    const lock = (yield* fake.store.get(APPLICATION_LOCK_KEY))!;
                    yield* fake.store.put(APPLICATION_LOCK_KEY, lock.body);
                  }
                }),
            ),
          );
          expect(Result.isFailure(result)).toBe(true);
          expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
        }
      }),
  );
  test.effect(
    "prepares the real-v0.5 service graph fixture and publishes every named dependency",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const fixture = yield* prepareV05PublicationFixture;
        const result = yield* publishApplication(fake.store, {
          ...fixture,
          owner,
          transactionId: "fixture",
        });
        expect(result.receipt.workers).toEqual(
          fixture.workers.map((worker) => worker.pointer),
        );
        for (const worker of fixture.workers)
          expect(
            fake.objects.has(`deploy/${worker.scriptName}/current.json`),
          ).toBe(true);
      }),
  );

  test.effect(
    "recovers a committed native write whose journal acknowledgement was lost",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        const options = {
          rootPreparedDeployment: prepared,
          workers: [],
          owner,
          transactionId: "journal-gap",
        };
        const journalKey =
          "alchemy/application/v1/transactions/journal-gap.json";
        fake.race.set("deploy/app/current.json", () => {
          fake.failBefore.add(journalKey);
        });
        expectFailure(
          yield* Effect.result(publishApplication(fake.store, options)),
        );
        const etag = fake.objects.get("deploy/app/current.json")!.etag;
        yield* publishApplication(fake.store, options);
        expect(fake.objects.get("deploy/app/current.json")!.etag).toBe(etag);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
      }),
  );

  test.effect(
    "refuses referenced foreign consumers and non-root cron schedules",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const root = yield* prepareDeployment({
          ...input,
          metadata: {
            bindings: [{ type: "queue", name: "JOBS", queue: "jobs" }],
          },
        });
        yield* fake.store.put(
          "deploy/queues/jobs/consumer.json",
          yield* encode({
            schema_version: 1,
            queue: "jobs",
            consumer: {
              script_name: "foreign",
              version: "1111111111111111",
              prefix: "deploy/foreign/1111111111111111",
            },
          }),
        );
        expectFailure(
          yield* Effect.result(
            publishApplication(fake.store, {
              rootPreparedDeployment: root,
              workers: [],
              owner,
              transactionId: "external-queue",
            }),
          ),
        );
        const secondary = yield* prepareDeployment({
          ...input,
          scriptName: "secondary",
          crons: ["0 * * * *"],
        });
        const other = yield* makeStore;
        expectFailure(
          yield* Effect.result(
            publishApplication(other.store, {
              rootPreparedDeployment: root,
              workers: [secondary],
              owner,
              transactionId: "secondary-cron",
            }),
          ),
        );
        expect(other.writes).toEqual([]);
      }),
  );

  test.effect(
    "publishes native queue attachments, named pointers and root with a receipt",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment({
          ...input,
          queueConsumers: [consumer],
        });
        const result = yield* publishApplication(fake.store, {
          rootPreparedDeployment: prepared,
          workers: [],
          owner,
          transactionId: "first",
        });
        const attachment = yield* decode(
          Node.QueueConsumerAttachment,
          fake.objects.get("deploy/queues/jobs/consumer.json")!.body,
        );
        expect(attachment).toEqual({
          schema_version: 1,
          queue: "jobs",
          consumer: {
            script_name: "app",
            version: prepared.version,
            prefix: prepared.prefix,
          },
        });
        expect(fake.objects.has(APPLICATION_CLAIM_KEY)).toBe(true);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        expect(result.receipt.objects.every((object) => !!object.etag)).toBe(
          true,
        );
        expect(result.previous).toEqual([]);
        expect(yield* readPublicationReceipt(fake.store)).toEqual(
          result.receipt,
        );
      }),
  );

  for (const transition of [
    { name: "removing all root crons", scriptName: "app", crons: [] },
    {
      name: "changing the root script with crons",
      scriptName: "next-app",
      crons: ["*/5 * * * *"],
    },
    {
      name: "changing the root script without crons",
      scriptName: "next-app",
      crons: [],
    },
  ])
    test.effect(
      `refuses ${transition.name} before native publication writes`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeStore;
          const initial = yield* prepareDeployment({
            ...input,
            crons: ["0 * * * *"],
            queueConsumers: [consumer],
          });
          const first = yield* publishApplication(fake.store, {
            rootPreparedDeployment: initial,
            workers: [],
            owner,
            transactionId: "cron-initial",
          });
          const changed = yield* prepareDeployment({
            ...input,
            scriptName: transition.scriptName,
            crons: transition.crons,
          });
          const before = [...fake.objects];
          const writes = fake.writes.length;
          const result = yield* Effect.result(
            publishApplication(fake.store, {
              rootPreparedDeployment: changed,
              workers: [],
              owner,
              transactionId: "cron-retirement",
              priorRevision: first.revision,
            }),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("Celld.DeploymentError");
            expect(result.failure.reason).toBe("unsupported");
            expect(result.failure.message).toBe(
              "Celld v0.5.0 cannot safely retire the previous root's persisted cron cell .cron:app when changing its script identity or removing all cron triggers. Keep root script app and at least one cron trigger; this transition requires verified native cron retirement support.",
            );
          }
          expect(fake.writes.slice(writes)).toEqual([]);
          expect([...fake.objects]).toEqual(before);
          expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        }),
    );

  for (const transition of [
    { name: "removing all crons", scriptName: "app", crons: [] },
    {
      name: "changing the script with crons",
      scriptName: "next-app",
      crons: ["*/5 * * * *"],
    },
    {
      name: "changing the script without crons",
      scriptName: "next-app",
      crons: [],
    },
  ])
    test.effect(
      `refuses adopting an unclaimed cron root by ${transition.name} without writes`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeStore;
          const initial = yield* prepareDeployment({
            ...input,
            crons: ["0 * * * *"],
          });
          yield* stageDeployment(fake.store, initial);
          yield* fake.store.put(
            "deploy/current.json",
            yield* encode(initial.pointer),
          );
          yield* fake.store.put(
            "deploy/app/current.json",
            yield* encode(initial.pointer),
          );
          const changed = yield* prepareDeployment({
            ...input,
            scriptName: transition.scriptName,
            crons: transition.crons,
            queueConsumers: [consumer],
          });
          const before = [...fake.objects];
          const writes = fake.writes.length;
          const result = yield* Effect.result(
            publishApplication(fake.store, {
              rootPreparedDeployment: changed,
              workers: [],
              owner,
              transactionId: "adopt-cron",
              adopt: true,
            }),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("Celld.DeploymentError");
            expect(result.failure.reason).toBe("unsupported");
            expect(result.failure.message).toContain(".cron:app");
          }
          expect(fake.writes.slice(writes)).toEqual([]);
          expect([...fake.objects]).toEqual(before);
          expect(fake.objects.has(APPLICATION_CLAIM_KEY)).toBe(false);
          expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
          expect(fake.objects.has(APPLICATION_RECEIPT_KEY)).toBe(false);
        }),
    );

  test.effect(
    "requires explicit adoption but permits a same-script nonempty cron change",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const initial = yield* prepareDeployment({
          ...input,
          crons: ["0 * * * *"],
        });
        yield* stageDeployment(fake.store, initial);
        yield* fake.store.put(
          "deploy/current.json",
          yield* encode(initial.pointer),
        );
        yield* fake.store.put(
          "deploy/app/current.json",
          yield* encode(initial.pointer),
        );
        const changed = yield* prepareDeployment({
          ...input,
          crons: ["*/5 * * * *"],
        });
        const options = {
          rootPreparedDeployment: changed,
          workers: [],
          owner,
          transactionId: "adopt-schedule",
        };
        const refused = yield* Effect.result(
          publishApplication(fake.store, options),
        );
        expect(Result.isFailure(refused)).toBe(true);
        if (Result.isFailure(refused))
          expect(refused.failure.reason).toBe("ownership");
        const adopted = yield* publishApplication(fake.store, {
          ...options,
          adopt: true,
        });
        expect(adopted.previous).toEqual([initial.pointer]);
        expect(adopted.receipt.root).toEqual(changed.pointer);
        expect(
          (yield* decode(
            Node.Manifest,
            fake.objects.get(`${changed.prefix}/manifest.json`)!.body,
          )).crons,
        ).toEqual(["*/5 * * * *"]);
      }),
  );

  test.effect(
    "stages cron-only candidates without mutating the selected manifest, then publishes under ownership",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const initial = yield* prepareDeployment(input);
        const first = yield* publishApplication(fake.store, {
          rootPreparedDeployment: initial,
          workers: [],
          owner,
          transactionId: "one",
        });
        const changed = yield* prepareDeployment({
          ...input,
          crons: ["*/5 * * * *"],
        });
        expect(changed.version).toBe(initial.version);
        yield* stageDeployment(fake.store, changed);
        expect(
          (yield* decode(
            Node.Manifest,
            fake.objects.get(`${initial.prefix}/manifest.json`)!.body,
          )).crons,
        ).toBeUndefined();
        const second = yield* publishApplication(fake.store, {
          rootPreparedDeployment: changed,
          workers: [],
          owner,
          transactionId: "two",
          priorRevision: first.revision,
        });
        expect(second.revision).not.toBe(first.revision);
        expect(
          (yield* decode(
            Node.Manifest,
            fake.objects.get(`${initial.prefix}/manifest.json`)!.body,
          )).crons,
        ).toEqual(["*/5 * * * *"]);
        expect(second.previous).toEqual([initial.pointer]);
        const rescheduled = yield* prepareDeployment({
          ...input,
          crons: ["*/10 * * * *"],
        });
        const third = yield* publishApplication(fake.store, {
          rootPreparedDeployment: rescheduled,
          workers: [],
          owner,
          transactionId: "three",
          priorRevision: second.revision,
        });
        expect(third.revision).not.toBe(second.revision);
        expect(
          (yield* decode(
            Node.Manifest,
            fake.objects.get(`${initial.prefix}/manifest.json`)!.body,
          )).crons,
        ).toEqual(["*/10 * * * *"]);
        expect(third.previous).toEqual([changed.pointer]);
      }),
  );

  test.effect(
    "resumes its exact partial journal and blocks other operation tokens without lock expiry",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment({
          ...input,
          queueConsumers: [consumer],
        });
        const options = {
          rootPreparedDeployment: prepared,
          workers: [],
          owner,
          transactionId: "resume",
        };
        fake.failBefore.add("deploy/current.json");
        expectFailure(
          yield* Effect.result(publishApplication(fake.store, options)),
        );
        expect(fake.objects.has("deploy/app/current.json")).toBe(true);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
        expectFailure(
          yield* Effect.result(
            publishApplication(fake.store, {
              ...options,
              transactionId: "foreign",
            }),
          ),
        );
        const result = yield* publishApplication(fake.store, options);
        expect(result.receipt.root).toEqual(prepared.pointer);
        expect(fake.objects.has(APPLICATION_LOCK_KEY)).toBe(false);
        expect((yield* publishApplication(fake.store, options)).revision).toBe(
          result.revision,
        );
      }),
  );

  test.effect(
    "rejects foreign permanent claims and unclaimed non-bootstrap roots",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        yield* stageDeployment(fake.store, prepared);
        yield* fake.store.put(
          "deploy/current.json",
          yield* encode(prepared.pointer),
        );
        expectFailure(
          yield* Effect.result(
            publishApplication(fake.store, {
              rootPreparedDeployment: prepared,
              workers: [],
              owner,
              transactionId: "unowned",
            }),
          ),
        );
        const foreign = yield* makeStore;
        yield* foreign.store.put(
          APPLICATION_CLAIM_KEY,
          yield* encode({ ...owner, fqn: "Other" }),
        );
        expectFailure(
          yield* Effect.result(
            publishApplication(foreign.store, {
              rootPreparedDeployment: prepared,
              workers: [],
              owner,
              transactionId: "foreign",
              adopt: true,
            }),
          ),
        );
      }),
  );

  test.effect(
    "detaches only owned queue attachments and preserves queue data",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const old = yield* prepareDeployment({
          ...input,
          queueConsumers: [consumer],
        });
        const first = yield* publishApplication(fake.store, {
          rootPreparedDeployment: old,
          workers: [],
          owner,
          transactionId: "attach",
        });
        yield* fake.store.put(
          "cells/__Queue:fixture/data",
          yield* encode({ retained: true }),
        );
        const next = yield* prepareDeployment(input);
        yield* publishApplication(fake.store, {
          rootPreparedDeployment: next,
          workers: [],
          owner,
          transactionId: "detach",
          priorRevision: first.revision,
        });
        expect(
          (yield* decode(
            Node.QueueConsumerAttachment,
            fake.objects.get("deploy/queues/jobs/consumer.json")!.body,
          )).consumer,
        ).toBeUndefined();
        expect(fake.objects.has("cells/__Queue:fixture/data")).toBe(true);
      }),
  );

  test.effect(
    "refuses an unowned matching-script consumer and preserves raced live pointers",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment({
          ...input,
          queueConsumers: [consumer],
        });
        yield* fake.store.put(
          "deploy/queues/jobs/consumer.json",
          yield* encode({
            schema_version: 1,
            queue: "jobs",
            consumer: {
              script_name: "app",
              version: prepared.version,
              prefix: prepared.prefix,
            },
          }),
        );
        expectFailure(
          yield* Effect.result(
            publishApplication(fake.store, {
              rootPreparedDeployment: prepared,
              workers: [],
              owner,
              transactionId: "not-owned",
            }),
          ),
        );
        const race = yield* makeStore;
        const body = yield* encode({ foreign: true });
        race.race.set("deploy/current.json", () =>
          race.objects.set("deploy/current.json", { body, etag: "winner" }),
        );
        expectFailure(
          yield* Effect.result(
            publishApplication(race.store, {
              rootPreparedDeployment: prepared,
              workers: [],
              owner,
              transactionId: "race",
            }),
          ),
        );
        expect(race.objects.get("deploy/current.json")!.etag).toBe("winner");
        expect(race.objects.has(APPLICATION_LOCK_KEY)).toBe(true);
      }),
  );

  test.effect(
    "observes ambiguous live writes and refuses token reuse with different desired state",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeStore;
        const prepared = yield* prepareDeployment(input);
        fake.loseResponse.add("deploy/current.json");
        yield* publishApplication(fake.store, {
          rootPreparedDeployment: prepared,
          workers: [],
          owner,
          transactionId: "lost-response",
        });
        const changed = yield* prepareDeployment({
          ...input,
          crons: ["0 * * * *"],
        });
        expectFailure(
          yield* Effect.result(
            publishApplication(fake.store, {
              rootPreparedDeployment: changed,
              workers: [],
              owner,
              transactionId: "lost-response",
            }),
          ),
        );
      }),
  );
});
