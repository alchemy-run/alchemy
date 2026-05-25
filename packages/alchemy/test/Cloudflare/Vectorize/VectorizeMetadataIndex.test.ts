import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

type MetadataEntry = {
  indexType?: string | null;
  propertyName?: string | null;
};

const listMetadataIndexes = Effect.fn(function* (
  accountId: string,
  indexName: string,
) {
  return yield* vectorize
    .listIndexMetadataIndexes({ accountId, indexName })
    .pipe(
      Effect.map((res) => (res.metadataIndexes ?? []) as MetadataEntry[]),
      Effect.catchTag("CloudflareHttpError", (e) =>
        // Parent index gone — treat as "no metadata indexes".
        e.status === 404 || e.status === 410
          ? Effect.succeed([] as MetadataEntry[])
          : Effect.fail(e),
      ),
    );
});

const waitForMetadataIndex = Effect.fn(function* (
  accountId: string,
  indexName: string,
  predicate: (entries: MetadataEntry[]) => boolean,
) {
  return yield* listMetadataIndexes(accountId, indexName).pipe(
    Effect.filterOrFail(
      predicate,
      () => new Error("metadata indexes not in expected state"),
    ),
    Effect.retry({
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.both(Schedule.recurs(15)),
      ),
    }),
  );
});

test.provider("create and delete a metadata index", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { index, meta } = yield* stack.deploy(
      Effect.gen(function* () {
        const index = yield* Cloudflare.VectorizeIndex("ParentIdx", {
          dimensions: 3,
          metric: "cosine",
        });
        const meta = yield* Cloudflare.VectorizeMetadataIndex("MetaIdx", {
          indexName: index.indexName,
          propertyName: "category",
          indexType: "string",
        });
        return { index, meta };
      }),
    );

    expect(meta.propertyName).toBe("category");
    expect(meta.indexType).toBe("string");
    expect(meta.indexName).toBe(index.indexName);

    // The metadata index appears in the parent's list once Cloudflare
    // processes the async mutation.
    const entries = yield* waitForMetadataIndex(
      accountId,
      index.indexName,
      (entries) => entries.some((e) => e.propertyName === "category"),
    );
    expect(entries.find((e) => e.propertyName === "category")?.indexType).toBe(
      "string",
    );

    yield* stack.destroy();

    // Both parent and metadata index are gone.
    const after = yield* listMetadataIndexes(accountId, index.indexName);
    expect(after.length).toBe(0);
  }).pipe(logLevel),
);

test.provider("multiple metadata indexes on the same parent coexist", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const { index } = yield* stack.deploy(
      Effect.gen(function* () {
        const index = yield* Cloudflare.VectorizeIndex("MultiParent", {
          dimensions: 3,
          metric: "cosine",
        });
        yield* Cloudflare.VectorizeMetadataIndex("CategoryMeta", {
          indexName: index.indexName,
          propertyName: "category",
          indexType: "string",
        });
        yield* Cloudflare.VectorizeMetadataIndex("PriceMeta", {
          indexName: index.indexName,
          propertyName: "price",
          indexType: "number",
        });
        return { index };
      }),
    );

    const entries = yield* waitForMetadataIndex(
      accountId,
      index.indexName,
      (entries) =>
        entries.some((e) => e.propertyName === "category") &&
        entries.some((e) => e.propertyName === "price"),
    );
    expect(entries.find((e) => e.propertyName === "category")?.indexType).toBe(
      "string",
    );
    expect(entries.find((e) => e.propertyName === "price")?.indexType).toBe(
      "number",
    );

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "replacing the parent index also replaces the metadata index",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Initial deploy with dimensions=3.
      const { index: oldIndex } = yield* stack.deploy(
        Effect.gen(function* () {
          const index = yield* Cloudflare.VectorizeIndex("ReplaceParent", {
            dimensions: 3,
            metric: "cosine",
          });
          yield* Cloudflare.VectorizeMetadataIndex("ReplaceMeta", {
            indexName: index.indexName,
            propertyName: "tag",
            indexType: "string",
          });
          return { index };
        }),
      );
      yield* waitForMetadataIndex(accountId, oldIndex.indexName, (entries) =>
        entries.some((e) => e.propertyName === "tag"),
      );

      // Re-deploy with different dimensions — the parent replaces, which
      // also replaces the metadata index on the new parent.
      const { index: newIndex, meta: newMeta } = yield* stack.deploy(
        Effect.gen(function* () {
          const index = yield* Cloudflare.VectorizeIndex("ReplaceParent", {
            dimensions: 8,
            metric: "cosine",
          });
          const meta = yield* Cloudflare.VectorizeMetadataIndex("ReplaceMeta", {
            indexName: index.indexName,
            propertyName: "tag",
            indexType: "string",
          });
          return { index, meta };
        }),
      );

      expect(newIndex.indexName).not.toBe(oldIndex.indexName);
      expect(newMeta.indexName).toBe(newIndex.indexName);

      // Old parent is gone.
      const oldGone = yield* vectorize
        .getIndex({ accountId, indexName: oldIndex.indexName })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("CloudflareHttpError", (e) =>
            Effect.succeed(e.status === 404),
          ),
        );
      expect(oldGone).toBe(true);

      // The new parent has the metadata index.
      yield* waitForMetadataIndex(accountId, newIndex.indexName, (entries) =>
        entries.some((e) => e.propertyName === "tag"),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "destroy is idempotent when the parent index was deleted out-of-band",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;

      yield* stack.destroy();

      const { index } = yield* stack.deploy(
        Effect.gen(function* () {
          const index = yield* Cloudflare.VectorizeIndex("OobParent", {
            dimensions: 3,
            metric: "cosine",
          });
          yield* Cloudflare.VectorizeMetadataIndex("OobMeta", {
            indexName: index.indexName,
            propertyName: "ns",
            indexType: "string",
          });
          return { index };
        }),
      );
      yield* waitForMetadataIndex(accountId, index.indexName, (entries) =>
        entries.some((e) => e.propertyName === "ns"),
      );

      // Simulate Cloudflare's cascading delete: drop the parent directly.
      // On Cloudflare's side this also removes the metadata index.
      yield* vectorize.deleteIndex({
        accountId,
        indexName: index.indexName,
      });

      // The metadata index provider's delete tolerates 404/410 from the
      // missing parent, so `destroy` succeeds without erroring.
      yield* stack.destroy();
    }).pipe(logLevel),
);
