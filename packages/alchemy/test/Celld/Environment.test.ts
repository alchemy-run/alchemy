import { lowerEnvironment } from "@/Celld/Environment";
import { validateStorageBindings } from "@/Celld/KV/StorageBinding";
import * as Output from "@/Output";
import { ref } from "@/Ref";
import { inMemoryState } from "@/State/InMemoryState";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const resource = (
  Type: string,
  FQN: string,
  attributes: Record<string, string>,
  fleetId = "Cells",
  fleetUrl = "http://cells:8080",
) => ({
  Type,
  FQN,
  LogicalId: FQN.split("/").at(-1)!,
  fleetId: Output.literal(fleetId),
  fleetUrl: Output.literal(fleetUrl),
  ...Object.fromEntries(
    Object.entries(attributes).map(([name, value]) => [
      name,
      Output.literal(value),
    ]),
  ),
});
const StorageMetadata = Schema.Array(
  Schema.Struct({
    resource: Schema.String,
    fleetId: Schema.String,
    fleetUrl: Schema.String,
  }),
);

describe("Celld environment lowering", () => {
  test.effect(
    "lowers storage and Worker resources using physical output names",
    () =>
      Effect.gen(function* () {
        const values = {
          CACHE: resource("Celld.KV.Namespace", "Scope/Cache", {
            namespaceId: "kv-identity",
            title: "cache-title",
          }),
          FILES: resource("Celld.R2.Bucket", "Scope/Files", {
            bucketName: "bucket-identity",
          }),
          JOBS: resource("Celld.Queues.Queue", "Scope/Jobs", {
            queueName: "queue-name",
            queueId: "not-the-binding-name",
          }),
          DB: resource("Celld.D1.Database", "Scope/Db", {
            databaseId: "db-id",
            databaseName: "db-name",
          }),
          API: resource("Celld.Worker", "Scope/Api", {
            workerName: "worker-physical-name",
          }),
        };
        const lowered = yield* lowerEnvironment(values);
        expect(lowered.env).toEqual({});
        expect(yield* Output.evaluate(lowered.bindings, {})).toEqual([
          { type: "kv_namespace", name: "CACHE", namespaceId: "kv-identity" },
          { type: "r2_bucket", name: "FILES", bucketName: "bucket-identity" },
          { type: "queue", name: "JOBS", queueName: "queue-name" },
          { type: "d1", name: "DB", id: "db-id", databaseName: "db-name" },
          { type: "service", name: "API", service: "worker-physical-name" },
        ]);
        const metadata = yield* Schema.decodeUnknownEffect(StorageMetadata)(
          yield* Output.evaluate(lowered.storageBindings, {}),
        );
        expect(metadata.map((value) => value.resource)).toEqual([
          "Scope/Cache",
          "Scope/Files",
          "Scope/Jobs",
          "Scope/Db",
          "Scope/Api",
        ]);
        yield* validateStorageBindings(
          { fleetId: "Cells", fleetUrl: "http://cells:8080" },
          metadata,
        );
      }).pipe(Effect.provide(inMemoryState())),
  );

  test.effect(
    "preserves literals, Outputs, nested values and reserved object keys",
    () =>
      Effect.gen(function* () {
        let evaluated = 0;
        const deferred = Output.fromEffect(
          Effect.sync(() => {
            evaluated++;
            return "deferred";
          }),
        );
        const callable = () => {
          evaluated++;
          return "literal function";
        };
        const data = {
          Type: "Celld.KV.Namespace",
          namespaceId: "ordinary-data",
        };
        const secret = Redacted.make("secret");
        const nested = {
          deferred,
          resource: resource("Celld.KV.Namespace", "Nested/Cache", {
            namespaceId: "id",
          }),
        };
        const values = Object.fromEntries([
          ["TEXT", "text"],
          ["NUMBER", 0],
          ["FALSE", false],
          ["NULL", null],
          ["UNDEFINED", undefined],
          ["JSON", data],
          ["ARRAY", [1, null]],
          ["SECRET", secret],
          ["OUTPUT", deferred],
          ["FUNCTION", callable],
          ["NESTED", nested],
          ["__proto__", { safe: true }],
          ["constructor", "constructor-data"],
        ]);
        const lowered = yield* lowerEnvironment(values);
        for (const [name, value] of Object.entries(values))
          expect(lowered.env[name]).toBe(value);
        expect(Object.hasOwn(lowered.env, "__proto__")).toBe(true);
        expect(Object.getPrototypeOf(lowered.env)).toBe(Object.prototype);
        expect(lowered.bindings).toEqual([]);
        expect(lowered.storageBindings).toEqual([]);
        expect(evaluated).toBe(0);
      }),
  );

  test.effect(
    "resolves constructor Effects once but preserves returned Outputs",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const cache = resource("Celld.KV.Namespace", "Cache", {
          namespaceId: "id",
        });
        const deferred = Output.literal("later");
        const lowered = yield* lowerEnvironment({
          CACHE: Effect.sync(() => {
            calls++;
            return cache;
          }),
          TEXT: Effect.sync(() => {
            calls++;
            return "ready";
          }),
          OUTPUT: Effect.sync(() => {
            calls++;
            return deferred;
          }),
        });
        expect(calls).toBe(3);
        expect(lowered.env).toEqual({ TEXT: "ready", OUTPUT: deferred });
        expect(yield* Output.evaluate(lowered.bindings, {})).toEqual([
          { type: "kv_namespace", name: "CACHE", namespaceId: "id" },
        ]);
        const failure = yield* Effect.result(
          lowerEnvironment({ VALUE: Effect.fail("constructor failed") }),
        );
        expect(Result.isFailure(failure) && failure.failure).toBe(
          "constructor failed",
        );
      }).pipe(Effect.provide(inMemoryState())),
  );

  test.effect(
    "keeps same logical namespace names distinct and records every fleet check",
    () =>
      Effect.gen(function* () {
        const first = resource("Celld.KV.Namespace", "First/Cache", {
          namespaceId: "first",
          title: "cache",
        });
        const second = resource("Celld.KV.Namespace", "Second/Cache", {
          namespaceId: "second",
          title: "cache",
        });
        const lowered = yield* lowerEnvironment({
          FIRST: first,
          SECOND: second,
          ALIAS: first,
        });
        expect(yield* Output.evaluate(lowered.bindings, {})).toEqual([
          { type: "kv_namespace", name: "FIRST", namespaceId: "first" },
          { type: "kv_namespace", name: "SECOND", namespaceId: "second" },
          { type: "kv_namespace", name: "ALIAS", namespaceId: "first" },
        ]);
        const metadata = yield* Schema.decodeUnknownEffect(StorageMetadata)(
          yield* Output.evaluate(lowered.storageBindings, {}),
        );
        expect(metadata.map((value) => value.resource)).toEqual([
          "First/Cache",
          "Second/Cache",
          "First/Cache",
        ]);
        yield* validateStorageBindings(
          { fleetId: "Cells", fleetUrl: "http://cells:8080" },
          metadata,
        );
        for (const foreign of [
          resource(
            "Celld.KV.Namespace",
            "Foreign/Cache",
            { namespaceId: "foreign" },
            "Other",
            "http://cells:8080",
          ),
          resource(
            "Celld.KV.Namespace",
            "Foreign/Cache",
            { namespaceId: "foreign" },
            "Cells",
            "http://other:8080",
          ),
        ]) {
          const other = yield* lowerEnvironment({ FOREIGN: foreign });
          const checks = yield* Schema.decodeUnknownEffect(StorageMetadata)(
            yield* Output.evaluate(other.storageBindings, {}),
          );
          const result = yield* Effect.result(
            validateStorageBindings(
              { fleetId: "Cells", fleetUrl: "http://cells:8080" },
              checks,
            ),
          );
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            "Celld.StorageFleetMismatch",
          );
        }
      }).pipe(Effect.provide(inMemoryState())),
  );

  test.effect(
    "classifies native references without resolving state or inventing an FQN attribute",
    () =>
      Effect.gen(function* () {
        const reference = ref(
          "Nested/Cache",
          { stack: "other", stage: "test" },
          "Celld.KV.Namespace",
        );
        const lowered = yield* lowerEnvironment({ CACHE: reference });
        expect(lowered.env).toEqual({});
        expect(lowered.bindings).toHaveLength(1);
        expect(Reflect.get(lowered.bindings[0]!, "name")).toBe("CACHE");
        expect(
          Output.isOutput(Reflect.get(lowered.bindings[0]!, "namespaceId")),
        ).toBe(true);
        expect(Reflect.get(lowered.storageBindings[0]!, "resource")).toBe(
          "Nested/Cache",
        );
        expect(
          Output.isOutput(Reflect.get(lowered.storageBindings[0]!, "fleetId")),
        ).toBe(true);
        const expression = Output.of(reference);
        const expressionLowered = yield* lowerEnvironment({
          CACHE: expression,
        });
        expect(
          Reflect.get(expressionLowered.storageBindings[0]!, "resource"),
        ).toBe("Nested/Cache");
      }),
  );
});
