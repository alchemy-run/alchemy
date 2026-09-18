import { Unowned } from "@/AdoptPolicy.ts";
import {
  FleetStorage,
  FleetStorageError,
  type Store,
  type StoredObject,
} from "@/Celld/FleetStorage.ts";
import { Namespace, NamespaceProvider } from "@/Celld/KV/Namespace.ts";
import {
  Bucket,
  BucketProvider,
  validateBucketName,
} from "@/Celld/R2/Bucket.ts";
import {
  Queue,
  QueueProvider,
  validateQueueName,
} from "@/Celld/Queues/Queue.ts";
import {
  catalogKey,
  ensureCatalog,
  nativeResourcePrefixes,
  readCatalog,
  retainCatalog,
  type CatalogRecord,
} from "@/Celld/ResourceCatalog.ts";
import { InstanceId } from "@/InstanceId.ts";
import { noopSession } from "@/Report.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

const connection = {
  fleetId: "Cells",
  fleetUrl: "http://cells:8080",
  bucket: { uri: "s3://cells" },
  hostState: undefined,
};
const instanceId = "0123456789abcdef0123456789abcdef";
const owner = {
  stack: "catalog-test",
  stage: "test",
  fqn: "Files",
  instanceId,
};
const desired: CatalogRecord = {
  version: 1,
  kind: "r2",
  physicalId: "files",
  label: "files",
  fleetId: "Cells",
  owner,
  retained: false,
};
const session = { ...noopSession, note: () => Effect.void };

const memoryStore = () =>
  Effect.sync(() => {
    const objects = new Map<string, StoredObject>();
    const writes: {
      key: string;
      condition: { ifMatch?: string; ifNoneMatch?: boolean } | undefined;
    }[] = [];
    let sequence = 0;
    const race = {
      remaining: 0,
      winner: undefined as CatalogRecord | undefined,
    };
    const conflict = () =>
      new FleetStorageError({
        reason: "conflict",
        message: "Conditional write conflict",
      });
    const store: Store = {
      get: (key) => Effect.sync(() => objects.get(key)),
      put: (key, body, condition) =>
        Effect.gen(function* () {
          return yield* Effect.suspend(() => {
            writes.push({ key, condition });
            if (race.remaining > 0) {
              race.remaining--;
              if (race.winner)
                objects.set(key, {
                  body: new TextEncoder().encode(JSON.stringify(race.winner)),
                  etag: String(++sequence),
                });
              return Effect.fail(conflict());
            }
            const previous = objects.get(key);
            if (
              (condition?.ifNoneMatch && previous) ||
              (condition?.ifMatch !== undefined &&
                previous?.etag !== condition.ifMatch)
            )
              return Effect.fail(conflict());
            const etag = String(++sequence);
            objects.set(key, { body, etag });
            return Effect.succeed({ etag });
          });
        }),
      delete: () => Effect.die("Catalog must never delete objects"),
      list: (prefix) =>
        Effect.sync(() =>
          [...objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, etag: value.etag })),
        ),
    };
    return { store, objects, writes, race };
  });

type Memory = Effect.Success<ReturnType<typeof memoryStore>>;
const environment = (memory: Memory) =>
  Layer.mergeAll(
    Layer.succeed(FleetStorage, () => Effect.succeed(memory.store)),
    Layer.succeed(Stack, {
      name: owner.stack,
      stage: owner.stage,
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, owner.stage),
    Layer.succeed(InstanceId, instanceId),
  );
const providers = (memory: Memory) =>
  Layer.mergeAll(NamespaceProvider(), BucketProvider(), QueueProvider()).pipe(
    Layer.provideMerge(environment(memory)),
  );
const withStore = <A, E>(
  body: (memory: Memory) => Effect.Effect<A, E, FleetStorage>,
) =>
  Effect.gen(function* () {
    const memory = yield* memoryStore();
    return yield* body(memory).pipe(Effect.provide(environment(memory)));
  });
const input = {
  id: "Files",
  fqn: owner.fqn,
  instanceId,
  session,
  bindings: [],
  output: undefined,
  olds: undefined,
};

const expectReason = <A>(
  result: Result.Result<A, { reason: string }>,
  reason: string,
) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure.reason).toBe(reason);
};

describe("Celld retained catalog", () => {
  it.effect(
    "conditionally claims, observes, updates and retains without deleting native data",
    () =>
      withStore((memory) =>
        Effect.gen(function* () {
          yield* ensureCatalog(connection, desired);
          expect(memory.writes[0]?.condition).toEqual({ ifNoneMatch: true });
          yield* ensureCatalog(connection, desired);
          expect(memory.writes).toHaveLength(1);
          yield* ensureCatalog(connection, { ...desired, label: "renamed" });
          expect(memory.writes[1]?.condition).toEqual({ ifMatch: "1" });
          yield* retainCatalog(connection, desired);
          yield* retainCatalog(connection, desired);
          const record = yield* readCatalog(connection, "r2", "files");
          expect(record?.retained).toBe(true);
          expect(record?.label).toBe("renamed");
          expect(record?.owner).toEqual(owner);
          expect(memory.writes).toHaveLength(3);
          expect(
            memory.writes.every(({ key }) =>
              key.startsWith("alchemy/resources/v1/"),
            ),
          ).toBe(true);
        }),
      ),
  );

  it.effect("re-reads after a same-owner conditional claim race", () =>
    withStore((memory) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          memory.race.remaining = 1;
          memory.race.winner = desired;
        });
        expect(yield* ensureCatalog(connection, desired)).toEqual(desired);
        expect(memory.writes).toHaveLength(1);
      }),
    ),
  );

  it.effect(
    "rejects a foreign winner instead of claiming it after a race",
    () =>
      withStore((memory) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            memory.race.remaining = 1;
            memory.race.winner = {
              ...desired,
              owner: { ...owner, fqn: "Foreign" },
            };
          });
          expectReason(
            yield* Effect.result(ensureCatalog(connection, desired)),
            "ownership",
          );
          expect(memory.writes).toHaveLength(1);
        }),
      ),
  );

  it.effect("bounds repeated conditional conflicts", () =>
    withStore((memory) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          memory.race.remaining = 10;
        });
        expectReason(
          yield* Effect.result(ensureCatalog(connection, desired)),
          "conflict",
        );
        expect(memory.writes).toHaveLength(5);
      }),
    ),
  );

  it.effect("rejects corrupt catalog records without overwriting them", () =>
    withStore((memory) =>
      Effect.gen(function* () {
        yield* Effect.sync(() =>
          memory.objects.set(catalogKey("r2", "files"), {
            body: new TextEncoder().encode('{"version":0}'),
            etag: "bad",
          }),
        );
        expectReason(
          yield* Effect.result(ensureCatalog(connection, desired)),
          "invalid-record",
        );
        expect(memory.writes).toHaveLength(0);
      }),
    ),
  );

  for (const kind of ["kv", "r2", "queue"] as const) {
    it.effect(`refuses pre-existing ${kind} native data without a claim`, () =>
      withStore((memory) =>
        Effect.gen(function* () {
          const prefixes = yield* nativeResourcePrefixes(kind, "files");
          yield* Effect.sync(() =>
            memory.objects.set(`${prefixes[0]}data`, {
              body: new Uint8Array(),
              etag: "native",
            }),
          );
          expectReason(
            yield* Effect.result(
              ensureCatalog(connection, { ...desired, kind }),
            ),
            "unmanaged-data",
          );
          expect(memory.writes).toHaveLength(0);
          expect(memory.objects.size).toBe(1);
        }),
      ),
    );
  }

  it.effect("never transfers a retained claim to a new instance or fleet", () =>
    withStore(() =>
      Effect.gen(function* () {
        yield* ensureCatalog(connection, desired);
        yield* retainCatalog(connection, desired);
        expectReason(
          yield* Effect.result(
            ensureCatalog(connection, {
              ...desired,
              owner: { ...owner, instanceId: "replacement" },
            }),
          ),
          "ownership",
        );
        expectReason(
          yield* Effect.result(
            ensureCatalog(connection, { ...desired, fleetId: "OtherCells" }),
          ),
          "ownership",
        );
      }),
    ),
  );
});

describe("Celld retained resource providers", () => {
  it.effect(
    "KV creates, reads observed metadata, updates title, replaces fleet, and retains",
    () =>
      Effect.gen(function* () {
        const memory = yield* memoryStore();
        yield* Effect.gen(function* () {
          const provider = yield* Namespace.Provider;
          const news = { ...connection, title: "Cache" };
          const created = yield* provider.reconcile({ ...input, news });
          expect(created.title).toBe("Cache");
          expect(created.namespaceId).toContain("catalog-test-Files-test-");
          const restored = yield* provider.read!({ ...input, olds: news });
          expect(restored).toEqual(created);
          const updated = yield* provider.reconcile({
            ...input,
            news: { ...news, title: "Updated" },
            olds: news,
            output: created,
          });
          expect(updated.namespaceId).toBe(created.namespaceId);
          expect(updated.title).toBe("Updated");
          expect(
            (yield* provider.read!({ ...input, olds: news, output: created }))
              ?.title,
          ).toBe("Updated");
          expect(
            yield* provider.diff!({
              ...input,
              olds: news,
              news: { ...news, fleetId: "Other" },
              oldBindings: [],
              newBindings: [],
              output: created,
            }),
          ).toEqual({ action: "replace" });
          const replacement = yield* provider.reconcile({
            ...input,
            instanceId: "1123456789abcdef0123456789abcdef",
            news,
          });
          expect(replacement.namespaceId).not.toBe(created.namespaceId);
          yield* provider.delete({ ...input, olds: news, output: updated });
          expect(
            (yield* readCatalog(connection, "kv", updated.namespaceId))
              ?.retained,
          ).toBe(true);
          expect(
            (yield* readCatalog(connection, "kv", replacement.namespaceId))
              ?.retained,
          ).toBe(false);
        }).pipe(Effect.provide(providers(memory)));
      }),
  );

  it.effect(
    "R2 creates, recovers, replaces a name, refuses adoption, and retains objects",
    () =>
      Effect.gen(function* () {
        const memory = yield* memoryStore();
        yield* Effect.gen(function* () {
          const provider = yield* Bucket.Provider;
          const news = { ...connection, bucketName: "files" };
          const created = yield* provider.reconcile({ ...input, news });
          expect(yield* provider.read!({ ...input, olds: news })).toEqual(
            created,
          );
          expect(
            yield* provider.diff!({
              ...input,
              olds: news,
              news: { ...news, bucketName: "files-v2" },
              oldBindings: [],
              newBindings: [],
              output: created,
            }),
          ).toEqual({ action: "replace" });
          const renamed = yield* provider.reconcile({
            ...input,
            instanceId: "1123456789abcdef0123456789abcdef",
            news: { ...news, bucketName: "files-v2" },
          });
          expect(renamed.bucketName).toBe("files-v2");
          const foreign = yield* provider.read!({
            ...input,
            fqn: "Foreign",
            olds: news,
          });
          expect(Unowned.is(foreign)).toBe(true);
          const adopted = yield* Effect.result(
            provider.reconcile({
              ...input,
              fqn: "Foreign",
              news,
              output: created,
            }),
          );
          expect(Result.isFailure(adopted)).toBe(true);
          yield* Effect.sync(() =>
            memory.objects.set("r2/files/native", {
              body: new Uint8Array([1]),
              etag: "native",
            }),
          );
          yield* provider.delete({ ...input, olds: news, output: created });
          expect(memory.objects.has("r2/files/native")).toBe(true);
          expect(
            (yield* readCatalog(connection, "r2", "files"))?.retained,
          ).toBe(true);
          expect(
            (yield* readCatalog(connection, "r2", "files-v2"))?.retained,
          ).toBe(false);
        }).pipe(Effect.provide(providers(memory)));
      }),
  );

  it.effect(
    "Queue uses name props, observes claims, replaces names, and retains ownership",
    () =>
      Effect.gen(function* () {
        const memory = yield* memoryStore();
        yield* Effect.gen(function* () {
          const provider = yield* Queue.Provider;
          const news = { ...connection, name: "jobs" };
          const created = yield* provider.reconcile({ ...input, news });
          expect(created.queueId).toBe("jobs");
          expect(created.queueName).toBe("jobs");
          expect(yield* provider.read!({ ...input, olds: news })).toEqual(
            created,
          );
          expect(
            yield* provider.diff!({
              ...input,
              olds: news,
              news: { ...news, name: "jobs-v2" },
              oldBindings: [],
              newBindings: [],
              output: created,
            }),
          ).toEqual({ action: "replace" });
          expect(
            Unowned.is(
              yield* provider.read!({ ...input, fqn: "Foreign", olds: news }),
            ),
          ).toBe(true);
          yield* provider.delete({ ...input, olds: news, output: created });
          expect(
            (yield* readCatalog(connection, "queue", "jobs"))?.owner,
          ).toEqual(owner);
          expect(
            (yield* readCatalog(connection, "queue", "jobs"))?.retained,
          ).toBe(true);
          yield* Effect.sync(() =>
            memory.objects.delete(catalogKey("queue", "jobs")),
          );
          expect(
            yield* provider.read!({ ...input, olds: news, output: created }),
          ).toBeUndefined();
        }).pipe(Effect.provide(providers(memory)));
      }),
  );

  it.effect(
    "validates native bucket and queue names before creating claims",
    () =>
      Effect.gen(function* () {
        for (const name of ["", ".", "..", "a/b", "x".repeat(256)]) {
          expect(
            Result.isFailure(yield* Effect.result(validateQueueName(name))),
          ).toBe(true);
        }
        for (const name of ["", "-files", "a/b", "x".repeat(65)]) {
          expect(
            Result.isFailure(yield* Effect.result(validateBucketName(name))),
          ).toBe(true);
        }
        yield* validateQueueName("jobs.$:v1");
        yield* validateBucketName("Files_v1");
      }),
  );
});
