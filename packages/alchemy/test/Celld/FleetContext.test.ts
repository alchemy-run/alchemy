import { Fleet } from "@/Celld/Fleet.ts";
import {
  CurrentFleet,
  FleetRegistrationConflict,
} from "@/Celld/FleetContext.ts";
import { Namespace } from "@/Celld/KV/Namespace.ts";
import {
  storageFleetProps,
  validateStorageBindings,
} from "@/Celld/KV/StorageBinding.ts";
import { Bucket } from "@/Celld/R2/Bucket.ts";
import { Queue } from "@/Celld/Queues/Queue.ts";
import { Providers } from "@/Celld/Providers.ts";
import * as Provider from "@/Provider.ts";
import * as NamespaceScope from "@/Namespace.ts";
import * as Output from "@/Output.ts";
import { Resource } from "@/Resource.ts";
import { Stack } from "@/Stack.ts";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

const FleetResource = Resource<Fleet>("Celld.Fleet");
const fleet = (id: string) =>
  FleetResource(id, {
    bucket: { uri: `s3://${id}` },
    fleetUrl: `http://${id}:8080`,
  });
const environment = () =>
  Layer.mergeAll(
    Layer.succeed(Stack, {
      name: "fleet-context-test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.effect(Providers, Provider.collection([])),
  );

describe("Celld ambient Fleet", () => {
  it.effect(
    "Fleet.layer captures selected fleet and connection Outputs on all persistent declarations",
    () =>
      Effect.gen(function* () {
        const cells = yield* CurrentFleet;
        const cache = yield* Namespace("Cache", { title: "cache" });
        const files = yield* Bucket("Files", { bucketName: "files" });
        const jobs = yield* Queue("Work", { name: "jobs" });
        for (const resource of [cache, files, jobs]) {
          expect(resource.Props.fleetId).toBe("Cells");
          for (const key of ["fleetUrl", "bucket", "hostState"] as const) {
            const value = resource.Props[key];
            expect(Output.isPropExpr(value)).toBe(true);
            if (Output.isPropExpr(value)) expect(value.identifier).toBe(key);
            expect(Output.resolveUpstream(value).Cells).toBe(cells);
          }
        }
        expect(cache.Props.title).toBe("cache");
        expect(files.Props.bucketName).toBe("files");
        expect(jobs.Props.name).toBe("jobs");
        expect(yield* Namespace("Cache")).toBe(cache);
      }).pipe(
        Effect.provide(
          Fleet.layer(fleet("Cells")).pipe(Layer.provideMerge(environment())),
        ),
      ),
  );

  it.effect(
    "rejects a conflicting registration across fleets instead of reusing the first resource",
    () =>
      Effect.gen(function* () {
        yield* Namespace("Cache").pipe(
          Effect.provide(Fleet.layer(fleet("First"))),
        );
        const result = yield* Effect.exit(
          Namespace("Cache").pipe(Effect.provide(Fleet.layer(fleet("Second")))),
        );
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(Cause.hasDies(result.cause)).toBe(true);
          expect(Cause.squash(result.cause)).toBeInstanceOf(
            FleetRegistrationConflict,
          );
        }
      }).pipe(Effect.provide(environment())),
  );

  it.effect(
    "allows nested fleet layers when logical resources use distinct namespaces",
    () =>
      Effect.gen(function* () {
        const outer = yield* Namespace("Cache");
        const inner = yield* NamespaceScope.push(
          "Nested",
          Namespace("Cache").pipe(Effect.provide(Fleet.layer(fleet("Other")))),
        );
        const after = yield* Bucket("After");
        expect(outer.FQN).toBe("Cache");
        expect(inner.FQN).toBe("Nested/Cache");
        expect(inner.Props.fleetId).toBe("Nested/Other");
        expect(after.Props.fleetId).toBe("Cells");
      }).pipe(
        Effect.provide(
          Fleet.layer(fleet("Cells")).pipe(Layer.provideMerge(environment())),
        ),
      ),
  );

  it.effect(
    "constructor effects keep ambient selection rather than exposing the raw constructor",
    () =>
      Effect.gen(function* () {
        const declare = yield* Namespace;
        const cache = yield* declare("Cache");
        expect(cache.Props.fleetId).toBe("Cells");
      }).pipe(
        Effect.provide(
          Fleet.layer(fleet("Cells")).pipe(Layer.provideMerge(environment())),
        ),
      ),
  );

  it.effect(
    "runtime references and helper never require CurrentFleet",
    () =>
      Effect.gen(function* () {
        const previous = yield* Effect.sync(
          () => globalThis.__ALCHEMY_RUNTIME__,
        );
        yield* Effect.gen(function* () {
          yield* Effect.sync(() => {
            globalThis.__ALCHEMY_RUNTIME__ = true;
          });
          expect(yield* storageFleetProps()).toEqual({});
          expect((yield* Namespace("Cache")).FQN).toBe("Cache");
          expect((yield* Bucket("Files")).FQN).toBe("Files");
          expect((yield* Queue("Work")).FQN).toBe("Work");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              globalThis.__ALCHEMY_RUNTIME__ = previous;
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Fleet.layer(fleet("Unused")).pipe(Layer.provideMerge(environment())),
        ),
      ),
    { exclusive: true },
  );

  it.effect(
    "binding validation rejects cross-fleet identities even with matching endpoints",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          validateStorageBindings(
            { fleetId: "First", fleetUrl: "http://cells" },
            [
              {
                resource: "Cache",
                fleetId: "Second",
                fleetUrl: "http://cells",
              },
            ],
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        yield* validateStorageBindings(
          { fleetId: "First", fleetUrl: "http://cells" },
          [{ resource: "Cache", fleetId: "First", fleetUrl: "http://cells" }],
        );
      }),
  );
});
