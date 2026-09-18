import * as NodeServices from "@effect/platform-node/NodeServices";
import { Unowned } from "@/AdoptPolicy.ts";
import { Database, DatabaseProvider } from "@/Celld/D1/Database.ts";
import {
  FleetStorage,
  FleetStorageError,
  type Store,
  type StoredObject,
} from "@/Celld/FleetStorage.ts";
import { d1Scope, FleetOperator } from "@/Celld/OperatorClient.ts";
import { readCatalog } from "@/Celld/ResourceCatalog.ts";
import { InstanceId } from "@/InstanceId.ts";
import { noopSession } from "@/Report.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

const connection = {
  fleetId: "Fleet",
  fleetUrl: "http://node",
  bucket: { uri: "s3://data" },
  hostState: undefined,
};
const instanceId = "0123456789abcdef0123456789abcdef";
const input = {
  id: "Db",
  fqn: "Db",
  instanceId,
  session: { ...noopSession, note: () => Effect.void },
  bindings: [],
  olds: undefined,
  output: undefined,
};

const fixture = Effect.sync(() => {
  const objects = new Map<string, StoredObject>();
  const calls: Array<{ scope: string; name?: string }> = [];
  let sequence = 0;
  const store: Store = {
    get: (key) => Effect.sync(() => objects.get(key)),
    put: (key, body, condition) =>
      Effect.gen(function* () {
        const old = objects.get(key);
        if (
          (condition?.ifNoneMatch && old) ||
          (condition?.ifMatch && old?.etag !== condition.ifMatch)
        ) {
          return yield* Effect.fail(
            new FleetStorageError({
              reason: "conflict",
              message: "Conditional write conflict",
            }),
          );
        }
        const value = { body, etag: String(++sequence) };
        objects.set(key, value);
        return { etag: value.etag };
      }),
    delete: () =>
      Effect.die(
        "Resource deletion must retain native data and catalog records",
      ),
    list: (prefix) =>
      Effect.sync(() =>
        [...objects]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, etag: value.etag })),
      ),
  };
  const services = Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(FleetStorage, () => Effect.succeed(store)),
    Layer.succeed(FleetOperator, {
      execD1: () => Effect.die("not used"),
      migrateD1: () => Effect.die("not used"),
      executeD1Statements: (_connection, request) =>
        Effect.sync(() => {
          calls.push(request);
          expect(request.statements).toEqual([{ sql: "SELECT 1;" }]);
          return { result: [{ columns: ["1"], rows: [[1]] }] };
        }),
    }),
    Layer.succeed(Stack, {
      name: "d1-resource",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(Stage, "test"),
    Layer.succeed(InstanceId, instanceId),
  );
  return {
    objects,
    calls,
    layer: DatabaseProvider().pipe(Layer.provideMerge(services)),
  };
});

it.effect(
  "D1 recovers its catalog claim, activates before application publication, and retains data",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const provider = yield* Database.Provider;
        const news = { ...connection, name: "database" };
        const created = yield* provider.reconcile({ ...input, news });
        expect(created.databaseId).toBe("database");
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]?.scope).toBe(yield* d1Scope("database"));
        expect(f.calls[0]?.name).toBe("database");
        expect(yield* provider.read!({ ...input, olds: news })).toEqual(
          created,
        );
        yield* provider.reconcile({ ...input, news, output: created });
        const nativeKey = `cells/${yield* d1Scope("database")}/data`;
        yield* Effect.sync(() =>
          f.objects.set(nativeKey, {
            body: new Uint8Array([1]),
            etag: "native",
          }),
        );
        yield* provider.delete({ ...input, olds: news, output: created });
        yield* provider.delete({ ...input, olds: news, output: created });
        expect(f.objects.has(nativeKey)).toBe(true);
        const retained = yield* readCatalog(connection, "d1", "database");
        expect(retained?.retained).toBe(true);
        expect(retained?.owner.instanceId).toBe(instanceId);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "D1 replaces physical identities and fleet changes and refuses foreign retained claims",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const provider = yield* Database.Provider;
        const news = { ...connection, name: "database" };
        const output = yield* provider.reconcile({ ...input, news });
        for (const changed of [
          { ...news, name: "renamed" },
          { ...news, fleetId: "Other" },
          { ...news, bucket: { uri: "s3://other" } },
        ]) {
          expect(
            yield* provider.diff!({
              ...input,
              olds: news,
              news: changed,
              output,
              oldBindings: [],
              newBindings: [],
            }),
          ).toEqual({ action: "replace" });
        }
        expect(
          Unowned.is(
            yield* provider.read!({ ...input, fqn: "Foreign", olds: news }),
          ),
        ).toBe(true);
        expect(
          Result.isFailure(
            yield* provider
              .reconcile({ ...input, fqn: "Foreign", news, output })
              .pipe(Effect.result),
          ),
        ).toBe(true);
        expect(f.calls).toHaveLength(1);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect(
  "D1 refuses unclaimed native data before creating a catalog or making an operator call",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const scope = yield* d1Scope("database");
      yield* Effect.sync(() =>
        f.objects.set(`cells/${scope}/data`, {
          body: new Uint8Array([1]),
          etag: "native",
        }),
      );
      yield* Effect.gen(function* () {
        const provider = yield* Database.Provider;
        const outcome = yield* provider
          .reconcile({ ...input, news: { ...connection, name: "database" } })
          .pipe(Effect.result);
        expect(Result.isFailure(outcome)).toBe(true);
        expect(f.calls).toHaveLength(0);
        expect(f.objects.size).toBe(1);
      }).pipe(Effect.provide(f.layer));
    }),
);
